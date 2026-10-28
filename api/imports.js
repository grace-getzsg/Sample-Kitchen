const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getPool } = require("../lib/database");
const { validateInventory, validateHr, validateCrm } = require("../lib/import-validation");

const schemaSql = fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8");
let schemaReady;

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function authorized(request) {
  const expected = process.env.OWNER_IMPORT_TOKEN;
  const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function ensureSchema(pool) {
  if (!schemaReady) schemaReady = pool.query(schemaSql).catch((error) => { schemaReady = null; throw error; });
  await schemaReady;
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw Object.assign(new Error("Upload exceeds the 2 MB limit."), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

async function latestStaff(client) {
  const result = await client.query("SELECT staff_id, name FROM staff");
  return result.rows;
}

async function saveImport(pool, parsed, filename, sha256) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = parsed.externalId
      ? await client.query("SELECT id, content_sha256, imported_at, row_count FROM imports WHERE kind = $1 AND external_id = $2", [parsed.kind, parsed.externalId])
      : await client.query("SELECT id, content_sha256, imported_at, row_count FROM imports WHERE kind = $1 AND content_sha256 = $2", [parsed.kind, sha256]);
    if (duplicate.rowCount) {
      if (duplicate.rows[0].content_sha256 !== sha256) throw Object.assign(new Error("This export ID already exists with different file contents. Use a new export ID for changed data."), { status: 409 });
      await client.query("ROLLBACK");
      return { ...duplicate.rows[0], duplicate: true };
    }
    const result = await client.query(
      `INSERT INTO imports (kind, source_file, external_id, source_system, exported_at, row_count, content_sha256, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id, imported_at, row_count`,
      [parsed.kind, filename, parsed.externalId, parsed.sourceSystem, parsed.exportedAt, parsed.rowCount, sha256, JSON.stringify(parsed.checkedAt ? { checked_at: parsed.checkedAt } : {})]
    );
    const importId = result.rows[0].id;
    if (parsed.kind === "inventory") {
      for (const row of parsed.records) await client.query("INSERT INTO inventory_counts (import_id, ingredient_id, name, unit, on_hand, committed, pack_size, pack_name, checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [importId, row.ingredient_id, row.name, row.unit, row.on_hand, row.committed, row.pack_size, row.pack_name, row.checked_at]);
    } else if (parsed.kind === "staff") {
      for (const row of parsed.records) await client.query("INSERT INTO staff (staff_id, import_id, name, employment_type, role, skills) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (staff_id) DO UPDATE SET import_id=EXCLUDED.import_id,name=EXCLUDED.name,employment_type=EXCLUDED.employment_type,role=EXCLUDED.role,skills=EXCLUDED.skills", [row.staff_id, importId, row.name, row.employment_type, row.role, JSON.stringify(row.skills)]);
    } else if (parsed.kind === "leave") {
      for (const row of parsed.records) await client.query("INSERT INTO leave_records (import_id, external_id, staff_id, leave_date, status, reason) VALUES ($1,$2,$3,$4,$5,$6)", [importId, row.external_id, row.staff_id, row.leave_date, row.status, row.reason]);
    } else if (parsed.kind === "availability") {
      for (const row of parsed.records) await client.query("INSERT INTO availability (import_id, staff_id, shift_date, starts_at, ends_at, status) VALUES ($1,$2,$3,$4,$5,$6)", [importId, row.staff_id, row.shift_date, row.starts_at, row.ends_at, row.status]);
    } else {
      for (const row of parsed.records) await client.query("INSERT INTO crm_orders (import_id, external_order_id, production_date, customer, product_id, quantity, status, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [importId, row.external_order_id, row.production_date, row.customer, row.product_id, row.quantity, row.status, row.received_at]);
    }
    await client.query("COMMIT");
    return { ...result.rows[0], duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function handler(request, response) {
  if (!authorized(request)) return json(response, 401, { error: "Owner access required. Configure OWNER_IMPORT_TOKEN and enter it to import files." });
  try {
    const pool = getPool();
    await ensureSchema(pool);
    if (request.method === "GET") {
      const result = await pool.query("SELECT id, kind, source_file, external_id, source_system, exported_at, imported_at, row_count, details FROM imports ORDER BY imported_at DESC");
      return json(response, 200, { imports: result.rows });
    }
    if (request.method !== "POST") { response.setHeader("Allow", "GET, POST"); return json(response, 405, { error: "Method not allowed." }); }
    const input = await readBody(request);
    if (!input || typeof input.content !== "string" || typeof input.filename !== "string") return json(response, 400, { error: "Provide filename and file content." });
    const filename = input.filename.split(/[\\/]/).pop().slice(0, 180);
    let parsed;
    try {
      if (input.kind === "inventory") parsed = validateInventory(input.content);
      else if (["staff", "leave", "availability"].includes(input.kind)) {
        let staff = [];
        if (input.kind !== "staff") {
          const client = await pool.connect();
          try { staff = await latestStaff(client); } finally { client.release(); }
        }
        parsed = validateHr(input.content, input.kind, staff);
      } else if (input.kind === "crm_orders") parsed = validateCrm(input.content);
      else return json(response, 400, { error: "Unknown import kind." });
    } catch (error) { error.status = 422; throw error; }
    const sha256 = crypto.createHash("sha256").update(input.content).digest("hex");
    const saved = await saveImport(pool, parsed, filename, sha256);
    return json(response, 200, { import: { ...saved, kind: parsed.kind, source_file: filename, external_id: parsed.externalId, source_system: parsed.sourceSystem, exported_at: parsed.exportedAt } });
  } catch (error) { return json(response, error.status || 500, { error: error.message || "Import failed." }); }
}

module.exports = handler;
