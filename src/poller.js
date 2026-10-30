// Ciclo di campionamento dei giocatori per TUTTI i giochi del catalogo.
//
// - Un "dispatcher" prende i giochi scaduti dal database (prima i livelli più attivi) e li interroga
//   a velocità limitata (STEAM_REQ_PER_SEC, default 5/s ≈ 430.000 chiamate/giorno).
// - Se Steam risponde 429 (troppo veloce) il ritmo si abbassa da solo e poi risale gradualmente.
// - Poiché i giochi popolari hanno la precedenza, un limite di richieste troppo basso rallenta
//   solo i giochi poco giocati, mai quelli in classifica.
const db = require('./db');
const { fetchCurrentPlayers } = require('./steam-api');
const { recordSnapshot, postpone, st } = require('./data');

const RATE = Number(process.env.STEAM_REQ_PER_SEC) > 0 ? Number(process.env.STEAM_REQ_PER_SEC) : 5;
const MAX_INFLIGHT = Math.max(2, Math.min(16, Math.ceil(RATE)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

const stats = {
  rate_limit_per_sec: RATE,
  slowdown: 1,            // 1 = ritmo pieno; sale se Steam risponde 429
  rate_limited_events: 0,
  errors: 0,
  last_poll_at: null,
  recent: []              // timestamp (ms) delle ultime chiamate riuscite, per calcolare il ritmo reale
};

const dueByTier = db.prepare('SELECT app_id, all_time_peak FROM games WHERE tier = ? AND next_poll_at <= ? ORDER BY next_poll_at LIMIT 200');
const countDue = db.prepare('SELECT COUNT(*) AS n FROM games WHERE next_poll_at <= ?');

const queue = [];
const inflight = new Set();
let pausedUntil = 0;
let backoff = 30000;
let stopped = false;

// Priorità: i livelli più attivi passano per primi, ma 1 prelievo su 4 parte dal livello più lento.
// Senza questa quota, i giochi popolari (che tornano "scaduti" ogni 5 minuti) assorbirebbero tutte le
// richieste e la scansione iniziale o i giochi quasi vuoti non avanzerebbero mai.
let refillCount = 0;
function refill() {
  const now = nowSec();
  const order = (refillCount++ % 4 === 3) ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];
  for (const tier of order) {
    const rows = dueByTier.all(tier, now).filter((r) => !inflight.has(r.app_id));
    if (rows.length) { queue.push(...rows); return; }
  }
}

function noteSuccess() {
  const t = Date.now();
  stats.last_poll_at = Math.floor(t / 1000);
  stats.recent.push(t);
  if (stats.recent.length > 4000) stats.recent.splice(0, stats.recent.length - 3000);
  stats.slowdown = Math.max(1, stats.slowdown * 0.995);
  if (stats.slowdown === 1) backoff = 30000;
}

async function pollGame(row) {
  inflight.add(row.app_id);
  try {
    const players = await fetchCurrentPlayers(row.app_id);
    if (players === null) postpone(row.app_id, 7 * 86400);   // nessun dato pubblico per questo App ID
    else recordSnapshot(row.app_id, row.all_time_peak, players, nowSec());
    noteSuccess();
  } catch (err) {
    stats.errors++;
    if (err.status === 429) {
      stats.rate_limited_events++;
      stats.slowdown = Math.min(8, stats.slowdown * 1.6);
      pausedUntil = Date.now() + backoff;
      backoff = Math.min(backoff * 2, 15 * 60 * 1000);
      console.warn(`[poller] Steam ha risposto 429: pausa ${Math.round((pausedUntil - Date.now()) / 1000)}s e ritmo ridotto (x${stats.slowdown.toFixed(1)})`);
    } else {
      postpone(row.app_id, err.status && err.status < 500 ? 86400 : 600);
    }
  } finally {
    inflight.delete(row.app_id);
  }
}

async function loop() {
  while (!stopped) {
    if (Date.now() < pausedUntil) { await sleep(1000); continue; }
    if (!queue.length) {
      refill();
      if (!queue.length) { await sleep(2000); continue; }
    }
    if (inflight.size >= MAX_INFLIGHT) { await sleep(10); continue; }
    pollGame(queue.shift()).catch((err) => console.error('[poller] errore inatteso:', err.message));
    await sleep((1000 / RATE) * stats.slowdown);
  }
}

// Misura subito un solo gioco (usato quando qualcuno apre la pagina di un gioco poco aggiornato).
async function pollNow(appId) {
  const row = st.getGame.get(appId);
  if (!row) return null;
  const players = await fetchCurrentPlayers(appId);
  if (players === null) return null;
  recordSnapshot(appId, row.all_time_peak, players, nowSec());
  return players;
}

function pollRate() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  const n = stats.recent.filter((t) => t >= cutoff).length;
  return { per_minute: Math.round(n / 5) };
}

function snapshotStats() {
  return {
    ...stats, recent: undefined,
    due_now: countDue.get(nowSec()).n,
    queue_length: queue.length,
    polls_per_minute: pollRate().per_minute,
    throttled: Date.now() < pausedUntil
  };
}

const start = () => { stopped = false; loop(); };
const stop = () => { stopped = true; };

module.exports = { start, stop, pollNow, snapshotStats };
