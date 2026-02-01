const { Pool } = require('pg');

// ✅ ก๊อปปี้ DATABASE_URL จากหน้า Variables ของ Railway มาวางในนี้ค่ะ
const connectionString = 'postgres-production-6e9d.up.railway.app';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

const sql = `
CREATE TABLE IF NOT EXISTS "memberWallet" (
    member_id INTEGER PRIMARY KEY REFERENCES "ninetyMember"(id) ON DELETE CASCADE,
    point_balance INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "qrPointToken" (
    id SERIAL PRIMARY KEY, qr_token TEXT UNIQUE NOT NULL, point_get INTEGER NOT NULL,
    machine_id TEXT, scan_amount INTEGER, is_used BOOLEAN DEFAULT FALSE,
    used_by TEXT, used_at TIMESTAMP WITH TIME ZONE, create_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "redeemlogs" (
    id SERIAL PRIMARY KEY, member_id INTEGER REFERENCES "ninetyMember"(id) ON DELETE CASCADE,
    machine_id TEXT, points_redeemed INTEGER NOT NULL, status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "point_requests" (
    id SERIAL PRIMARY KEY, line_user_id TEXT NOT NULL, points INTEGER NOT NULL,
    request_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "system_configs" (
    config_key TEXT PRIMARY KEY, baht_val INTEGER DEFAULT 10, point_val INTEGER DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
