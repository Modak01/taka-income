const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false
});
pool.on("error", err => console.error("Unexpected PostgreSQL pool error:", err.message));
module.exports = { pool };