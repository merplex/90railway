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
-- สร้างตารางหลัก
CREATE TABLE IF NOT EXISTS "ninetyMember" (
    id SERIAL PRIMARY KEY,
    line_user_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- สร้างตาราง Wallet
CREATE TABLE IF NOT EXISTS "memberWallet" (
    member_id INTEGER PRIMARY KEY REFERENCES "ninetyMember"(id) ON DELETE CASCADE,
    point_balance INTEGER DEFAULT 0
);

-- ✨ สร้างตาราง Redeemlogs (ที่ Boss ต้องการ)
CREATE TABLE IF NOT EXISTS "redeemlogs" (
    id SERIAL PRIMARY KEY,
    member_id INTEGER REFERENCES "ninetyMember"(id),
    machine_id TEXT,
    points_redeemed INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ตารางอื่น ๆ
CREATE TABLE IF NOT EXISTS "qrPointToken" (
    id SERIAL PRIMARY KEY, qr_token TEXT UNIQUE NOT NULL, point_get INTEGER NOT NULL,
    machine_id TEXT, is_used BOOLEAN DEFAULT FALSE, used_by TEXT, used_at TIMESTAMP WITH TIME ZONE, create_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "point_requests" (
    id SERIAL PRIMARY KEY, line_user_id TEXT NOT NULL, points INTEGER NOT NULL, request_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "bot_admins" (
    line_user_id TEXT PRIMARY KEY, admin_name TEXT NOT NULL, created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
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
