const sql = `
-- สร้างตารางแม่ก่อน
CREATE TABLE IF NOT EXISTS "ninetyMember" (
    id SERIAL PRIMARY KEY,
    line_user_id TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ค่อยสร้างตารางลูกที่ต้องอ้างอิงถึงตารางแม่
CREATE TABLE IF NOT EXISTS "memberWallet" (
    member_id INTEGER PRIMARY KEY REFERENCES "ninetyMember"(id) ON DELETE CASCADE,
    point_balance INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "redeemlogs" (
    id SERIAL PRIMARY KEY,
    member_id INTEGER REFERENCES "ninetyMember"(id),
    machine_id TEXT,
    points_redeemed INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ตารางอื่น ๆ ที่เหลือ
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

CREATE TABLE IF NOT EXISTS "system_configs" (
    config_key TEXT PRIMARY KEY, baht_val INTEGER, point_val INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
`;
