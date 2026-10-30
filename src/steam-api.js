// Chiamate alle API pubbliche di Steam. Usa il fetch integrato in Node (nessuna dipendenza).

const TIMEOUT_MS = 10000;

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} su ${url}`);
    this.status = status;
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Playcount/1.0', Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' }
  });
  // L'URL nell'errore non contiene mai la query string: la API key non finisce nei log.
  if (!res.ok) throw new HttpError(res.status, url.split('?')[0]);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch {
    const title = (text.match(/<title>([^<]*)/i) || [])[1] || text.replace(/\s+/g, ' ').slice(0, 80);
    throw new Error(`risposta non JSON (HTTP ${res.status}, ${res.url.split('?')[0]}): ${title}`);
  }
}

// Giocatori ora. Ritorna null se Steam non ha dati per quell'App ID.
async function fetchCurrentPlayers(appId) {
  const data = await getJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`);
  const n = data?.response?.player_count;
  return typeof n === 'number' ? n : null;
}

async function fetchStoreDetails(appId) {
  const data = await getJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=ch&l=english`);
  const entry = data?.[appId];
  return entry?.success ? entry.data : null;
}

// Se Steam risponde con una pagina HTML invece di JSON (blocco/limite sull'endpoint delle recensioni) smettiamo
// di chiederlo per 30 minuti: insistere peggiora solo il blocco.
let reviewsBlockedUntil = 0;
async function fetchReviewScore(appId) {
  if (Date.now() < reviewsBlockedUntil) return null;
  try {
    const data = await getJson(`https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=1`);
    return data?.query_summary?.review_score_desc ? data.query_summary : null;
  } catch (err) {
    if (/non JSON/.test(err.message) || err.status === 429 || err.status === 403) {
      reviewsBlockedUntil = Date.now() + 30 * 60 * 1000;
      console.warn('[steam] Steam non restituisce le recensioni (risposta HTML o limite): le richieste di recensioni sono sospese per 30 minuti.');
    }
    return null;
  }
}

function countLanguages(html) {
  if (!html) return null;
  const plain = html.split('<br>')[0].replace(/<[^>]+>/g, '');
  return plain.split(',').map((s) => s.trim()).filter(Boolean).length || null;
}

async function searchStoreByName(term) {
  const data = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=ch`);
  return (data?.items ?? []).map((item) => ({ app_id: item.id, name: item.name }));
}

// Catalogo completo dei giochi. Con API key usa IStoreService (solo giochi, a pagine da 50.000);
// senza key ripiega sull'elenco storico non filtrato (include anche DLC e software).
async function fetchAppList(apiKey) {
  const apps = [];
  if (apiKey) {
    let last = 0;
    for (let page = 0; page < 20; page++) {
      const url = 'https://api.steampowered.com/IStoreService/GetAppList/v1/?' + new URLSearchParams({
        key: apiKey, include_games: 'true', include_dlc: 'false', include_software: 'false',
        include_videos: 'false', include_hardware: 'false', max_results: '50000', last_appid: String(last)
      });
      const r = (await getJson(url))?.response;
      const batch = r?.apps ?? [];
      for (const a of batch) if (a.appid && a.name) apps.push({ app_id: a.appid, name: a.name });
      if (!r?.have_more_results || !batch.length) break;
      last = r.last_appid ?? batch[batch.length - 1].appid;
    }
    return { apps, filtered: true };
  }
  const r = await getJson('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
  for (const a of r?.applist?.apps ?? []) {
    if (!a.appid || !a.name || !a.name.trim()) continue;
    if (/\b(soundtrack|dedicated server)\b/i.test(a.name)) continue;
    apps.push({ app_id: a.appid, name: a.name });
  }
  return { apps, filtered: false };
}

const reviewsBlocked = () => Date.now() < reviewsBlockedUntil;

module.exports = {
  reviewsBlocked,
  HttpError, fetchCurrentPlayers, fetchStoreDetails, fetchReviewScore,
  searchStoreByName, countLanguages, fetchAppList
};
