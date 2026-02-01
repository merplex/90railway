const { Pool } = require('pg');

// 🔌 ข้อมูลเชื่อมต่อเดิมของ Boss (เรเช็กแล้วว่า Port 50229 ถูกต้องสำหรับ Public)
const pool = new Pool({
  user: 'postgres',
  host: 'nozomi.proxy.rlwy.net', 
  database: 'railway',
  password: 'udGKTbWpMjoQqHQJcpUjlyvfvuosMfzz',
  port: 50229, 
  ssl: { rejectUnauthorized: false }
});

// 👑 คำสั่งแต่งตั้งแอดมิน
const sql = `
INSERT INTO "bot_admins" (line_user_id, admin_name) 
VALUES ('U8d1d21082843a3aedb6cdd65f8779454', 'Boss Prem')
ON CONFLICT (line_user_id) DO NOTHING;

-- ดึงข้อมูลออกมาเช็กดูว่าเข้าหรือยัง
SELECT * FROM "bot_admins";
`;

async function runSetup() {
  try {
    console.log("⏳ กำลังส่งคำสั่งแต่งตั้งแอดมินไปที่ Railway...");
    const res = await pool.query(sql);
    
    // แสดงผลที่ดึงออกมาจาก SELECT
    if (res[1] && res[1].rows) {
        console.log("✅ รายชื่อแอดมินปัจจุบัน:");
        console.table(res[1].rows);
    }
    
    console.log("\n✨ เรียบร้อยแล้วค่ะ Boss! ตอนนี้บอทจะรู้จัก Boss ในฐานะ Admin แล้วค่ะ");
  } catch (err) {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
  } finally {
    await pool.end();
  }
}

runSetup();
