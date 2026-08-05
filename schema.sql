-- Suppression list for operator outreach.
--
-- Deliberately holds nothing but the address, when it was suppressed, and
-- where the opt-out came from. No IP, no user agent, no referrer.

CREATE TABLE IF NOT EXISTS suppressions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,  -- normalized: trimmed + lowercased
  suppressed_at TEXT NOT NULL,         -- ISO 8601 UTC
  source        TEXT NOT NULL          -- 'operator-outreach'
);

-- The API returns the list in suppression order.
CREATE INDEX IF NOT EXISTS idx_suppressions_suppressed_at
  ON suppressions (suppressed_at);
