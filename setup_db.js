const sql = `
INSERT INTO "bot_admins" (line_user_id, admin_name) 
VALUES ('U8d1d21082843a3aedb6cdd65f8779454', 'Boss Prem')
ON CONFLICT (line_user_id) DO NOTHING;

-- ลองดึงรายชื่อแอดมินมาดูเพื่อเช็กผล
SELECT * FROM "bot_admins";
`;


/*
const { Pool } = require('pg');

// ✅ ก๊อปปี้ DATABASE_URL จากหน้า Variables ของ Railway มาวางในนี้ค่ะ
const connectionString = 'postgres-production-6e9d.up.railway.app';

const pool = new Pool({
  user: 'postgres',
  host: 'nozomi.proxy.rlwy.net', // ก๊อปมาจากหน้า Public Networking
  database: 'railway',
  password: 'udGKTbWpMjoQqHQJcpUjlyvfvuosMfzz',
  port: 50229, // ⚠️ เปลี่ยนจาก 5432 เป็นเลขที่ Boss เห็นในหน้า Settings ค่ะ!
  ssl: { rejectUnauthorized: false }
});

const sql = `
-- 1. ล้างของเก่าออกก่อน (ถ้ามี) เพื่อเริ่มใหม่แบบสะอาดๆ
DROP TABLE IF EXISTS "memberWallet" CASCADE;
DROP TABLE IF EXISTS "ninetyMember" CASCADE;

-- 2. สร้างตารางหลัก (Parent)
CREATE TABLE "ninetyMember" (
    id SERIAL PRIMARY KEY,
    line_user_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. สร้างตารางลูก (Child) ที่ต้องอ้างอิงถึงตารางหลัก
CREATE TABLE "memberWallet" (
    member_id INTEGER PRIMARY KEY REFERENCES "ninetyMember"(id) ON DELETE CASCADE,
    point_balance INTEGER DEFAULT 0
);

-- 4. สร้างตารางอื่นๆ ที่เหลือ
CREATE TABLE IF NOT EXISTS "qrPointToken" (
    id SERIAL PRIMARY KEY, qr_token TEXT UNIQUE NOT NULL, point_get INTEGER NOT NULL,
    machine_id TEXT, scan_amount INTEGER, is_used BOOLEAN DEFAULT FALSE,
    used_by TEXT, used_at TIMESTAMP WITH TIME ZONE, create_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "point_requests" (
    id SERIAL PRIMARY KEY, line_user_id TEXT NOT NULL, points INTEGER NOT NULL,
    request_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "bot_admins" (
    line_user_id TEXT PRIMARY KEY, admin_name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
`;

async function runSetup() {
  try {
    console.log("⏳ กำลังสร้างตารางใน Railway...");
    await pool.query(sql);
    console.log("✅ สร้างตารางทั้งหมดเรียบร้อยแล้วค่ะ Boss!");
  } catch (err) {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
  } finally {
    await pool.end();
  }
}

runSetup();
*/
