CREATE TABLE IF NOT EXISTS days (
  symbol TEXT NOT NULL, date TEXT NOT NULL,          -- date = New York session date
  orb_h REAL, orb_l REAL, range_pct REAL,
  status TEXT,                                       -- traded | no setup | skipped: ... | waiting
  pdh REAL, pdl REAL,
  filtered TEXT,                                     -- JSON: signals blocked by VWAP / PDH-PDL / max trades
  updated_at INTEGER,
  PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, symbol TEXT NOT NULL, date TEXT NOT NULL,
  dir INTEGER, signal_t INTEGER, entry_t INTEGER,
  entry REAL, fill REAL, sl REAL, tp REAL, tp1 REAL, risk REAL,
  status TEXT,                                       -- signal | open | closed
  exit_t INTEGER, exit_px REAL, r_gross REAL, r_net REAL, reason TEXT
);
CREATE INDEX IF NOT EXISTS trades_date ON trades (date);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
