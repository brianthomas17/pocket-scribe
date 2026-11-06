-- Every table in schema.json lives in `records`, one row per record, with its
-- fields as JSON keyed by the field names schema.json uses. Adding a field or
-- a tracker is a schema.json edit, never a migration.

CREATE TABLE records (
  -- Airtable's id when imported (so Capture Log references stay valid),
  -- otherwise 'rec' + 14 random characters, the same shape.
  id          TEXT PRIMARY KEY,
  table_key   TEXT NOT NULL,
  fields      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
  -- YYYY-MM-DD from the table's date field, pulled out so "this day" and
  -- "one journal row per day" are index lookups rather than JSON scans.
  entry_date  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX records_by_table_created ON records (table_key, created_at);
CREATE INDEX records_by_table_date    ON records (table_key, entry_date);

-- Every change to every record, by anyone. Nothing typed or corrected is
-- lost, and a field can be put back to any earlier value.
CREATE TABLE edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id   TEXT NOT NULL,
  table_key   TEXT NOT NULL,
  -- '(created)' for the creation itself, with the whole record in `after`.
  field       TEXT NOT NULL,
  before      TEXT,
  after       TEXT,
  -- 'system' (the Worker), 'you' (the app), 'import' (the Airtable copy)
  by          TEXT NOT NULL,
  at          TEXT NOT NULL
);

CREATE INDEX edits_by_record ON edits (record_id, at);
