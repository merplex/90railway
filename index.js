require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg"); // เปลี่ยนจาก Supabase เป็น pg

const app = express();
app.use(cors(), express.json(), express.static("public"));

// 🔌 เชื่อมต่อฐานข้อมูลผ่าน DATABASE_URL เส้นเดียวจบ
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let adminWaitList = new Set(); 
let ratioWaitList = new Set(); 

/* ============================================================
   1. API SYSTEM & HELPERS (เปลี่ยนเป็น SQL Query)
============================================================ */
app.post("/create-qr", async (req, res) => {
    try {
        const { amount, machine_id } = req.body;
        // ดึงค่า Ratio จากตาราง system_configs
        const configRes = await pool.query('SELECT * FROM system_configs WHERE config_key = $1', ['exchange_ratio']);
        const config = configRes.rows[0];
        const baht_rate = config ? config.baht_val : 10;
        const point_rate = config ? config.point_val : 1;
        const point_get = Math.floor((amount / baht_rate) * point_rate); 
        const token = crypto.randomUUID();

        await pool.query(
            'INSERT INTO "qrPointToken" (qr_token, point_get, machine_id, scan_amount, is_used, create_at) VALUES ($1, $2, $3, $4, $5, NOW())',
            [token, point_get, machine_id, amount, false]
        );

        const liffUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;
        res.json({ success: true, qr_url: liffUrl, points: point_get, token: token });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const resDb = await pool.query(`
            SELECT w.point_balance FROM "memberWallet" w 
            JOIN "ninetyMember" m ON w.member_id = m.id 
            WHERE m.line_user_id = $1`, [userId]);
        res.json({ points: resDb.rows[0]?.point_balance || 0 });
    } catch (e) { res.status(500).json({ points: 0 }); }
});

app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const qrRes = await pool.query('SELECT * FROM "qrPointToken" WHERE qr_token = $1', [token]);
    const qrData = qrRes.rows[0];

    if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");

    // อัปเดตตาราง QR
    await pool.query('UPDATE "qrPointToken" SET is_used = true, used_by = $1, used_at = NOW() WHERE qr_token = $2', [userId, token]);

    // เช็ก/สร้างสมาชิก
    let memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [userId]);
    let memberId;
    if (memRes.rows.length === 0) {
        const newMem = await pool.query('INSERT INTO "ninetyMember" (line_user_id) VALUES ($1) RETURNING id', [userId]);
        memberId = newMem.rows[0].id;
    } else {
        memberId = memRes.rows[0].id;
    }

    // อัปเดตแต้ม (Upsert)
    await pool.query(`
        INSERT INTO "memberWallet" (member_id, point_balance) VALUES ($1, $2)
        ON CONFLICT (member_id) DO UPDATE SET point_balance = "memberWallet".point_balance + $2
        RETURNING point_balance`, [memberId, qrData.point_get]);

    const newBalanceRes = await pool.query('SELECT point_balance FROM "memberWallet" WHERE member_id = $1', [memberId]);
    await sendReplyPush(userId, `✨ สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newBalanceRes.rows[0].point_balance})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});
// --- ฝั่งหักแต้ม (Redeem) สำหรับ PostgreSQL ---
app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    
    // ดึง ID สมาชิกจาก LINE User ID
    const memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [userId]);
    const member = memRes.rows[0];
    if (!member) return res.status(400).send("ไม่พบข้อมูลสมาชิก");

    // เช็กแต้มใน Wallet
    const wallRes = await pool.query('SELECT point_balance FROM "memberWallet" WHERE member_id = $1', [member.id]);
    const wallet = wallRes.rows[0];

    if (!wallet || wallet.point_balance < amount) return res.status(400).send("แต้มไม่พอ");

    // หักแต้ม
    const newBalance = wallet.point_balance - amount;
    await pool.query('UPDATE "memberWallet" SET point_balance = $1 WHERE member_id = $2', [newBalance, member.id]);

    // บันทึก Log การแลก (ต้องมีตาราง redeemlogs นะคะ)
    await pool.query(
        'INSERT INTO "redeemlogs" (member_id, machine_id, points_redeemed, status, created_at) VALUES ($1, $2, $3, $4, NOW())',
        [member.id, machine_id, parseInt(amount), "pending"]
    );

    await sendReplyPush(userId, `✅ แลกสำเร็จ! -${amount} แต้ม (เหลือ: ${newBalance})`);
    res.send(`SUCCESS: MACHINE_${machine_id}_START`);
  } catch (err) { 
    console.error(err);
    res.status(500).send("System Error: " + err.message); 
  }
});

/* ============================================================
   2. WEBHOOK & ADMIN SYSTEM
============================================================ */
app.post("/webhook", async (req, res) => {
  const events = req.body.events;
  if (!events) return res.sendStatus(200);

  for (let event of events) {
    const userId = event.source.userId;
    const isUserAdmin = await isAdmin(userId);
    if (event.type !== "message" || event.message.type !== "text") continue;
    const rawMsg = event.message.text.trim();
    const userMsg = rawMsg.toUpperCase();

    try {
      if (userMsg === "USER_LINE") return await sendReply(event.replyToken, `ID: ${userId}`);
      if (isUserAdmin) {
        if (ratioWaitList.has(userId)) { ratioWaitList.delete(userId); return await updateExchangeRatio(rawMsg, event.replyToken); }
        if (adminWaitList.has(userId)) { adminWaitList.delete(userId); return await addNewAdmin(rawMsg, event.replyToken); }
        if (userMsg === "ADMIN") return await sendAdminDashboard(event.replyToken);
        if (userMsg === "REPORT") return await sendReportMenu(event.replyToken);
        if (userMsg === "SUB_PENDING") return await listSubReport(event.replyToken, "PENDING");
        if (userMsg === "SUB_EARNS") return await listSubReport(event.replyToken, "EARNS");
        if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
        if (userMsg === "SET_RATIO_STEP1") { ratioWaitList.add(userId); return await sendReply(event.replyToken, "📊 ระบุ บาท:แต้ม (เช่น 10:1)"); }
        if (userMsg === "ADD_ADMIN_STEP1") { adminWaitList.add(userId); return await sendReply(event.replyToken, "🆔 ส่ง ID เว้นวรรคตามด้วยชื่อ"); }
        if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("GET_HISTORY ")) return await sendUserHistory(rawMsg.split(" ")[1], event.replyToken);
      }

      // ระบบขอแต้ม
      const pointMatch = rawMsg.match(/^(\d+)\s*(แต้ม|คะแนน|p|point|pts)?$/i);
      if (pointMatch) {
          const points = parseInt(pointMatch[1]);
          await pool.query('INSERT INTO point_requests (line_user_id, points, request_at) VALUES ($1, $2, NOW())', [userId, points]);
          return await sendReply(event.replyToken, `📝 ส่งคำขอ ${points} แต้ม ให้แอดมินแล้วค่ะ`);
      }

      if (userMsg === "CHECK_POINT") {
          const resDb = await pool.query(`
            SELECT w.point_balance FROM "memberWallet" w 
            JOIN "ninetyMember" m ON w.member_id = m.id 
            WHERE m.line_user_id = $1`, [userId]);
          await sendReply(event.replyToken, `🌟 ยอดแต้มของคุณ: ${resDb.rows[0]?.point_balance || 0} แต้ม`);
      }
    } catch (e) { console.error("Webhook Error:", e); }
  }
  res.sendStatus(200);
});

/* ============================================================
   3. FUNCTIONS (SQL VERSION)
============================================================ */
async function isAdmin(uid) { 
    const res = await pool.query('SELECT line_user_id FROM bot_admins WHERE line_user_id = $1', [uid]);
    return res.rows.length > 0; 
}

async function updateExchangeRatio(input, rt) {
    const parts = input.split(":");
    if (parts.length !== 2) return await sendReply(rt, "❌ รูปแบบผิด! เช่น 10:1");
    await pool.query(`
        INSERT INTO system_configs (config_key, baht_val, point_val, updated_at) 
        VALUES ('exchange_ratio', $1, $2, NOW())
        ON CONFLICT (config_key) DO UPDATE SET baht_val = $1, point_val = $2, updated_at = NOW()`,
        [parseInt(parts[0]), parseInt(parts[1])]);
    await sendReply(rt, `✅ ตั้งค่าสำเร็จ! ${parts[0]} บาท : ${parts[1]} แต้ม`);
}

async function addNewAdmin(input, rt) {
    const [tid, name] = input.split(/\s+/);
    await pool.query('INSERT INTO bot_admins (line_user_id, admin_name) VALUES ($1, $2) ON CONFLICT (line_user_id) DO NOTHING', [tid, name || "Admin"]);
    await sendReply(rt, `✅ เพิ่มแอดมินสำเร็จ!`);
}

async function approveSpecificPoint(rid, rt) {
    const reqRes = await pool.query('SELECT * FROM point_requests WHERE id = $1', [rid]);
    const req = reqRes.rows[0];
    if (!req) return;

    let memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [req.line_user_id]);
    let memberId = memRes.rows[0]?.id;
    if (!memberId) {
        const newM = await pool.query('INSERT INTO "ninetyMember" (line_user_id) VALUES ($1) RETURNING id', [req.line_user_id]);
        memberId = newM.rows[0].id;
    }

    await pool.query(`
        INSERT INTO "memberWallet" (member_id, point_balance) VALUES ($1, $2)
        ON CONFLICT (member_id) DO UPDATE SET point_balance = "memberWallet".point_balance + $2`,
        [memberId, req.points]);

    await pool.query('INSERT INTO "qrPointToken" (qr_token, point_get, machine_id, is_used, used_by, used_at, create_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())',
        [`MANUAL-${crypto.randomUUID()}`, req.points, 'ADMIN', true, req.line_user_id]);

    await pool.query('DELETE FROM point_requests WHERE id = $1', [rid]);
    await sendReply(rt, `✅ อนุมัติสำเร็จ!`);
    await sendReplyPush(req.line_user_id, `🎊 แอดมินอนุมัติ ${req.points} แต้มแล้วค่ะ`);
}

// ✨ ระบบ Report (SQL Version)
async function listSubReport(replyToken, type) {
    try {
        let title = "", color = "", rows = [];
        if (type === "PENDING") {
            title = "🔔 Pending (15)"; color = "#ff4b4b";
            const res = await pool.query('SELECT * FROM point_requests ORDER BY request_at DESC LIMIT 15');
            rows = res.rows.map(r => ({
                type: "box", layout: "horizontal", margin: "md", contents: [
                    { type: "text", text: r.line_user_id.substring(0,8), size: "xs", flex: 4 },
                    { type: "text", text: `+${r.points}p`, size: "sm", flex: 3, color: "#00b900", weight: "bold" },
                    { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 3, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }
                ]
            }));
        } else if (type === "EARNS") {
            title = "📥 Recent Earns (15)"; color = "#00b900";
            const res = await pool.query('SELECT * FROM "qrPointToken" WHERE is_used = true ORDER BY used_at DESC LIMIT 15');
            rows = res.rows.map(e => createRow(e.machine_id, e.used_by.substring(0,8), `+${e.point_get}p`, e.used_at, "#00b900"));
        }
        
        if (rows.length === 0) return await sendReply(replyToken, "ℹ️ ไม่มีรายการ");
        await sendFlex(replyToken, title, { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: color, contents: [{ type: "text", text: title, color: "#ffffff", weight: "bold" }] }, body: { type: "box", layout: "vertical", spacing: "xs", contents: rows } });
    } catch (e) { console.error(e); }
}

// (ฟังก์ชันอื่น ๆ เช่น sendReply, sendFlex คงเดิมตาม Logic ของ Boss ค่ะ)
async function sendReply(rt, text) { 
    try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); }
}
async function sendReplyPush(to, text) { 
    try { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); }
}
async function sendFlex(rt, alt, contents) { 
    try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText: alt, contents }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); }
}

const createRow = (machine, uid, pts, time, color) => ({
    type: "box", layout: "horizontal", margin: "xs", contents: [
        { type: "text", text: `[${machine || "?"}]`, size: "xxs", flex: 3, color: "#888888" },
        { type: "text", text: uid, size: "xxs", flex: 6, weight: "bold", color: "#4267B2" },
        { type: "text", text: pts, size: "xxs", flex: 3, color: color, align: "end", weight: "bold" },
        { type: "text", text: new Date(time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }), size: "xxs", flex: 2, align: "end", color: "#aaaaaa" }
    ]
});

async function sendAdminDashboard(rt) {
  const flex = { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "90 WASH ADMIN", color: "#00b900", weight: "bold", size: "xl" }] }, body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } }, { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "💰 SET EXCHANGE RATIO", text: "SET_RATIO_STEP1" } }] } };
  await sendFlex(rt, "Admin Dashboard", flex);
}

async function sendReportMenu(rt) {
  const flex = { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#ff4b4b", action: { type: "message", label: "🔔 Pending Requests", text: "SUB_PENDING" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📥 Recent Earns", text: "SUB_EARNS" } }] } };
  await sendFlex(rt, "Report Menu", flex);
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
