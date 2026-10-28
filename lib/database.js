let pool;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured. Add the Postgres connection string to the server environment.");
  if (!pool) {
    let Pool;
    try { ({ Pool } = require("pg")); }
    catch { throw new Error("Postgres driver is missing. Install the project dependencies before using imports."); }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }, max: 5 });
  }
  return pool;
}

module.exports = { getPool };
