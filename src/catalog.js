// Catalogo: l'elenco di tutti i giochi Steam (App ID + nome). Scaricato da Steam all'avvio e poi ogni giorno,
// così la ricerca per nome funziona su tutto il catalogo senza chiamare Steam a ogni ricerca.
const db = require('./db');
const { fetchAppList } = require('./steam-api');
const SEED_GAMES = require('./games-config');

const upsert = db.prepare(`
  INSERT INTO games (app_id, name) VALUES (?, ?)
  ON CONFLICT(app_id) DO UPDATE SET name = CASE WHEN games.details_ok = 1 THEN games.name ELSE excluded.name END`);
const seedInsert = db.prepare('INSERT OR IGNORE INTO games (app_id, name, tier, next_poll_at) VALUES (?, ?, 4, 0)');
const seedBoost = db.prepare('UPDATE games SET tier = 4, next_poll_at = 0 WHERE app_id = ? AND current_players IS NULL');

// I giochi più noti vengono misurati per primi, così la homepage si riempie subito.
function seedPriority() {
  db.exec('BEGIN');
  for (const g of SEED_GAMES) { seedInsert.run(g.app_id, g.name); seedBoost.run(g.app_id); }
  db.exec('COMMIT');
}

async function syncCatalog() {
  const key = process.env.STEAM_API_KEY || '';
  const { apps, filtered } = await fetchAppList(key);
  if (!apps.length) throw new Error('Steam ha restituito un catalogo vuoto');
  db.exec('BEGIN');
  try { for (const a of apps) upsert.run(a.app_id, a.name); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  db.meta.set('catalog_synced_at', Math.floor(Date.now() / 1000));
  db.meta.set('catalog_filtered', filtered ? '1' : '0');
  console.log(`[catalogo] ${apps.length.toLocaleString('en-US')} giochi importati${filtered ? '' : ' (senza STEAM_API_KEY: elenco non filtrato, include anche DLC/software)'}`);
  return apps.length;
}

// Sincronizza se non è mai stato fatto o se è vecchio di più di 24 ore; in caso di errore riprova dopo 15 minuti.
async function ensureCatalog() {
  const last = Number(db.meta.get('catalog_synced_at')) || 0;
  if (Date.now() / 1000 - last < 20 * 3600) return;
  try { await syncCatalog(); }
  catch (err) {
    console.error(`[catalogo] sincronizzazione fallita: ${err.message} — riprovo tra 15 minuti`);
    setTimeout(ensureCatalog, 15 * 60 * 1000).unref();
  }
}

module.exports = { seedPriority, ensureCatalog, syncCatalog };
