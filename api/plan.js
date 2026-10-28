const fs = require("node:fs");
const path = require("node:path");
const { getPool } = require("../lib/database");
const { authorized } = require("../lib/auth");
const { calculatePlan } = require("../lib/planning");

const schemaSql = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
let schemaReady;

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function ensureSchema(pool) {
  if (!schemaReady) schemaReady = pool.query(schemaSql).catch((error) => { schemaReady = null; throw error; });
  await schemaReady;
}

async function loadPlan(pool) {
    await ensureSchema(pool);
    const importResult = await pool.query(
      `SELECT DISTINCT ON (kind) id, kind, source_file, external_id, source_system, exported_at, imported_at, row_count
       FROM imports WHERE kind IN ('inventory','staff','leave','availability','crm_orders')
       ORDER BY kind, imported_at DESC, id DESC`
    );
    const latest = new Map(importResult.rows.map((record) => [record.kind, record]));
    const required = ["inventory", "staff", "leave", "availability", "crm_orders"];
    const missing = required.filter((kind) => !latest.has(kind));
    if (missing.length) return { ready: false, missing };

    const inventory = (await pool.query("SELECT ingredient_id, name, unit, on_hand, committed, pack_size, pack_name, checked_at FROM inventory_counts WHERE import_id=$1 ORDER BY ingredient_id", [latest.get("inventory").id])).rows;
    const staff = (await pool.query("SELECT staff_id, name, employment_type, role, skills FROM staff ORDER BY name")).rows;
    const leave = (await pool.query("SELECT staff_id, leave_date, status, reason FROM leave_records WHERE import_id=$1 ORDER BY leave_date, staff_id", [latest.get("leave").id])).rows;
    const availability = (await pool.query("SELECT staff_id, shift_date, starts_at, ends_at, status FROM availability WHERE import_id=$1 ORDER BY shift_date, starts_at, staff_id", [latest.get("availability").id])).rows;
    const orders = (await pool.query("SELECT external_order_id, production_date, customer, product_id, quantity, status, received_at FROM crm_orders WHERE import_id=$1 ORDER BY production_date, external_order_id", [latest.get("crm_orders").id])).rows.map((row) => ({ ...row, id: row.external_order_id }));
    const result = calculatePlan({ orders, inventory, staff, leave, availability, imports: importResult.rows });
    return { ready: true, plan: result };
}

async function handler(request, response) {
  if (!authorized(request)) return json(response, 401, { error: "Owner access required." });
  if (request.method !== "GET") { response.setHeader("Allow", "GET"); return json(response, 405, { error: "Method not allowed." }); }
  try {
    return json(response, 200, await loadPlan(getPool()));
  } catch (error) { return json(response, 500, { error: error.message || "Could not calculate the plan." }); }
}

module.exports = handler;
module.exports.loadPlan = loadPlan;
