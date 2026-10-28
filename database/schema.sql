-- Initial PostgreSQL data model for the Kitchen Planner.
-- Operational tables start empty and are populated only through future imports.

CREATE TABLE IF NOT EXISTS reference_data (
  reference_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('inventory', 'staff', 'leave', 'availability', 'crm_orders')),
  source_file TEXT NOT NULL,
  external_id TEXT,
  source_system TEXT,
  exported_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  content_sha256 TEXT,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  UNIQUE (kind, external_id)
);

CREATE TABLE IF NOT EXISTS inventory_counts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES imports(id),
  ingredient_id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  on_hand NUMERIC NOT NULL CHECK (on_hand >= 0),
  committed NUMERIC NOT NULL CHECK (committed >= 0),
  pack_size NUMERIC NOT NULL CHECK (pack_size > 0),
  pack_name TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL,
  UNIQUE (import_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS staff (
  staff_id TEXT PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES imports(id),
  name TEXT NOT NULL,
  employment_type TEXT NOT NULL,
  role TEXT NOT NULL,
  skills JSONB NOT NULL DEFAULT '[]'::JSONB
);

CREATE TABLE IF NOT EXISTS leave_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES imports(id),
  external_id TEXT NOT NULL,
  staff_id TEXT NOT NULL REFERENCES staff(staff_id),
  leave_date DATE NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  UNIQUE (import_id, external_id)
);

CREATE TABLE IF NOT EXISTS availability (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES imports(id),
  staff_id TEXT NOT NULL REFERENCES staff(staff_id),
  shift_date DATE NOT NULL,
  starts_at TIME NOT NULL,
  ends_at TIME NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (import_id, staff_id, shift_date, starts_at, ends_at)
);

CREATE TABLE IF NOT EXISTS crm_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id BIGINT NOT NULL REFERENCES imports(id),
  external_order_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  customer TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  UNIQUE (import_id, external_order_id)
);

CREATE TABLE IF NOT EXISTS planning_agent_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_version TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  recommendations JSONB,
  handoff_trace JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
