const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'nozomi.proxy.rlwy.net', 
  database: 'railway',
  password: 'udGKTbWpMjoQqHQJcpUjlyvfvuosMfzz',
  port: 50229, 
  ssl: { rejectUnauthorized: false }
});

const sql = `
-- ลบของเก่าที่มีปัญหาออกให้เกลี้ยง
DROP TABLE IF EXISTS "memberWallet" CASCADE;
DROP TABLE IF EXISTS "ninetyMember" CASCADE;
DROP TABLE IF EXISTS "redeemlogs" CASCADE;
DROP TABLE IF EXISTS "bot_admins" CASCADE;

-- 1. สร้างตารางแม่ (ใช้ประเภท SERIAL เพื่อให้เป็นตัวเลข)
CREATE TABLE "ninetyMember" (
    id SERIAL PRIMARY KEY,
    line_user_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. สร้างตารางลูก (ใช้ INTEGER ให้ตรงกับแม่)
CREATE TABLE "memberWallet" (
    member_id INTEGER PRIMARY KEY REFERENCES "ninetyMember"(id) ON DELETE CASCADE,
    point_balance INTEGER DEFAULT 0
);

-- 3. ตาราง Admin
CREATE TABLE "bot_admins" (
    line_user_id TEXT PRIMARY KEY, 
    admin_name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- เพิ่ม Boss เป็น Admin ทันที
INSERT INTO "bot_admins" (line_user_id, admin_name) 
VALUES ('U8d1d21082843a3aedb6cdd65f8779454', 'Boss Prem')
ON CONFLICT (line_user_id) DO NOTHING;
`;


async function runSetup() {
  try {
    console.log("⏳ กำลังสร้างตารางทั้งหมดใน Railway...");
    await pool.query(sql);
    console.log("✅ สร้างตารางสำเร็จแล้ว! (รวมถึง redeemlogs ด้วยค่ะ)");
  } catch (err) {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
  } finally {
    await pool.end();
  }
}

runSetup();
