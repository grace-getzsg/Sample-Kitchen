const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getPool } = require("../lib/database");
const { authorized } = require("../lib/auth");
const { loadPlan } = require("./plan");

const MODEL = "gpt-6-luna";
const schema = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string" },
    actions: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { date: { type: "string" }, finding: { type: "string" }, human_action: { type: "string" } },
      required: ["date", "finding", "human_action"] } },
    supplier_note: { type: "string" }
  }, required: ["summary", "actions", "supplier_note"]
};

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function versionOf(imports) {
  return crypto.createHash("sha256").update(JSON.stringify(imports.map(({ kind, id }) => [kind, String(id)]).sort())).digest("hex");
}

function validateResult(value, plan, role) {
  const dates = new Set(plan.production.days.map((day) => day.date));
  if (!value || typeof value.summary !== "string" || !Array.isArray(value.actions) || typeof value.supplier_note !== "string") throw new Error(`${role} returned an invalid result.`);
  if (!value.summary.trim() || value.actions.length < 1 || value.actions.length > 8) throw new Error(`${role} returned an incomplete result.`);
  const text = [value.summary, value.supplier_note, ...value.actions.flatMap((action) => [action.finding, action.human_action])];
  if (text.some((part) => typeof part !== "string" || part.length > 1200 || /\d/.test(part))) throw new Error(`${role} included unchecked numeric claims.`);
  if (text.some((part) => /\b(booked|confirmed cover|order placed|email sent)\b/i.test(part))) throw new Error(`${role} claimed an action was completed.`);
  for (const action of value.actions) {
    if (!dates.has(action.date) || !action.finding.trim() || !action.human_action.trim()) throw new Error(`${role} returned an invalid dated action.`);
  }
  if (role !== "purchasing" && value.supplier_note) throw new Error(`${role} returned an unexpected supplier note.`);
  return value;
}

async function callAgent(role, instructions, input, plan) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured on the server.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, instructions: `${instructions} Use only the supplied verified facts. Write plain language without any digits in summary, findings, human actions, or supplier note. Put dates only in date fields. Never claim a person was booked, an order placed, or an email sent. Return one or more dated actions.`, input: JSON.stringify(input), text: { format: { type: "json_schema", name: "kitchen_agent_recommendation", strict: true, schema } } }),
    signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`OpenAI ${role} request failed (${response.status}).`);
  const body = await response.json();
  const output = (body.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text).join("");
  if (!output) throw new Error(`OpenAI ${role} returned no structured text.`);
  return { result: validateResult(JSON.parse(output), plan, role), response_id: body.id || null };
}

function supplierDraft(plan, note) {
  const supplier = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "reference-data", "supplier.json"), "utf8"));
  const items = plan.ingredients.stock_request.filter((item) => item.packs_to_request > 0);
  return { recipient: supplier.default_draft_to, subject: "Kitchen Planner supplier request — draft for manager review", body: `${note}\n\nPlease review the following requested packs:\n${items.map((item) => `- ${item.packs_to_request} × ${item.pack_name} (${item.ingredient_id})`).join("\n")}\n\nThis is a draft request; no purchase has been placed.` };
}

async function handler(request, response) {
  if (!authorized(request)) return json(response, 401, { error: "Owner access required." });
  if (!["GET", "POST"].includes(request.method)) { response.setHeader("Allow", "GET, POST"); return json(response, 405, { error: "Method not allowed." }); }
  let pool, version, runId;
  try {
    pool = getPool();
    const loaded = await loadPlan(pool);
    if (!loaded.ready) return json(response, 409, { error: `Import these records first: ${loaded.missing.join(", ")}.` });
    const plan = loaded.plan;
    version = versionOf(plan.imports);
    if (request.method === "GET") {
      const rows = await pool.query("SELECT id, import_version, model, status, recommendations, handoff_trace, error_message, created_at, completed_at FROM planning_agent_runs WHERE import_version=$1 ORDER BY id DESC LIMIT 1", [version]);
      return json(response, 200, { import_version: version, run: rows.rows[0] || null });
    }
    const created = await pool.query("INSERT INTO planning_agent_runs (import_version, model, status) VALUES ($1,$2,'running') RETURNING id", [version, MODEL]);
    runId = created.rows[0].id;
    const trace = [];
    const sales = await callAgent("sales", "You are the Sales & Production Planning Agent. Explain the excluded late order and propose dated production actions. Do not change eligibility or quantities. Set supplier_note to an empty string.", { orders: plan.orders, production: plan.production, cutoff: plan.scenario.cutoff }, plan);
    trace.push({ from: "verified plan", to: "sales", response_id: sales.response_id, received: ["orders", "daily production", "cutoff"] });
    const [manpower, purchasing] = await Promise.all([
      callAgent("manpower", "You are the Manpower Planning Agent. Explain the draft named roster, approved leave, uncovered gap and part-time cover to request for manager review. Do not invent a booked worker. Set supplier_note to an empty string.", { labour: plan.labour, roster: plan.roster, sales: sales.result }, plan),
      callAgent("purchasing", "You are the Purchasing Agent. Explain shortages and whole-pack requests and prepare a brief supplier note for manager review. The exact pack list is generated by code.", { stock: plan.ingredients.stock_request, sales: sales.result }, plan)
    ]);
    trace.push({ from: "sales + verified plan", to: "manpower", response_id: manpower.response_id, received: ["sales recommendation", "labour", "roster", "leave and availability reflected in roster"] });
    trace.push({ from: "sales + verified plan", to: "purchasing", response_id: purchasing.response_id, received: ["sales recommendation", "ingredient demand", "stock", "pack requests"] });
    const recommendations = { sales: sales.result, manpower: manpower.result, purchasing: purchasing.result, supplier_draft: supplierDraft(plan, purchasing.result.supplier_note) };
    const saved = await pool.query("UPDATE planning_agent_runs SET status='succeeded', recommendations=$2::jsonb, handoff_trace=$3::jsonb, completed_at=NOW() WHERE id=$1 RETURNING id, import_version, model, status, recommendations, handoff_trace, created_at, completed_at", [runId, JSON.stringify(recommendations), JSON.stringify(trace)]);
    return json(response, 200, { run: saved.rows[0] });
  } catch (error) {
    if (pool && runId) await pool.query("UPDATE planning_agent_runs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1", [runId, error.message]).catch(() => {});
    return json(response, 500, { error: error.message || "Planning agents failed. The numeric plan remains available." });
  }
}

module.exports = handler;
