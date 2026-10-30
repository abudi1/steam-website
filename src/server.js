require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { startTracking } = require('./tracker');
const poller = require('./poller');
const { fetchDetailsNow, onboardGame } = require('./details');
const { searchStoreByName, reviewsBlocked } = require('./steam-api');
const { RAW_DAYS } = require('./maintenance');
const { TIERS } = require('./data');

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3001;

// Un errore imprevisto in un lavoro in background non deve spegnere il sito.
process.on('unhandledRejection', (err) => console.error('[errore non gestito]', err && err.message ? err.message : err));
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- Query ----------

const esc = (t) => t.replace(/[\\%_]/g, '\\$&');
const q = {
  game: db.prepare('SELECT * FROM games WHERE app_id = ?'),
  peakSince: db.prepare('SELECT players, ts FROM player_snapshots WHERE app_id = ? AND ts >= ? ORDER BY players DESC, ts DESC LIMIT 1'),
  avg: db.prepare('SELECT AVG(players) AS avg FROM player_snapshots WHERE app_id = ? AND ts >= ? AND ts < ?'),
  search: db.prepare(`
    SELECT * FROM games WHERE name LIKE ? ESCAPE '\\'
    ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, COALESCE(current_players, -1) DESC, length(name)
    LIMIT ?`),
  trending: db.prepare('SELECT * FROM games WHERE trend_pct IS NOT NULL AND current_players >= 1000 ORDER BY trend_pct DESC LIMIT 5'),
  mostPlayed: db.prepare('SELECT * FROM games WHERE all_time_peak IS NOT NULL AND all_time_peak > 0 ORDER BY all_time_peak DESC LIMIT 10'),
  topNow: (n, excludeIds) => db.prepare(
    `SELECT * FROM games WHERE current_players IS NOT NULL ${excludeIds.length ? `AND app_id NOT IN (${excludeIds.map(() => '?').join(',')})` : ''}
     ORDER BY current_players DESC LIMIT ?`).all(...excludeIds, n),
  countAll: db.prepare('SELECT COUNT(*) AS n FROM games'),
  // "Misurato" = ha un valore, oppure Steam non ha dati per quell'App ID (rimandato di giorni): altrimenti la barra non arriva mai al 100%.
  countMeasured: db.prepare('SELECT COUNT(*) AS n FROM games WHERE current_players IS NOT NULL OR next_poll_at > ?'),
  countActive: db.prepare('SELECT COUNT(*) AS n FROM games WHERE current_players >= 1'),
  tierCounts: db.prepare('SELECT tier, COUNT(*) AS n FROM games WHERE current_players IS NOT NULL GROUP BY tier'),
  samples: db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'player_snapshots'")
};

function buildGameStats(game) {
  const now = nowSec();
  const id = game.app_id;
  const peak24 = q.peakSince.get(id, now - DAY) ?? null;
  const peak7 = q.peakSince.get(id, now - 7 * DAY) ?? null;
  const peak30 = q.peakSince.get(id, now - 30 * DAY) ?? null;
  const avg30 = q.avg.get(id, now - 30 * DAY, now + 1)?.avg ?? null;

  let trendPct = null;
  if (game.tracked_since !== null && game.tracked_since <= now - DAY) {
    const last24 = q.avg.get(id, now - DAY, now + 1)?.avg ?? null;
    const prev24 = q.avg.get(id, now - 2 * DAY, now - DAY)?.avg ?? null;
    if (last24 !== null && prev24 !== null && prev24 > 0) trendPct = Number((((last24 - prev24) / prev24) * 100).toFixed(1));
  }

  return {
    app_id: id, name: game.name, header_image: game.header_image, genres: game.genres,
    price_cents: game.price_cents, price_initial_cents: game.price_initial_cents, discount_percent: game.discount_percent,
    price_currency: game.price_currency, release_date: game.release_date,
    review_score: game.review_score, review_desc: game.review_desc, total_reviews: game.total_reviews,
    developers: game.developers, publishers: game.publishers, platforms: game.platforms, languages_count: game.languages_count,
    current_players: game.current_players, last_updated: game.last_ts,
    peak_24h: peak24?.players ?? null, peak_24h_at: peak24?.ts ?? null,
    peak_7d: peak7?.players ?? null, peak_30d: peak30?.players ?? null,
    avg_30d: avg30 !== null ? Math.round(avg30) : null,
    all_time_peak: game.all_time_peak, all_time_peak_at: game.all_time_peak_ts,
    tracked_since: game.tracked_since, trend_pct: trendPct
  };
}

// Versione leggera per elenchi di risultati (nessuna query sullo storico).
const liteGame = (g) => ({
  app_id: g.app_id, name: g.name, header_image: g.header_image, genres: g.genres,
  release_date: g.release_date, current_players: g.current_players
});

// Piccola cache: la homepage non deve ricalcolare le classifiche a ogni visita.
function cached(ms, fn) {
  let at = 0, value;
  return () => { if (Date.now() - at > ms) { value = fn(); at = Date.now(); } return value; };
}

// Limite alle chiamate a Steam innescate dai visitatori (aperture di giochi non misurati, ricerche nuove):
// 30 al minuto per indirizzo IP, così nessuno può esaurire la quota di Steam del server.
const lookups = new Map();
let globalLookups = [];
function allowLookup(ip) {
  const now = Date.now();
  // Tetto totale (120/min per tutti): l'indirizzo IP dietro a un proxy può essere falsificato, il totale no.
  globalLookups = globalLookups.filter((t) => now - t < 60000);
  if (globalLookups.length >= 120) return false;
  const recent = (lookups.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= 30) { lookups.set(ip, recent); return false; }
  recent.push(now); lookups.set(ip, recent); globalLookups.push(now);
  return true;
}
setInterval(() => { const c = Date.now() - 60000; for (const [ip, a] of lookups) if (!a.some((t) => t > c)) lookups.delete(ip); }, 5 * 60 * 1000).unref();

const parseAppId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null; };
class LookupLimit extends Error {}

// Restituisce il gioco aggiornato: se non è nel database lo aggiunge; se non è stato misurato di recente
// (o non ha i dati store) li scarica subito, così la pagina non mostra mai numeri vecchi di giorni.
async function loadGame(appId, ip, fallbackName) {
  let game = q.game.get(appId);
  if (!game) {
    if (!allowLookup(ip)) throw new LookupLimit();
    return (await onboardGame(appId, fallbackName)) ? q.game.get(appId) : null;
  }
  const now = nowSec();
  const stale = game.current_players === null || (game.last_ts ?? 0) < now - 900;
  const needDetails = !game.details_at || (!game.details_ok && game.details_at < now - DAY) || (game.details_ok && !game.review_desc && game.details_at < now - 600);
  if ((stale || needDetails) && allowLookup(ip)) {
    await Promise.allSettled([stale ? poller.pollNow(appId) : null, needDetails ? fetchDetailsNow(appId) : null]);
    game = q.game.get(appId);
  }
  return game;
}

const handleError = (res, tag) => (err) => {
  if (err instanceof LookupLimit) return res.status(429).json({ error: 'Too many lookups — wait a minute and retry' });
  console.error(`[${tag}]`, err.message);
  res.status(502).json({ error: 'Steam did not respond, try again shortly' });
};

// ---------- API ----------

const getStatus = cached(15000, () => {
  const total = q.countAll.get().n;
  const measured = q.countMeasured.get(nowSec() + 3 * DAY).n;
  const tiers = Object.fromEntries(q.tierCounts.all().map((r) => [r.tier, r.n]));
  const p = poller.snapshotStats();
  return {
    games_total: total,
    games_measured: measured,
    games_active: q.countActive.get().n,
    tiers: { hot: tiers[4] ?? 0, warm: tiers[3] ?? 0, mid: tiers[2] ?? 0, low: tiers[1] ?? 0, idle: tiers[0] ?? 0 },
    scan_progress: total ? Number((measured / total).toFixed(4)) : 0,
    samples_recorded: q.samples.get()?.seq ?? 0,
    tracking_since: Number(db.meta.get('started_at')) || null,
    catalog_synced_at: Number(db.meta.get('catalog_synced_at')) || null,
    catalog_filtered: db.meta.get('catalog_filtered') === '1',
    last_poll: p.last_poll_at,
    polls_per_minute: p.polls_per_minute,
    due_now: p.due_now,
    throttled: p.throttled,
    reviews_blocked: reviewsBlocked(),
    rate_limited_events: p.rate_limited_events,
    rate_limit_per_sec: p.rate_limit_per_sec,
    tier_intervals_minutes: Object.fromEntries(TIERS.map((t) => [t.min, Math.round(t.every / 60)]))
  };
});
app.get('/api/status', (req, res) => res.json(getStatus()));

// Trending: maggiore variazione % nelle ultime 24h tra i giochi con almeno 1.000 giocatori.
// Finché non c'è abbastanza storico, i posti liberi si riempiono con i più giocati ora (filled: true).
const getTrending = cached(30000, () => {
  const picked = q.trending.all().map((g) => ({ ...buildGameStats(g), filled: false }));
  if (picked.length < 5) {
    const fill = q.topNow(5 - picked.length, picked.map((g) => g.app_id));
    picked.push(...fill.map((g) => ({ ...buildGameStats(g), filled: true })));
  }
  return picked;
});
app.get('/api/trending', (req, res) => res.json(getTrending()));

const getMostPlayed = cached(30000, () => q.mostPlayed.all().map(buildGameStats));
app.get('/api/most-played', (req, res) => res.json(getMostPlayed()));

// Classifiche complete con filtro per genere. type: now (giocatori ora), trend (variazione 24h), peak (picco registrato).
const RANK_ORDER = {
  now: { where: 'current_players IS NOT NULL AND current_players > 0', order: 'current_players DESC' },
  trend: { where: 'trend_pct IS NOT NULL AND current_players >= 100', order: 'trend_pct DESC' },
  peak: { where: 'all_time_peak IS NOT NULL AND all_time_peak > 0', order: 'all_time_peak DESC' }
};
const rankCache = new Map();
app.get('/api/rankings', (req, res) => {
  const type = RANK_ORDER[req.query.type] ? req.query.type : 'now';
  const genre = String(req.query.genre || '').slice(0, 40);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const key = `${type}|${genre}|${limit}`;
  const hit = rankCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return res.json(hit.rows);
  const r = RANK_ORDER[type];
  const sql = `SELECT * FROM games WHERE ${r.where}${genre ? " AND (', ' || genres || ', ') LIKE '%, ' || ? || ', %'" : ''} ORDER BY ${r.order} LIMIT ?`;
  const rows = db.prepare(sql).all(...(genre ? [genre, limit] : [limit])).map((g) => ({
    app_id: g.app_id, name: g.name, header_image: g.header_image, genres: g.genres,
    current_players: g.current_players, all_time_peak: g.all_time_peak, all_time_peak_at: g.all_time_peak_ts,
    trend_pct: g.trend_pct, price_cents: g.price_cents, price_currency: g.price_currency
  }));
  if (rankCache.size > 200) rankCache.clear();
  rankCache.set(key, { at: Date.now(), rows });
  res.json(rows);
});

const getGenres = cached(300000, () => {
  const counts = new Map();
  for (const { genres } of db.prepare('SELECT genres FROM games WHERE genres IS NOT NULL AND current_players > 0').all()) {
    for (const g of genres.split(',')) { const t = g.trim(); if (t) counts.set(t, (counts.get(t) || 0) + 1); }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name]) => name);
});
app.get('/api/genres', (req, res) => res.json(getGenres()));

// Suggerimenti mentre si scrive (solo catalogo locale, nessuna chiamata a Steam).
app.get('/api/suggest', (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json([]);
  const rows = /^\d+$/.test(term)
    ? [q.game.get(Number(term))].filter(Boolean)
    : q.search.all(`%${esc(term)}%`, `${esc(term)}%`, 8);
  res.json(rows.map((g) => ({ app_id: g.app_id, name: g.name })));
});

// Ricerca per App ID o per nome su tutto il catalogo. Se il catalogo non ha risultati (gioco appena uscito)
// prova lo store di Steam e aggiunge il gioco.
app.get('/api/search', async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json([]);
  try {
    if (/^\d+$/.test(term)) {
      const id = parseAppId(term);
      const game = id ? await loadGame(id, req.ip) : null;
      return res.json(game ? [liteGame(game)] : []);
    }
    const local = q.search.all(`%${esc(term)}%`, `${esc(term)}%`, 30);
    if (local.length) return res.json(local.map(liteGame));
    if (!allowLookup(req.ip)) throw new LookupLimit();
    const found = await searchStoreByName(term);
    const out = [];
    for (const item of found.slice(0, 5)) {
      const game = await loadGame(item.app_id, req.ip, item.name);
      if (game) out.push(liteGame(game));
    }
    res.json(out);
  } catch (err) { handleError(res, 'search')(err); }
});

app.get('/api/game/:appId', async (req, res) => {
  const id = parseAppId(req.params.appId);
  if (!id) return res.status(400).json({ error: 'Invalid App ID' });
  try {
    const game = await loadGame(id, req.ip);
    if (!game) return res.status(404).json({ error: 'Game not found on Steam' });
    res.json(buildGameStats(game));
  } catch (err) { handleError(res, 'game')(err); }
});

// Storico per il grafico. 24h/7d/30d: campioni grezzi raggruppati (massimo per intervallo, così i picchi non
// spariscono). 1y/all su giochi tracciati da più di RAW_DAYS giorni: riepilogo giornaliero.
app.get('/api/game/:appId/history', (req, res) => {
  const id = parseAppId(req.params.appId);
  if (!id) return res.status(400).json({ error: 'Invalid App ID' });
  const range = req.query.range || '24h';
  const spans = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '1y': 365 * DAY, all: null };
  if (!(range in spans)) return res.status(400).json({ error: 'Invalid range' });

  const now = nowSec();
  const first = q.game.get(id)?.tracked_since ?? now;
  const since = spans[range] === null ? 0 : now - spans[range];

  if ((range === '1y' || range === 'all') && now - first > RAW_DAYS * DAY) {
    // Giorni già riassunti dalla tabella daily; dall'ultimo giorno riassunto in poi i campioni grezzi
    // (così "ieri" non sparisce nelle ore prima del riepilogo notturno).
    const lastDaily = db.prepare('SELECT MAX(day) AS d FROM player_daily WHERE app_id = ?').get(id)?.d;
    const rawFromDay = lastDaily === null || lastDaily === undefined ? Math.floor(now / DAY) : lastDaily + 1;
    const points = db.prepare(`
      SELECT day * ${DAY} AS ts, peak AS players FROM player_daily WHERE app_id = ? AND day >= ? AND day < ?
      UNION ALL
      SELECT (ts / ${DAY}) * ${DAY}, MAX(players) FROM player_snapshots WHERE app_id = ? AND ts >= ? GROUP BY ts / ${DAY}
      ORDER BY ts`).all(id, Math.floor(since / DAY), rawFromDay, id, Math.max(since, rawFromDay * DAY));
    return res.json({ app_id: id, range, points });
  }

  const span = Math.max(now - Math.max(since, first), 1);
  const bucket = Math.max(300, Math.ceil(span / 400 / 300) * 300);
  const points = db.prepare(`
    SELECT (ts / ?) * ? AS ts, MAX(players) AS players FROM player_snapshots
    WHERE app_id = ? AND ts >= ? GROUP BY ts / ? ORDER BY ts`).all(bucket, bucket, id, since, bucket);
  res.json({ app_id: id, range, points });
});

// Download CSV dello storico (campioni grezzi dove ci sono, altrimenti un picco al giorno).
app.get('/api/game/:appId/export.csv', (req, res) => {
  const id = parseAppId(req.params.appId);
  const game = id ? q.game.get(id) : null;
  if (!game) return res.status(404).json({ error: 'Game not found' });
  const range = req.query.range || '30d';
  const spans = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '1y': 365 * DAY, all: null };
  if (!(range in spans)) return res.status(400).json({ error: 'Invalid range' });
  const now = nowSec();
  const since = spans[range] === null ? 0 : now - spans[range];
  const rawFrom = Math.max(since, Math.floor((now - RAW_DAYS * DAY) / DAY) * DAY);
  const daily = db.prepare('SELECT day * ? AS ts, peak AS players FROM player_daily WHERE app_id = ? AND day >= ? AND day * ? < ? ORDER BY day')
    .all(DAY, id, Math.floor(since / DAY), DAY, rawFrom).map((r) => ({ ...r, kind: 'daily_peak' }));
  const raw = db.prepare('SELECT ts, players FROM player_snapshots WHERE app_id = ? AND ts >= ? ORDER BY ts')
    .all(id, since).map((r) => ({ ...r, kind: 'sample' }));
  const lines = ['timestamp_utc,players,type'];
  for (const r of [...daily, ...raw]) lines.push(`${new Date(r.ts * 1000).toISOString()},${r.players},${r.kind}`);
  const slug = String(game.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="playcount_${id}_${slug}_${range}.csv"` });
  res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
});

app.get('/api/compare', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(parseAppId).filter(Boolean).slice(0, 4);
  if (ids.length < 2) return res.status(400).json({ error: 'Need at least 2 app ids, e.g. ?ids=730,570' });
  try {
    const out = [];
    for (const id of ids) { const g = await loadGame(id, req.ip); if (g) out.push(buildGameStats(g)); }
    res.json(out);
  } catch (err) { handleError(res, 'compare')(err); }
});

// ---------- Avvio: sito + API + tracker nello stesso processo ----------

const server = app.listen(PORT, () => {
  console.log(`[server] sito pronto su http://localhost:${PORT}`);
  if (!process.env.STEAM_API_KEY) {
    console.log('[server] STEAM_API_KEY non impostata: il catalogo sarà quello non filtrato (include DLC/software). Vedi README.');
  }
  startTracking();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[server] La porta ${PORT} è già occupata: il server è probabilmente già acceso in un altro terminale.`);
    console.error('        Chiudilo (Ctrl+C) e riprova, oppure cambia PORT nel file .env.\n');
    process.exit(1);
  }
  throw err;
});
