const { Pool } = require("pg");

const dbUrl = process.env.DATABASE_URL || "postgresql://postgres@localhost:5432/hulu_bingo";
const isLocal = dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1");

const pool = new Pool({
  connectionString: dbUrl,
  ssl: (!isLocal || process.env.NODE_ENV === "production")
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

pool.on("error", (err) => {
  console.error("[PostgreSQL Pool Error]", err.message);
});

module.exports = pool;
