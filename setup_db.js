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
-- 1. สร้างตาราง redeemlogs ก่อน (กันเหนียว)
CREATE TABLE IF NOT EXISTS "redeemlogs" (
    id SERIAL PRIMARY KEY,
    member_id INTEGER REFERENCES "ninetyMember"(id) ON DELETE CASCADE,
    machine_id TEXT,
    points_redeemed INTEGER NOT NULL,
    status TEXT DEFAULT 'success',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. รันสคริปต์ Mock Data
DO $$
DECLARE
    machine_name TEXT;
    target_user TEXT;
    rand_amount INTEGER;
    rand_points INTEGER;
    rand_redeem INTEGER;
    i INTEGER;
    j INTEGER;
    sys_baht_rate INTEGER := 10;
    machines TEXT[] := ARRAY['MCTE01', 'MCTE02', 'MCTE03', 'MCTE04', 'MCTE05'];
BEGIN
    -- สร้าง User จำลอง 20 คน
    FOR i IN 1..20 LOOP
        INSERT INTO "ninetyMember" (line_user_id)
        VALUES ('U' || md5(random()::text)) 
        ON CONFLICT DO NOTHING;
    END LOOP;

    -- สร้างกระเป๋าตังค์
    INSERT INTO "memberWallet" (member_id, point_balance)
    SELECT id, 0 FROM "ninetyMember"
    WHERE id NOT IN (SELECT member_id FROM "memberWallet");

    -- วนลูปสร้างข้อมูลทีละเครื่อง
    FOREACH machine_name IN ARRAY machines LOOP
        
        -- Scan (Earn) 50 รายการ
        FOR j IN 1..50 LOOP
            SELECT line_user_id INTO target_user FROM "ninetyMember" ORDER BY random() LIMIT 1;
            rand_amount := floor(random() * 100 + 1)::int;
            rand_points := floor(rand_amount / sys_baht_rate)::int;

            INSERT INTO "qrPointToken" (qr_token, point_get, machine_id, scan_amount, is_used, used_by, used_at, create_at)
            VALUES ('MOCK-EARN-' || md5(random()::text), rand_points, machine_name, rand_amount, true, target_user, NOW() - (random() * interval '7 days'), NOW() - (random() * interval '7 days'));
        END LOOP;

        -- Redeem (แลกแต้ม) 20 รายการ
        FOR j IN 1..20 LOOP
            SELECT line_user_id INTO target_user FROM "ninetyMember" ORDER BY random() LIMIT 1;
            rand_redeem := (floor(random() * 5 + 1) * 10)::int; 

            INSERT INTO "redeemlogs" (member_id, machine_id, points_redeemed, status, created_at)
            SELECT id, machine_name, rand_redeem, 'success', NOW() - (random() * interval '7 days')
            FROM "ninetyMember" WHERE line_user_id = target_user;
        END LOOP;

    END LOOP;

    -- คำนวณยอดเงินคงเหลือใหม่
    UPDATE "memberWallet" w
    SET point_balance = (
        COALESCE((SELECT SUM(point_get) FROM "qrPointToken" q WHERE q.used_by = m.line_user_id AND q.is_used = true), 0)
        -
        COALESCE((SELECT SUM(points_redeemed) FROM "redeemlogs" r WHERE r.member_id = m.id), 0)
    )
    FROM "ninetyMember" m
    WHERE w.member_id = m.id;

END $$;
`;

async function runSetup() {
  try {
    console.log("⏳ กำลังกู้ตารางและสร้างข้อมูล Mock Data...");
    await pool.query(sql);
    console.log("✅ เรียบร้อย! ตารางกลับมาแล้ว + ข้อมูลเพียบ!");
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

runSetup();
