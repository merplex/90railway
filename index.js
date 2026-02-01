// เปลี่ยนจาก Supabase Client เป็น PG Pool
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // สำหรับ Railway ต้องใส่บรรทัดนี้ด้วยนะคะ
});

/* ============================================================
   จุดที่ 1: รายงาน Pending (เฉพาะรายการล่าสุดของแต่ละ User)
============================================================ */
async function listSubReport(replyToken, type) {
    try {
        if (type === "PENDING") {
            // ใช้ SQL Query เพื่อดึงเฉพาะรายการล่าสุดของแต่ละ User (Unique)
            const query = `
                SELECT DISTINCT ON (line_user_id) *
                FROM point_requests
                ORDER BY line_user_id, request_at DESC
                LIMIT 15
            `;
            const res = await pool.query(query);
            const uniqueList = res.rows;

            const rows = uniqueList.map(r => ({
                type: "box", layout: "horizontal", margin: "md", alignItems: "center",
                contents: [
                    { type: "text", text: String(r.line_user_id).substring(0, 8) + "...", size: "xs", flex: 4, gravity: "center" },
                    { type: "text", text: `+${r.points}p`, size: "sm", flex: 3, color: "#00b900", align: "center", weight: "bold", gravity: "center" },
                    { type: "button", style: "primary", color: "#00b900", height: "sm", flex: 3, action: { type: "message", label: "OK", text: `APPROVE_ID ${r.id}` } }
                ]
            }));
            // ... ส่ง Flex ตามปกติ ...
        }
    } catch (e) { console.error(e); }
}

/* ============================================================
   จุดที่ 2: การอนุมัติ (บันทึกลง Wallet และสร้าง Earn Log)
============================================================ */
async function approveSpecificPoint(rid, rt) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // ใช้ Transaction เพื่อความปลอดภัย
        
        // 1. หาข้อมูลคำขอ
        const reqRes = await client.query('SELECT * FROM point_requests WHERE id = $1', [rid]);
        const req = reqRes.rows[0];
        if (!req) return;

        // 2. อัปเดต Wallet (Upsert Logic)
        await client.query(`
            INSERT INTO "memberWallet" (member_id, point_balance)
            VALUES ((SELECT id FROM "ninetyMember" WHERE line_user_id = $1), $2)
            ON CONFLICT (member_id) DO UPDATE SET point_balance = "memberWallet".point_balance + $2
        `, [req.line_user_id, req.points]);

        // 3. บันทึกลง Earn Logs (ตาราง qrPointToken)
        await client.query(`
            INSERT INTO "qrPointToken" (qr_token, point_get, machine_id, is_used, used_by, used_at, create_at)
            VALUES ($1, $2, $3, true, $4, NOW(), NOW())
        `, [`MANUAL-${Date.now()}`, req.points, 'ADMIN', req.line_user_id]);

        // 4. ลบคำขอที่อนุมัติแล้ว
        await client.query('DELETE FROM point_requests WHERE id = $1', [rid]);

        await client.query('COMMIT');
        // ... ส่ง Push แจ้งลูกค้า ...
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
    } finally {
        client.release();
    }
}
