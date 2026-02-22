// index.js (God Mode Full Version: Create-QR + Pending/Refund + Cute Icons)
console.log("🔍 Checking DB URL:", process.env.DATABASE_URL ? "OK (Found)" : "NOT FOUND (Empty)");

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(cors(), express.json(), express.static("public"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let adminWaitList = new Set(); 
let ratioWaitList = new Set(); 

/* ============================================================
   🎨 HELPER - สร้างแถวรายงาน
============================================================ */
const createRow = (machine, uid, pts, time, color, fullUid) => ({
    type: "box", layout: "horizontal", margin: "none", spacing: "xs", alignItems: "center",
    contents: [
        { type: "text", text: `[${machine || "?"}]`, size: "xxs", flex: 3, color: "#888888" },
        { type: "text", text: uid.substring(0,8), size: "xxs", flex: 3, color: "#4267B2", decoration: "underline", action: { type: "message", label: uid, text: `GET_HISTORY ${fullUid}` } },
        { type: "text", text: pts + '   ', size: "xxs", flex: 2, color: color, align: "end", weight: "bold" },
        { type: "text", text: new Date(time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }), size: "xxs", flex: 2, align: "end", color: "#cccccc" }
    ]
});

/* ============================================================
   1. API SYSTEM (LIFF & MACHINE & CURL)
============================================================ */

// 🟢 1.0 สร้าง QR สำหรับรับแต้ม (ที่ Boss ใช้ CURL ยิงหา) - คืนชีพแล้วค่ะ! ✨
// 🟢 1.0.1 API สำหรับให้ ESP32 ยิงมาขอ QR Code โดยเฉพาะ
app.post("/api/generate-point-token", async (req, res) => {
    try {
        const { amount, machine_id } = req.body;
        
        // 1. ดึง Config การคำนวณแต้ม
        const configRes = await pool.query('SELECT * FROM system_configs WHERE config_key = $1', ['exchange_ratio']);
        const config = configRes.rows[0];
        const baht_rate = config ? config.baht_val : 10;
        const point_rate = config ? config.point_val : 1;
        const point_get = Math.floor((amount / baht_rate) * point_rate); 

        // 2. สร้าง Token
        const token = crypto.randomUUID();

        // 3. บันทึกลงตาราง qrPointToken (โครงสร้างเดียวกับ 1.0 เลย)
        await pool.query(
            'INSERT INTO "qrPointToken" (qr_token, point_get, machine_id, scan_amount, is_used, create_at) VALUES ($1, $2, $3, $4, $5, NOW())',
            [token, point_get, machine_id, amount, false]
        );

        // 4. สร้าง URL ให้ ESP32 ไปแปลงเป็นรูป QR (อย่าลืมตั้งค่า RAILWAY_STATIC_URL ในเว็บ Railway นะคะ)
        // ✅ เปลี่ยนมาใช้เป็นลิงก์ LIFF เหมือนระบบเดิม:
        const qrUrl = `https://liff.line.me/${process.env.LIFF_ID}?token=${token}`;
        
        console.log(`[ESP32] Created Token: ${token} | Machine: ${machine_id} | Points: ${point_get}`);
        res.status(200).json({ status: 'success', url: qrUrl });
        
    } catch (e) {
        console.error("[ESP32] Generate QR Error:", e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

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
    } catch (e) { 
        console.error("Create QR Error:", e);
        res.status(500).json({ success: false, error: e.message }); 
    }
});

// 🟢 1.1 รับแต้ม (Earn) - ผ่านหน้า LIFF
app.get("/liff/consume", async (req, res) => {
    try {
        const { token, userId } = req.query;
        const qrRes = await pool.query('SELECT * FROM "qrPointToken" WHERE qr_token = $1', [token]);
        const qrData = qrRes.rows[0];
        if (!qrData || qrData.is_used) return res.status(400).send("QR Invalid");

        await pool.query('UPDATE "qrPointToken" SET is_used = true, used_by = $1, used_at = NOW() WHERE qr_token = $2', [userId, token]);

        let memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [userId]);
        let memberId = memRes.rows.length === 0 ? (await pool.query('INSERT INTO "ninetyMember" (line_user_id) VALUES ($1) RETURNING id', [userId])).rows[0].id : memRes.rows[0].id;

        await pool.query(`
            INSERT INTO "memberWallet" (member_id, point_balance) VALUES ($1, $2)
            ON CONFLICT (member_id) DO UPDATE SET point_balance = "memberWallet".point_balance + $2`, [memberId, qrData.point_get]);

        const newBal = await pool.query('SELECT point_balance FROM "memberWallet" WHERE member_id = $1', [memberId]);
        await sendReplyPush(userId, `✨ สะสมสำเร็จแล้วค่ะ! +${qrData.point_get} แต้ม 🧼 (รวม: ${newBal.rows[0].point_balance} แต้ม) 🫧🧸`);
        res.send("SUCCESS");
    } catch (err) { res.status(500).send(err.message); }
});

// 🟢 1.2 กดแลกแต้ม (Redeem) - จองคิว PENDING (ยังไม่หักจริง)
app.get("/liff/redeem-execute", async (req, res) => {
    try {
        let { userId, amount, machine_id } = req.query;
        const pts = parseInt(amount);

        const memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [userId]);
        const member = memRes.rows[0];
        if (!member) return res.status(400).send("ไม่พบสมาชิก");

        const wallRes = await pool.query('SELECT point_balance FROM "memberWallet" WHERE member_id = $1', [member.id]);
        if (!wallRes.rows[0] || wallRes.rows[0].point_balance < pts) return res.status(400).send("แต้มไม่พอ");

        const logRes = await pool.query(
            'INSERT INTO "redeemlogs" (member_id, machine_id, points_redeemed, status, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
            [member.id, machine_id, pts, "pending"]
        );
        const logId = logRes.rows[0].id;

        // Timeout 1 นาที ถ้าเครื่องไม่ตอบสนอง
        setTimeout(async () => {
            const checkLog = await pool.query('SELECT status FROM "redeemlogs" WHERE id = $1', [logId]);
            if (checkLog.rows[0].status === 'pending') {
                await pool.query('UPDATE "redeemlogs" SET status = $1 WHERE id = $2', ['refunded', logId]);
                await sendReplyPush(userId, `❌ เครื่อง ${machine_id} ไม่ตอบสนอง ระบบคืนแต้มให้แล้วค่ะ 🧸🫧`);
            }
        }, 60000); 

        res.send(`WAITING_FOR_MACHINE:${logId}`);
    } catch (err) { res.status(500).send(err.message); }
});

// 🟢 1.3 ดึงแต้มไปโชว์ที่หน้า LIFF
app.get("/api/get-user-points", async (req, res) => {
    const { userId } = req.query;
    try {
        const resDb = await pool.query(`
            SELECT w.point_balance FROM "memberWallet" w 
            JOIN "ninetyMember" m ON w.member_id = m.id 
            WHERE m.line_user_id = $1`, [userId]);
        const balance = resDb.rows[0]?.point_balance ?? 0;
        res.json({ points: balance }); 
    } catch (e) { res.json({ points: 0 }); }
});

// 🟢 1.4 เครื่อง HMI ยิงมายืนยัน (หักแต้มจริง)
app.post("/machine/confirm", async (req, res) => {
    const { log_id } = req.body;
    try {
        const logRes = await pool.query(`
            SELECT r.*, m.line_user_id FROM "redeemlogs" r 
            JOIN "ninetyMember" m ON r.member_id = m.id 
            WHERE r.id = $1 AND r.status = 'pending'`, [log_id]);
        
        const logData = logRes.rows[0];
        if (!logData) return res.status(400).json({ success: false });

        await pool.query('UPDATE "redeemlogs" SET status = $1 WHERE id = $2', ['success', log_id]);
        await pool.query('UPDATE "memberWallet" SET point_balance = point_balance - $1 WHERE member_id = $2', [logData.points_redeemed, logData.member_id]);

        const newBal = await pool.query('SELECT point_balance FROM "memberWallet" WHERE member_id = $1', [logData.member_id]);
        await sendReplyPush(logData.line_user_id, `✅ เครื่อง ${logData.machine_id} เริ่มทำงานแล้ว! 🧼 หัก ${logData.points_redeemed} แต้ม (คงเหลือ: ${newBal.rows[0].point_balance}) 🧸✨🫧`);
        
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
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
        if (userMsg === "SUB_REDEEMS") return await listSubReport(event.replyToken, "REDEEMS");
        if (userMsg === "LIST_ADMIN") return await listAdminsWithDelete(event.replyToken);
        if (userMsg === "SET_RATIO_STEP1") { ratioWaitList.add(userId); return await sendReply(event.replyToken, "📊 ระบุ บาท:แต้ม (เช่น 10:1)"); }
        if (userMsg === "ADD_ADMIN_STEP1") { adminWaitList.add(userId); return await sendReply(event.replyToken, "🆔 ส่ง ID เว้นวรรคตามด้วยชื่อ"); }
        if (userMsg.startsWith("DEL_ADMIN_ID ")) return await deleteAdmin(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("APPROVE_ID ")) return await approveSpecificPoint(rawMsg.split(" ")[1], event.replyToken);
        if (userMsg.startsWith("GET_HISTORY ")) return await sendUserHistory(rawMsg.split(" ")[1], event.replyToken);
      }
      if (userMsg === "CHECK_POINT") {
          const resDb = await pool.query(`SELECT w.point_balance FROM "memberWallet" w JOIN "ninetyMember" m ON w.member_id = m.id WHERE m.line_user_id = $1`, [userId]);
          await sendReply(event.replyToken, `🌟 ยอดแต้มของคุณคือ ${resDb.rows[0]?.point_balance || 0} แต้มค่ะ 🧸✨🧼`);
      }
    } catch (e) { console.error("Webhook Error:", e); }
  }
  res.sendStatus(200);
});

/* ============================================================
   3. FUNCTIONS & HELPERS
============================================================ */
async function isAdmin(uid) { const res = await pool.query('SELECT line_user_id FROM bot_admins WHERE line_user_id = $1', [uid]); return res.rows.length > 0; }

async function sendUserHistory(targetUid, rt) {
    try {
        const earns = await pool.query('SELECT * FROM "qrPointToken" WHERE used_by = $1 AND is_used = true ORDER BY used_at DESC LIMIT 15', [targetUid]);
        const memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [targetUid]);
        let redeems = [];
        if (memRes.rows[0]) {
            const rdm = await pool.query(`SELECT * FROM "redeemlogs" WHERE member_id = $1 AND status IN ('success', 'refunded') ORDER BY created_at DESC LIMIT 15`, [memRes.rows[0].id]);
            redeems = rdm.rows;
        }
        let allTx = [
            ...(earns.rows || []).map(e => ({ label: `EARN[${e.machine_id || '-'}]`, pts: `+${e.point_get}`, time: e.used_at, color: "#00b900" })),
            ...(redeems || []).map(u => ({ 
                label: u.status === 'success' ? `REDEEM[${u.machine_id}]` : `REFUND[${u.machine_id}]`, 
                pts: u.status === 'success' ? `-${u.points_redeemed}` : `0`, 
                time: u.created_at, 
                color: u.status === 'success' ? "#ff4b4b" : "#888888" 
            }))
        ];
        allTx.sort((a, b) => new Date(b.time) - new Date(a.time));
        const finalHistory = allTx.slice(0, 15);
        const flex = { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#333333", contents: [{ type: "text", text: `📜 HISTORY: ${targetUid.substring(0,8)}...`, color: "#ffffff", weight: "bold", size: "xs" }] }, body: { type: "box", layout: "vertical", spacing: "sm", contents: finalHistory.map(tx => ({ type: "box", layout: "horizontal", contents: [{ type: "text", text: tx.label, size: "xxs", flex: 5, color: "#555555", weight: "bold" }, { type: "text", text: tx.pts, size: "xs", flex: 4, weight: "bold", color: tx.color, align: "end" }, { type: "text", text: new Date(tx.time).toLocaleDateString('th-TH'), size: "xxs", flex: 3, align: "end", color: "#aaaaaa" }] })) } };
        await sendFlex(rt, "User History", flex);
    } catch (e) { console.error(e); }
}

async function listSubReport(replyToken, type) {
    try {
        let title = "", color = "", rows = [];
        if (type === "PENDING") {
            title = "🔔 Pending (15)"; color = "#ff4b4b";
            const res = await pool.query('SELECT * FROM point_requests ORDER BY request_at DESC LIMIT 15');
            rows = res.rows.map(r => ({ type: "box", layout: "horizontal", margin: "xs", alignItems: "center", contents: [{ type: "text", text: r.line_user_id.substring(0,6), size: "xxs", flex: 3, color: "#4267B2", action: { type: "message", label: r.line_user_id, text: `GET_HISTORY ${r.line_user_id}` } }, { type: "text", text: `+${r.points}p`, size: "xxs", flex: 2, color: "#00b900", weight: "bold" }, { type: "button", style: "secondary", height: "sm", action: { type: "message", label: "อนุมัติ", text: `APPROVE_ID ${r.id}` }, flex: 3 }] }));
        } else if (type === "EARNS") {
            title = "📥 Recent Earns"; color = "#00b900";
            const res = await pool.query('SELECT * FROM "qrPointToken" WHERE is_used = true ORDER BY used_at DESC LIMIT 15');
            rows = res.rows.map(e => createRow(e.machine_id, e.used_by.substring(0,8), `+${e.point_get}p`, e.used_at, "#00b900", e.used_by));
        } else if (type === "REDEEMS") {
            title = "📤 Recent Redeems"; color = "#ff9f00";
            const res = await pool.query(`SELECT r.*, m.line_user_id FROM "redeemlogs" r JOIN "ninetyMember" m ON r.member_id = m.id WHERE r.status = 'success' ORDER BY r.created_at DESC LIMIT 15`);
            rows = res.rows.map(r => createRow(r.machine_id, r.line_user_id.substring(0,8), `-${r.points_redeemed}p`, r.created_at, "#ff4b4b", r.line_user_id));
        }
        if (rows.length === 0) return await sendReply(replyToken, "ℹ️ ไม่มีรายการ");
        await sendFlex(replyToken, title, { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: color, contents: [{ type: "text", text: title, color: "#ffffff", weight: "bold" }] }, body: { type: "box", layout: "vertical", spacing: "none", contents: rows } });
    } catch (e) { console.error(e); }
}

async function sendReply(rt, text) { try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); } }
async function sendReplyPush(to, text) { try { await axios.post("https://api.line.me/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); } }
async function sendFlex(rt, alt, contents) { try { await axios.post("https://api.line.me/v2/bot/message/reply", { replyToken: rt, messages: [{ type: "flex", altText: alt, contents }] }, { headers: { 'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}` }}); } catch (e) { console.error(e.response?.data); } }
async function updateExchangeRatio(input, rt) { const parts = input.split(":"); await pool.query(`INSERT INTO system_configs (config_key, baht_val, point_val, updated_at) VALUES ('exchange_ratio', $1, $2, NOW()) ON CONFLICT (config_key) DO UPDATE SET baht_val = $1, point_val = $2, updated_at = NOW()`, [parseInt(parts[0]), parseInt(parts[1])]); await sendReply(rt, `✅ ตั้งค่าสำเร็จ! ${parts[0]} บาท : ${parts[1]} แต้ม 🧼✨`); }
async function addNewAdmin(input, rt) { const [tid, name] = input.split(/\s+/); await pool.query('INSERT INTO bot_admins (line_user_id, admin_name) VALUES ($1, $2) ON CONFLICT (line_user_id) DO NOTHING', [tid, name || "Admin"]); await sendReply(rt, `✅ เพิ่มแอดมินคุณ ${name} สำเร็จแล้วค่ะ 🧸🫧`); }
async function deleteAdmin(tid, rt) { await pool.query('DELETE FROM bot_admins WHERE line_user_id = $1', [tid]); await sendReply(rt, "🗑️ ลบแอดมินเรียบร้อยแล้วค่ะ"); }
async function approveSpecificPoint(rid, rt) { const reqRes = await pool.query('SELECT * FROM point_requests WHERE id = $1', [rid]); const req = reqRes.rows[0]; if (!req) return; let memRes = await pool.query('SELECT id FROM "ninetyMember" WHERE line_user_id = $1', [req.line_user_id]); let memberId = memRes.rows.length === 0 ? (await pool.query('INSERT INTO "ninetyMember" (line_user_id) VALUES ($1) RETURNING id', [req.line_user_id])).rows[0].id : memRes.rows[0].id; await pool.query('INSERT INTO "memberWallet" (member_id, point_balance) VALUES ($1, $2) ON CONFLICT (member_id) DO UPDATE SET point_balance = "memberWallet".point_balance + $2', [memberId, req.points]); await pool.query('DELETE FROM point_requests WHERE id = $1', [rid]); await sendReply(rt, `✅ อนุมัติสำเร็จ!`); await sendReplyPush(req.line_user_id, `🎊 แอดมินอนุมัติ ${req.points} แต้มให้แล้วนะคะ 🧼✨🧸`); }
async function listAdminsWithDelete(rt) { const res = await pool.query('SELECT * FROM bot_admins'); const adminRows = res.rows.map(a => ({ type: "box", layout: "horizontal", margin: "md", alignItems: "center", contents: [{ type: "text", text: `👤 ${a.admin_name}`, size: "sm", flex: 5 }, { type: "button", style: "primary", color: "#ff4b4b", height: "sm", flex: 2, action: { type: "message", label: "DEL", text: `DEL_ADMIN_ID ${a.line_user_id}` } }] })); await sendFlex(rt, "Admin List", { type: "bubble", body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "🔐 ADMIN LIST", weight: "bold", size: "lg" }, ...adminRows] } }); }
async function sendAdminDashboard(rt) { const flex = { type: "bubble", header: { type: "box", layout: "vertical", backgroundColor: "#1c1c1c", contents: [{ type: "text", text: "90 WASH ADMIN", color: "#00b900", weight: "bold", size: "xl" }] }, body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📊 ACTIVITY REPORT", text: "REPORT" } }, { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "💰 SET EXCHANGE RATIO", text: "SET_RATIO_STEP1" } }, { type: "button", style: "secondary", action: { type: "message", label: "🔐 MANAGE ADMINS", text: "LIST_ADMIN" } }] } }; await sendFlex(rt, "Admin Dashboard", flex); }
async function sendReportMenu(rt) { const flex = { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "button", style: "primary", color: "#ff4b4b", action: { type: "message", label: "🔔 Pending Requests", text: "SUB_PENDING" } }, { type: "button", style: "primary", color: "#00b900", action: { type: "message", label: "📥 Recent Earns", text: "SUB_EARNS" } }, { type: "button", style: "primary", color: "#ff9f00", action: { type: "message", label: "📤 Recent Redeems", text: "SUB_REDEEMS" } }] } }; await sendFlex(rt, "Report Menu", flex); }

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 God Mode on port ${PORT}`));
