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
DO $$
DECLARE
    boss_id TEXT := 'U8d1d21082843a3aedb6cdd65f8779454'; -- 👑 ID ของ Boss
    temp_user RECORD;
    machine_name TEXT; -- ตัวแปรสำหรับเก็บชื่อเครื่อง
    target_user TEXT;
    rand_amount INTEGER;
    rand_points INTEGER;
    rand_redeem INTEGER;
    i INTEGER;
    j INTEGER;
    k INTEGER; -- ตัวนับลูปเครื่อง
    sys_baht_rate INTEGER := 10;
    machines TEXT[] := ARRAY['MCTE01', 'MCTE02', 'MCTE03', 'MCTE04', 'MCTE05'];
BEGIN
    -- 1. 🧨 ล้างข้อมูลเก่า
    RAISE NOTICE 'กำลังล้างข้อมูลเก่า...';
    TRUNCATE TABLE "qrPointToken", "redeemlogs", "memberWallet", "point_requests", "ninetyMember" RESTART IDENTITY CASCADE;

    -- 2. 👑 สร้าง User ของ Boss
    INSERT INTO "ninetyMember" (line_user_id) VALUES (boss_id);

    -- 3. 🤖 สร้าง User จำลองเพิ่มอีก 19 คน
    FOR i IN 1..19 LOOP
        INSERT INTO "ninetyMember" (line_user_id)
        VALUES ('U' || md5(random()::text)) 
        ON CONFLICT DO NOTHING;
    END LOOP;

    -- สร้างกระเป๋าตังค์เริ่มต้นให้ทุกคน (0 บาท)
    INSERT INTO "memberWallet" (member_id, point_balance)
    SELECT id, 0 FROM "ninetyMember";

    -- 4. 🎁 แจก "เงินขวัญถุง" คนละ 1,000 แต้ม (แก้ปัญหาแต้มติดลบ)
    FOR temp_user IN SELECT line_user_id FROM "ninetyMember" LOOP
        INSERT INTO "qrPointToken" (qr_token, point_get, machine_id, scan_amount, is_used, used_by, used_at, create_at)
        VALUES (
            'WELCOME-' || md5(random()::text), 
            1000,           
            'SYSTEM_GIFT',  
            0, 
            true, 
            temp_user.line_user_id, 
            NOW(), 
            NOW()
        );
    END LOOP;

    -- 5. 💰 วนลูปจำลองการใช้งานปกติ (Earn & Redeem)
    -- ⚠️ เปลี่ยนมาใช้ FOR ธรรมดา เพื่อแก้ Error FOREACH
    FOR k IN 1..array_length(machines, 1) LOOP
        machine_name := machines[k]; -- ดึงชื่อเครื่องออกมาทีละตัว
        
        -- จำลอง Scan (Earn) เพิ่มเติม
        FOR j IN 1..30 LOOP
            SELECT line_user_id INTO target_user FROM "ninetyMember" ORDER BY random() LIMIT 1;
            rand_amount := floor(random() * 100 + 1)::int;
            rand_points := floor(rand_amount / sys_baht_rate)::int;

            INSERT INTO "qrPointToken" (qr_token, point_get, machine_id, scan_amount, is_used, used_by, used_at, create_at)
            VALUES ('MOCK-' || md5(random()::text), rand_points, machine_name, rand_amount, true, target_user, NOW() - (random() * interval '7 days'), NOW() - (random() * interval '7 days'));
        END LOOP;

        -- จำลอง Redeem (แลกแต้ม) *แลกน้อยกว่าที่แจก รับรองไม่ติดลบ*
        FOR j IN 1..10 LOOP
            SELECT line_user_id INTO target_user FROM "ninetyMember" ORDER BY random() LIMIT 1;
            rand_redeem := (floor(random() * 5 + 1) * 10)::int; -- แลกทีละ 10-50 แต้ม

            INSERT INTO "redeemlogs" (member_id, machine_id, points_redeemed, status, created_at)
            SELECT id, machine_name, rand_redeem, 'success', NOW() - (random() * interval '7 days')
            FROM "ninetyMember" WHERE line_user_id = target_user;
        END LOOP;

    END LOOP;

    -- 6. 🧮 คำนวณยอดเงินคงเหลือใหม่
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
    console.log("⏳ กำลังล้างบางและแจกเงินขวัญถุง...");
    await pool.query(sql);
    console.log("✅ เรียบร้อย! ทุกคนได้แต้มเริ่มต้น 1,000 แต้ม + ข้อมูลจำลอง (ไม่มีติดลบแน่นอน)");
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await pool.end();
  }
}

runSetup();
