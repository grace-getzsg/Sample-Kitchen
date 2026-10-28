const fs = require("node:fs");
const path = require("node:path");

const expectedCsvHeaders = ["export_id", "exported_at", "export_status", "id", "production_date", "customer", "product_id", "quantity", "status", "received_at"];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((line) => line.some((cell) => cell.trim() !== ""));
}

function readReference(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "reference-data", name), "utf8"));
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value); }
function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than zero.`);
  return number;
}
function nonnegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be zero or greater.`);
  return number;
}
function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}.`);
    seen.add(value);
  }
}

function validateInventory(content) {
  const data = JSON.parse(content);
  if (!Array.isArray(data) || data.length === 0) throw new Error("Stock count must be a non-empty JSON array.");
  const records = data.map((item, index) => {
    const label = `Stock row ${index + 1}`;
    return {
      ingredient_id: requireString(item.ingredient_id, `${label} ingredient_id`),
      name: requireString(item.name, `${label} name`),
      unit: requireString(item.unit, `${label} unit`),
      on_hand: nonnegativeNumber(item.on_hand, `${label} on_hand`),
      committed: nonnegativeNumber(item.committed, `${label} committed`),
      pack_size: positiveNumber(item.pack_size, `${label} pack_size`),
      pack_name: requireString(item.pack_name, `${label} pack_name`),
      checked_at: item.checked_at
    };
  });
  uniqueBy(records, "ingredient_id", "ingredient_id");
  for (const [index, item] of records.entries()) if (!validTimestamp(item.checked_at)) throw new Error(`Stock row ${index + 1} checked_at must be an ISO timestamp with a time zone.`);
  if (new Set(records.map((item) => item.checked_at)).size !== 1) throw new Error("All stock rows must come from the same physical count time.");
  if (records.some((item) => item.committed > item.on_hand)) throw new Error("Committed stock cannot exceed on_hand.");
  return { kind: "inventory", externalId: null, sourceSystem: null, exportedAt: null, rowCount: records.length, records, checkedAt: records[0].checked_at };
}

function validateHr(content, kind, existingStaff = []) {
  const data = JSON.parse(content);
  if (!data || typeof data !== "object" || !Array.isArray(data.records) || !data.records.length) throw new Error("HR export must contain a non-empty records array.");
  const externalId = requireString(data.export_id, "export_id");
  const sourceSystem = requireString(data.source_system, "source_system");
  if (!validTimestamp(data.exported_at)) throw new Error("exported_at must be an ISO timestamp with a time zone.");
  const staffIds = new Set(existingStaff.map((staff) => staff.staff_id));
  if (kind === "staff") {
    const records = data.records.map((item, index) => {
      const label = `Staff row ${index + 1}`;
      if (!Array.isArray(item.skills)) throw new Error(`${label} skills must be an array.`);
      return { staff_id: requireString(item.id, `${label} id`), name: requireString(item.name, `${label} name`), employment_type: requireString(item.employment_type, `${label} employment_type`), role: requireString(item.role, `${label} role`), skills: item.skills.map((skill) => requireString(skill, `${label} skill`)) };
    });
    uniqueBy(records, "staff_id", "staff id");
    return { kind, externalId, sourceSystem, exportedAt: data.exported_at, rowCount: records.length, records };
  }
  if (!staffIds.size) throw new Error("Import the staff master before leave or availability records.");
  if (kind === "leave") {
    const records = data.records.map((item, index) => {
      const label = `Leave row ${index + 1}`;
      const staffId = requireString(item.staff_id, `${label} staff_id`);
      if (!staffIds.has(staffId)) throw new Error(`${label} refers to unknown staff_id ${staffId}.`);
      if (!validDate(item.date)) throw new Error(`${label} date must use YYYY-MM-DD.`);
      return { external_id: requireString(item.id, `${label} id`), staff_id: staffId, leave_date: item.date, status: requireString(item.status, `${label} status`), reason: item.reason == null ? null : String(item.reason) };
    });
    uniqueBy(records, "external_id", "leave id");
    return { kind, externalId, sourceSystem, exportedAt: data.exported_at, rowCount: records.length, records };
  }
  const records = data.records.map((item, index) => {
    const label = `Availability row ${index + 1}`;
    const staffId = requireString(item.staff_id, `${label} staff_id`);
    if (!staffIds.has(staffId)) throw new Error(`${label} refers to unknown staff_id ${staffId}.`);
    if (!validDate(item.date)) throw new Error(`${label} date must use YYYY-MM-DD.`);
    const start = requireString(item.start, `${label} start`);
    const end = requireString(item.end, `${label} end`);
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) throw new Error(`${label} must have valid start/end times with end after start.`);
    return { staff_id: staffId, shift_date: item.date, starts_at: start, ends_at: end, status: requireString(item.status, `${label} status`) };
  });
  uniqueBy(records.map((item) => ({ ...item, shift_key: `${item.staff_id}|${item.shift_date}|${item.starts_at}|${item.ends_at}` })), "shift_key", "availability shift");
  return { kind, externalId, sourceSystem, exportedAt: data.exported_at, rowCount: records.length, records };
}

function validateCrm(content) {
  const rows = parseCsv(content);
  const headers = rows.shift();
  if (!headers || headers.length !== expectedCsvHeaders.length || headers.some((value, index) => value.trim() !== expectedCsvHeaders[index])) throw new Error(`CRM CSV headers must be: ${expectedCsvHeaders.join(", ")}.`);
  if (!rows.length) throw new Error("CRM CSV has no order rows.");
  const products = readReference("products_and_recipes.json");
  const productIds = new Set((products.products || []).map((item) => item.id));
  const records = rows.map((row, index) => {
    if (row.length !== headers.length) throw new Error(`CRM row ${index + 2} has ${row.length} columns; expected ${headers.length}.`);
    const item = Object.fromEntries(headers.map((header, i) => [header, row[i].trim()]));
    if (!item.export_id || !item.id || !item.product_id || !item.customer || !item.status) throw new Error(`CRM row ${index + 2} is missing a required value.`);
    if (!validDate(item.production_date)) throw new Error(`CRM row ${index + 2} production_date must use YYYY-MM-DD.`);
    if (!validTimestamp(item.received_at)) throw new Error(`CRM row ${index + 2} received_at must include a time zone.`);
    if (!productIds.has(item.product_id)) throw new Error(`CRM row ${index + 2} has unknown product_id ${item.product_id}.`);
    if (!/^\d+$/.test(item.quantity) || Number(item.quantity) <= 0) throw new Error(`CRM row ${index + 2} quantity must be a positive integer.`);
    return { external_order_id: item.id, production_date: item.production_date, customer: item.customer, product_id: item.product_id, quantity: Number(item.quantity), status: item.status, received_at: item.received_at, export_id: item.export_id, exported_at: item.exported_at, export_status: item.export_status };
  });
  const exportIds = new Set(records.map((record) => record.export_id));
  const exportedTimes = new Set(records.map((record) => record.exported_at));
  if (exportIds.size !== 1 || exportedTimes.size !== 1) throw new Error("Every CRM row must belong to the same export ID and export time.");
  uniqueBy(records, "external_order_id", "CRM order ID");
  if (!validTimestamp(records[0].exported_at)) throw new Error("CRM exported_at must include a time zone.");
  return { kind: "crm_orders", externalId: records[0].export_id, sourceSystem: "CRM", exportedAt: records[0].exported_at, rowCount: records.length, records };
}

module.exports = { validateInventory, validateHr, validateCrm };
