// Dati dello store (immagine, prezzo, recensioni...). Steam limita molto questo endpoint (~1 richiesta/secondo),
// quindi un worker lento li scarica per i giochi più giocati per primi; per gli altri arrivano
// quando qualcuno apre la pagina del gioco.
const db = require('./db');
const { fetchStoreDetails, fetchReviewScore, fetchCurrentPlayers } = require('./steam-api');
const { saveStoreData, recordSnapshot, st } = require('./data');

const INTERVAL_MS = Number(process.env.DETAILS_INTERVAL_MS) > 0 ? Number(process.env.DETAILS_INTERVAL_MS) : 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nextNew = db.prepare('SELECT app_id FROM games WHERE details_at IS NULL AND current_players >= 1 ORDER BY current_players DESC LIMIT 1');
const nextStale = db.prepare('SELECT app_id FROM games WHERE details_ok = 1 AND details_at < ? AND current_players >= 100 ORDER BY details_at LIMIT 1');
// Recensioni mancanti (la richiesta può essere fallita): riprova dopo un'ora, partendo dai giochi più giocati.
const nextNoReviews = db.prepare('SELECT app_id FROM games WHERE details_ok = 1 AND review_desc IS NULL AND details_at < ? AND current_players >= 1 ORDER BY current_players DESC LIMIT 1');

const markDetailsTried = db.prepare('UPDATE games SET details_at = ? WHERE app_id = ?');

async function fetchDetailsNow(appId) {
  const [store, reviews] = await Promise.all([fetchStoreDetails(appId), fetchReviewScore(appId)]);
  saveStoreData(appId, store, reviews);
  return !!store;
}

// Primo inserimento di un gioco che non è nel catalogo (es. appena uscito). false se l'App ID non esiste.
async function onboardGame(appId, fallbackName) {
  const [players, store, reviews] = await Promise.all([
    fetchCurrentPlayers(appId).catch(() => null),
    fetchStoreDetails(appId).catch(() => null),
    fetchReviewScore(appId)
  ]);
  if (!store && !players) return false;
  st.insertGame.run(appId, store?.name ?? fallbackName ?? `App ${appId}`);
  saveStoreData(appId, store, reviews);
  if (typeof players === 'number') recordSnapshot(appId, null, players, Math.floor(Date.now() / 1000));
  return true;
}

let stopped = false;
async function loop() {
  let wait = INTERVAL_MS;
  while (!stopped) {
    await sleep(wait);
    wait = INTERVAL_MS;
    let row = null;
    try {
      row = nextNew.get() ?? nextNoReviews.get(Math.floor(Date.now() / 1000) - 3600) ?? nextStale.get(Math.floor(Date.now() / 1000) - 24 * 3600);
      if (!row) { wait = 10000; continue; }
      await fetchDetailsNow(row.app_id);
    } catch (err) {
      if (err.status === 429) { wait = 60000; console.warn('[dettagli] Steam ha risposto 429: pausa di 60s'); }
      else {
        wait = INTERVAL_MS * 2;
        // Un gioco che dà sempre errore non deve bloccare la coda: lo segna come "provato adesso" e passa al prossimo.
        if (row) markDetailsTried.run(Math.floor(Date.now() / 1000), row.app_id);
      }
    }
  }
}

module.exports = { start: () => { stopped = false; loop(); }, stop: () => { stopped = true; }, fetchDetailsNow, onboardGame };
