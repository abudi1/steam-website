// Scritture condivise sul database + logica dei "livelli" di polling.
//
// Ogni gioco viene ricampionato con una frequenza che dipende da quanti giocatori ha:
// i giochi affollati cambiano in fretta e interessano a tutti, quelli quasi vuoti no.
// È l'unico modo realistico di seguire l'intero catalogo (~100.000+ giochi) con una chiamata per gioco.
const db = require('./db');
const { countLanguages } = require('./steam-api');

const TIERS = [
  { min: 1000, tier: 4, every: 5 * 60 },        // ≥1.000 giocatori: ogni 5 minuti
  { min: 100, tier: 3, every: 30 * 60 },        // ≥100: ogni 30 minuti
  { min: 10, tier: 2, every: 3 * 3600 },        // ≥10: ogni 3 ore
  { min: 1, tier: 1, every: 12 * 3600 },        // ≥1: ogni 12 ore
  { min: 0, tier: 0, every: 48 * 3600 }         // vuoti: ogni 2 giorni
];
const SCALE = Number(process.env.POLL_SCALE) > 0 ? Number(process.env.POLL_SCALE) : 1; // solo per i test
const tierFor = (players) => TIERS.find((t) => players >= t.min);

const st = {
  insertSnap: db.prepare('INSERT INTO player_snapshots (app_id, ts, players) VALUES (?, ?, ?)'),
  updatePoll: db.prepare(`
    UPDATE games SET
      current_players = ?, last_ts = ?, tier = ?, next_poll_at = ?,
      tracked_since = COALESCE(tracked_since, ?),
      all_time_peak_ts = CASE WHEN ? > COALESCE(all_time_peak, -1) THEN ? ELSE all_time_peak_ts END,
      all_time_peak = CASE WHEN ? > COALESCE(all_time_peak, -1) THEN ? ELSE all_time_peak END
    WHERE app_id = ?`),
  postpone: db.prepare('UPDATE games SET next_poll_at = ? WHERE app_id = ?'),
  insertGame: db.prepare('INSERT OR IGNORE INTO games (app_id, name) VALUES (?, ?)'),
  getGame: db.prepare('SELECT * FROM games WHERE app_id = ?'),
  saveDetails: db.prepare(`
    UPDATE games SET
      name = COALESCE(?, name), header_image = COALESCE(?, header_image), genres = COALESCE(?, genres),
      price_cents = COALESCE(?, price_cents), price_currency = COALESCE(?, price_currency),
      release_date = COALESCE(?, release_date), review_score = COALESCE(?, review_score),
      review_desc = COALESCE(?, review_desc), price_initial_cents = COALESCE(?, price_initial_cents),
      discount_percent = COALESCE(?, discount_percent), total_reviews = COALESCE(?, total_reviews),
      developers = COALESCE(?, developers), publishers = COALESCE(?, publishers),
      platforms = COALESCE(?, platforms), languages_count = COALESCE(?, languages_count),
      updated_at = ?, details_at = ?, details_ok = CASE WHEN ? THEN 1 ELSE details_ok END
    WHERE app_id = ?`)
};

// Registra un campione e riprogramma il prossimo in base al livello.
// I giochi che non hanno mai avuto giocatori non scrivono righe (sarebbero solo zeri).
function recordSnapshot(appId, previousPeak, players, ts) {
  const t = tierFor(players);
  if (players > 0 || (previousPeak ?? 0) > 0) st.insertSnap.run(appId, ts, players);
  const nextAt = ts + Math.round(t.every * SCALE * (1 + Math.random() * 0.1));
  st.updatePoll.run(players, ts, t.tier, nextAt, ts, players, ts, players, players, appId);
}

// Steam non ha dati per quell'App ID (o la chiamata è fallita): riprova più tardi.
function postpone(appId, seconds) {
  st.postpone.run(Math.floor(Date.now() / 1000) + seconds, appId);
}

function saveStoreData(appId, store, reviews) {
  const now = Math.floor(Date.now() / 1000);
  const ok = !!store;
  st.saveDetails.run(
    store?.name ?? null,
    store?.header_image ?? null,
    store?.genres ? store.genres.map((g) => g.description).join(', ') : null,
    ok ? (store.is_free ? 0 : (store.price_overview?.final ?? null)) : null,
    store?.price_overview?.currency ?? null,
    store?.release_date?.date ?? null,
    reviews?.review_score ?? null,
    reviews?.review_score_desc ?? null,
    ok ? (store.is_free ? 0 : (store.price_overview?.initial ?? null)) : null,
    ok ? (store.price_overview?.discount_percent ?? 0) : null,
    reviews?.total_reviews ?? null,
    store?.developers?.length ? store.developers.join(', ') : null,
    store?.publishers?.length ? (store.publishers.filter(Boolean).join(', ') || null) : null,
    store?.platforms ? Object.entries(store.platforms).filter(([, v]) => v).map(([k]) => k).join(', ') : null,
    countLanguages(store?.supported_languages),
    new Date().toISOString(), now, ok ? 1 : 0,
    appId
  );
}

module.exports = { TIERS, tierFor, recordSnapshot, postpone, saveStoreData, st };
