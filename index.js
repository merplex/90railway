// เพิ่มบรรทัดนี้เพื่อเช็กค่าใน Logs ตามที่ Boss ขอครับ
console.log("🔍 Checking DB URL:", process.env.DATABASE_URL ? "OK (Found)" : "NOT FOUND (Empty)");

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
// เปิดให้ Server อ่านไฟล์ในโฟลเดอร์ public (ต้องมี index.html ในนั้น)
app.use(cors(), express.json(), express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let adminWaitList = new Set(); 
let ratioWaitList = new Set(); 

/* ============================================================
   1. API SYSTEM (สร้าง QR, เช็กแต้ม, ตัดแต้ม)
============================================================ */

// สร้าง QR Code สำหรับแจกแต้ม (Earn)
app.post("/create-qr", async (req, res) => {
    try {
        const { amount, machine_id } = req.body;
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

// API ให้หน้า index.html ดึงแต้มไปโชว์
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

// ลิงก์รับแต้ม (Scan QR)
app.get("/liff/consume", async (req, res) => {
  try {
    const { token, userId } = req.query;
    const qrRes = await pool.query('SELECT * FROM "qrPointToken" WHERE qr_token = $1', [token]);
    const qrData = qrRes.rows[0];

    if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");

    await pool.query('UPDATE "qrPointToken" SET is_used = true, used_by = $1, used_at = NOW() WHERE qr_token = $2', [userId, token]);

    let memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [userId]);
    let memberId;
    if (memRes.rows.length === 0) {
        const newMem = await pool.query('INSERT INTO "ninetyMember" (line_user_id) VALUES ($1) RETURNING id', [userId]);
        memberId = newMem.rows[0].id;
    } else {
        memberId = memRes.rows[0].id;
    }

    await pool.query(`
        INSERT INTO "memberWallet" (member_id, point_balance) VALUES ($1, $2)
        ON CONFLICT (member_id) DO UPDATE SET point_balance = "memberWallet".point_balance + $2
        RETURNING point_balance`, [memberId, qrData.point_get]);

    const newBalanceRes = await pool.query('SELECT point_balance FROM "memberWallet" WHERE member_id = $1', [memberId]);
    await sendReplyPush(userId, `✨ สะสมสำเร็จ! +${qrData.point_get} แต้ม (รวม: ${newBalanceRes.rows[0].point_balance})`);
    res.send("SUCCESS");
  } catch (err) { res.status(500).send(err.message); }
});

// ลิงก์หักแต้ม (Redeem)
app.get("/liff/redeem-execute", async (req, res) => {
  try {
    let { userId, amount, machine_id } = req.query;
    
    const memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [userId]);
    const member = memRes.rows[0];
    if (!member) return res.status(400).send("ไม่พบข้อมูลสมาชิก");

    const wallRes = await pool.query('SELECT point_balance FROM "memberWallet" WHERE member_id = $1', [member.id]);
    const wallet = wallRes.rows[0];

    if (!wallet || wallet.point_balance < amount) return res.status(400).send("แต้มไม่พอ");

    const newBalance = wallet.point_balance - amount;
    await pool.query('UPDATE "memberWallet" SET point_balance = $1 WHERE member_id = $2', [newBalance, member.id]);

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
        
        // เมนู Admin
        if (userMsg === "ADMIN") return await sendAdminDashboard(event.replyToken);
        if (userMsg === "REPORT") return await sendReportMenu(event.replyToken);
        
        // เมนู Report ย่อย
        if (userMsg === "SUB_PENDING") return await listSubReport(event.replyToken, "PENDING");
        if (userMsg === "SUB_EARNS") return await listSubReport(event.replyToken, "EARNS");
        if (userMsg === "SUB_REDEEMS") return await listSubReport(event.replyToken, "REDEEMS");
        
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
          const pendingCheck = await pool.query(
              `SELECT request_at FROM point_requests WHERE line_user_id = $1 AND request_at > NOW() - INTERVAL '24 hours'`, 
              [userId]
          );

          if (pendingCheck.rows.length > 0) {
              const lastTime = new Date(pendingCheck.rows[0].request_at).toLocaleTimeString('th-TH', {hour: '2-digit', minute:'2-digit'});
              return await sendReply(event.replyToken, `⏳ คุณมีรายการขอแต้มค้างอยู่ (ตั้งแต่ ${lastTime})\nเจ้าหน้าที่กำลังตรวจสอบ รอก่อนนะคะ 🥺`);
          }

          await pool.query('INSERT INTO point_requests (line_user_id, points, request_at) VALUES ($1, $2, NOW())', [userId, points]);
          return await sendReply(event.replyToken, `📝 ส่งคำขอ ${points} แต้ม เรียบร้อยค่ะ`);
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
   3. FUNCTIONS & HELPERS
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

// ✨ REPORT SYSTEM (สวยงาม + ตัวเล็ก + บรรทัดชิด)
// ⚠️ สำคัญ: createRow ต้องอยู่ "ก่อน" listSubReport เพื่อไม่ให้ Error
const createRow = (machine, uid, pts, time, color, fullUid) => ({
    type: "box", 
    layout: "horizontal", 
    margin: "none",       // 🟢 ลดช่องว่างระหว่างบรรทัดให้ชิดสุด
    spacing: "xs",        
    alignItems: "center",
    contents: [
        { type: "text", text: `[${machine || "?"}]`, size: "xxs", flex: 2, color: "#aaaaaa" },
        { 
            type: "text", 
            text: uid, 
            size: "xxs",      // 🟢 บังคับตัวเล็กเท่าเพื่อน
            flex: 4, 
            color: "#4267B2", 
            decoration: "underline", // ขีดเส้นใต้ให้รู้ว่ากดได้
            action: { type: "message", label: uid, text: `GET_HISTORY ${fullUid}` } // ส่ง ID เต็มไปดูประวัติ
        },
        { type: "text", text: pts, size: "xxs", flex: 2, color: color, align: "end", weight: "bold" },
        { type: "text", text: new Date(time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }), size: "xxs", flex: 2, align: "end", color: "#cccccc" }
    ]
});

async function listSubReport(replyToken, type) {
    try {
        let title = "", color = "", rows = [];
        
        if (type === "PENDING") {
            title = "🔔 Pending (15)"; color = "#ff4b4b";
            const res = await pool.query('SELECT * FROM point_requests ORDER BY request_at DESC LIMIT 15');
            rows = res.rows.map(r => ({
                type: "box", layout: "horizontal", margin: "xs", alignItems: "center", contents: [
                    { 
                        type: "text", text: r.line_user_id.substring(0,6), size: "xxs", flex: 3, color: "#4267B2", decoration: "underline",
                        action: { type: "message", label: r.line_user_id, text: `GET_HISTORY ${r.line_user_id}` }
                    },
                    { type: "text", text: `+${r.points}p`, size: "xxs", flex: 2, color: "#00b900", weight: "bold" },
                    { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "อนุมัติ", text: `APPROVE_ID ${r.id}` }, flex: 3 }
                ]
            }));

        } else if (type === "EARNS") {
            title = "📥 Recent Earns"; color = "#00b900";
            const res = await pool.query('SELECT * FROM "qrPointToken" WHERE is_used = true ORDER BY used_at DESC LIMIT 15');
            // ส่ง e.used_by เป็นตัวแปรสุดท้าย (Full ID)
            rows = res.rows.map(e => createRow(e.machine_id, e.used_by.substring(0,8), `+${e.point_get}p`, e.used_at, "#00b900", e.used_by));

        } else if (type === "REDEEMS") {
            title = "📤 Recent Redeems"; color = "#ff9f00";
            const res = await pool.query(`SELECT r.*, m.line_user_id FROM "redeemlogs" r JOIN "ninetyMember" m ON r.member_id = m.id ORDER BY r.created_at DESC LIMIT 15`);
            // ส่ง r.line_user_id เป็นตัวแปรสุดท้าย (Full ID)
            rows = res.rows.map(r => createRow(r.machine_id, r.line_user_id.substring(0,8), `-${r.points_redeemed}p`, r.created_at, "#ff4b4b", r.line_user_id));
        }
        
        if (rows.length === 0) return await sendReply(replyToken, "ℹ️ ไม่มีรายการ");
        
        await sendFlex(replyToken, title, { 
            type: "bubble", 
            header: { type: "box", layout: "vertical", backgroundColor: color, contents: [{ type: "text", text: title, color: "#ffffff", weight: "bold" }] }, 
            body: { 
                type: "box", 
                layout: "vertical", 
                spacing: "none", // 🟢 กำจัดช่องว่างระหว่างบรรทัดให้หมด
                contents: rows 
            } 
        });
    } catch (e) { console.error(e); await sendReply(replyToken, "❌ Error: " + e.message); }
}

async function sendReply(rt, text) { 
    try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); }
}
async function sendReplyPush(to, text) { 
    try { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); }
}
async function sendFlex(rt, alt, contents) { 
    try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText: alt, contents }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); }
}

async function sendAdminDashboard(rt) {
  const flex = { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "90 WASH ADMIN", color: "#00b900", weight: "bold", size: "xl" }] }, body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } }, { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "💰 SET EXCHANGE RATIO", text: "SET_RATIO_STEP1" } }] } };
  await sendFlex(rt, "Admin Dashboard", flex);
}

async function sendReportMenu(rt) {
  const flex = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "button", style: "primary", color: "#ff4b4b", action: { type: "message", label: "🔔 Pending Requests", text: "SUB_PENDING" } },
        { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📥 Recent Earns", text: "SUB_EARNS" } },
        { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "📤 Recent Redeems", text: "SUB_REDEEMS" } }
      ]
    }
  };
  await sendFlex(rt, "Report Menu", flex);
}

async function deleteAdmin(tid, rt) {
  await pool.query('DELETE FROM bot_admins WHERE line_user_id = $1', [tid]);
  await sendReply(rt, "🗑️ ลบแอดมินเรียบร้อยแล้วค่ะ");
}

async function listAdminsWithDelete(rt) {
  const res = await pool.query('SELECT * FROM bot_admins');
  const adms = res.rows;
  const adminRows = (adms || []).map(a => ({ 
      type: "box", layout: "horizontal", margin: "md", alignItems: "center",
      contents: [
          { type: "text", text: `👤 ${a.admin_name}`, size: "sm", flex: 5, gravity: "center" }, 
          { type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, action: { type: "message", label: "DEL", text: `DEL_ADMIN_ID ${a.line_user_id}` } }
      ] 
  }));
  await sendFlex(rt, "Admin List", { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold", size: "lg", margin: "md" }, ...adminRows] } });
}

async function sendUserHistory(targetUid, rt) {
    try {
        const earnsRes = await pool.query('SELECT * FROM "qrPointToken" WHERE used_by = $1 AND is_used = true ORDER BY used_at DESC LIMIT 15', [targetUid]);
        const memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [targetUid]);
        
        let redeems = [];
        if (memRes.rows[0]) {
            const rdm = await pool.query('SELECT * FROM "redeemlogs" WHERE member_id = $1 ORDER BY created_at DESC LIMIT 15', [memRes.rows[0].id]);
            redeems = rdm.rows;
        }

        let allTx = [
            ...(earnsRes.rows || []).map(e => ({ label: `EARN[${e.machine_id || '-'}]`, pts: `+${e.point_get}`, time: e.used_at || e.create_at, color: "#00b900" })),
            ...(redeems || []).map(u => ({ label: `REDEEM[${u.machine_id || '-'}]`, pts: `-${u.points_redeemed}`, time: u.created_at, color: "#ff4b4b" }))
        ];

        allTx.sort((a, b) => new Date(b.time) - new Date(a.time));
        const finalHistory = allTx.slice(0, 15);

        const flex = {
            type: "bubble",
            header: { type: "box", layout: "vertical", backgroundColor: "#333333", contents: [{ type: "text", text: `📜 HISTORY: ${targetUid.substring(0,8)}...`, color: "#ffffff", weight: "bold", size: "xs" }] },
            body: { type: "box", layout: "vertical", spacing: "sm", contents: finalHistory.map(tx => ({
                type: "box", layout: "horizontal", contents: [
                    { type: "text", text: tx.label, size: "xxs", flex: 6, color: "#555555", weight: "bold" },
                    { type: "text", text: tx.pts+' ', size: "xs", flex: 4, weight: "bold", color: tx.color, align: "end" },
                    { type: "text", text: new Date(tx.time).toLocaleDateString('th-TH') , size: "xxs", flex: 3, align: "end", color: "#aaaaaa" }
                ]
            })) }
        };
        await sendFlex(rt, "User History", flex);
    } catch (e) { console.error(e); await sendReply(rt, "❌ ไม่สามารถดึงประวัติได้ค่ะ"); }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
