const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, '..', 'data.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    app_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    header_image TEXT,
    genres TEXT,
    price_cents INTEGER,
    price_currency TEXT,
    release_date TEXT,
    review_score INTEGER,
    review_desc TEXT,
    updated_at TEXT
  );

  -- Campioni grezzi (uno ogni N minuti a seconda dell'attività del gioco). Conservati RAW_DAYS giorni.
  CREATE TABLE IF NOT EXISTS player_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    players INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_app_ts ON player_snapshots (app_id, ts);

  -- Riepilogo giornaliero (picco e media), conservato per sempre: tiene il database piccolo.
  CREATE TABLE IF NOT EXISTS player_daily (
    app_id INTEGER NOT NULL,
    day INTEGER NOT NULL,          -- giorni dall'epoca (UTC)
    peak INTEGER NOT NULL,
    avg INTEGER NOT NULL,
    PRIMARY KEY (app_id, day)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Migrazione idempotente: aggiunge le colonne nuove anche a un data.sqlite creato da versioni precedenti.
const have = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
const columns = {
  price_initial_cents: 'INTEGER', discount_percent: 'INTEGER', total_reviews: 'INTEGER',
  developers: 'TEXT', publishers: 'TEXT', platforms: 'TEXT', languages_count: 'INTEGER',
  // stato di tracking (aggiornato a ogni campione, così le classifiche non scansionano lo storico)
  current_players: 'INTEGER', last_ts: 'INTEGER', all_time_peak: 'INTEGER', all_time_peak_ts: 'INTEGER',
  tracked_since: 'INTEGER', tier: 'INTEGER DEFAULT 0', next_poll_at: 'INTEGER DEFAULT 0', trend_pct: 'REAL',
  // dati store: details_at = quando sono stati scaricati, details_ok = 1 se Steam ha una pagina store
  details_at: 'INTEGER', details_ok: 'INTEGER DEFAULT 0'
};
const addedState = !have.has('current_players');
for (const [col, type] of Object.entries(columns)) {
  if (!have.has(col)) db.exec(`ALTER TABLE games ADD COLUMN ${col} ${type};`);
}

if (addedState) {
  // Chi arriva da una versione precedente: ricostruisce lo stato dai campioni già raccolti.
  db.exec(`
    UPDATE games SET
      current_players = (SELECT players FROM player_snapshots s WHERE s.app_id = games.app_id ORDER BY ts DESC LIMIT 1),
      last_ts = (SELECT MAX(ts) FROM player_snapshots s WHERE s.app_id = games.app_id),
      all_time_peak = (SELECT MAX(players) FROM player_snapshots s WHERE s.app_id = games.app_id),
      all_time_peak_ts = (SELECT ts FROM player_snapshots s WHERE s.app_id = games.app_id ORDER BY players DESC, ts DESC LIMIT 1),
      tracked_since = (SELECT MIN(ts) FROM player_snapshots s WHERE s.app_id = games.app_id),
      tier = 4, next_poll_at = 0
    WHERE app_id IN (SELECT DISTINCT app_id FROM player_snapshots);
    UPDATE games SET details_at = CAST(strftime('%s', updated_at) AS INTEGER), details_ok = 1
    WHERE header_image IS NOT NULL AND updated_at IS NOT NULL;
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_games_due ON games (tier, next_poll_at);
  CREATE INDEX IF NOT EXISTS idx_games_players ON games (current_players);
  CREATE INDEX IF NOT EXISTS idx_games_peak ON games (all_time_peak);
`);

const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
const metaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
db.meta = {
  get: (k) => metaGet.get(k)?.value ?? null,
  set: (k, v) => metaSet.run(k, String(v))
};
if (!db.meta.get('started_at')) db.meta.set('started_at', Math.floor(Date.now() / 1000));

module.exports = db;
