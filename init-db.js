require("dotenv").config();
const { pool } = require("./db");

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by BIGINT REFERENCES users(id),
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS short_links (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      code TEXT UNIQUE NOT NULL,
      destination_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      amount_usd NUMERIC(12,2) NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('earning','referral','withdrawal_hold','withdrawal_release','adjustment')),
      reference TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      amount_usd NUMERIC(12,2) NOT NULL CHECK (amount_usd >= 3),
      method TEXT NOT NULL CHECK (method IN ('bKash','Nagad','Rocket','USDT_BEP20','OTHER_WALLET')),
      payout_details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      admin_user_id BIGINT REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status, created_at);
  `);
  console.log("Database tables initialized.");
  await pool.end();
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1); });