// Playcount — frontend vanilla JS, servito dallo stesso server Express delle API.
// Nessuna dipendenza esterna, nessun CORS: le chiamate usano percorsi relativi (/api/...).

const state = {
  view: 'home',
  range: '30d',
  query: '',
  noMatch: false,
  selectedAppId: null,
  compareA: 730,
  compareB: 2358720,
  trendingIds: null,
  trendingFilled: [],
  mostPlayedIds: null,
  games: {},
  historyCache: {},
  searchQuery: '',
  searchResults: null,   // null = in caricamento
  missing: {},           // app_id -> true se Steam non lo conosce
  cmpTextA: null,
  cmpTextB: null,
  rankType: 'now',
  rankGenre: '',
  rankings: {},          // chiave tipo|genere -> righe
  genres: null
};

const loading = { rank: null, genres: false, home: false, games: new Set(), history: new Set(), list: false, search: null };
state.status = null;   // /api/status
state.error = null;    // errore di rete mostrato in pagina

// ---------- Routing con hash (#/game/730, #/compare/730/570, #/about) ----------
let skipHashEvent = false;
let innerNav = false;   // true dopo la prima navigazione dentro il sito: "Back" può tornare indietro davvero
let lastViewKey = null;

function hashFor(s) {
  if (s.view === 'game' && s.selectedAppId) return '#/game/' + s.selectedAppId;
  if (s.view === 'compare') return '#/compare/' + s.compareA + '/' + s.compareB;
  if (s.view === 'search') return '#/search/' + encodeURIComponent(s.searchQuery);
  if (s.view === 'rankings') return '#/rankings/' + s.rankType + (s.rankGenre ? '/' + encodeURIComponent(s.rankGenre) : '');
  if (s.view === 'about') return '#/about';
  return '#/';
}
function applyHash() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'game' && /^\d+$/.test(p[1] || '')) { state.view = 'game'; state.selectedAppId = Number(p[1]); }
  else if (p[0] === 'compare') {
    state.view = 'compare';
    if (/^\d+$/.test(p[1] || '') && /^\d+$/.test(p[2] || '')) { state.compareA = Number(p[1]); state.compareB = Number(p[2]); }
  }
  else if (p[0] === 'search' && p[1]) { state.view = 'search'; const q = decodeURIComponent(p[1]); if (q !== state.searchQuery) { state.searchQuery = q; state.searchResults = null; } }
  else if (p[0] === 'rankings') { state.view = 'rankings'; state.rankType = ['now', 'trend', 'peak'].includes(p[1]) ? p[1] : 'now'; state.rankGenre = p[2] ? decodeURIComponent(p[2]) : ''; }
  else if (p[0] === 'about') state.view = 'about';
  else state.view = 'home';
}
window.addEventListener('hashchange', () => {
  if (skipHashEvent) { skipHashEvent = false; return; }
  applyHash();
  render();
});

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) { const e = new Error('API ' + res.status + ' su ' + path); e.status = res.status; throw e; }
  return res.json();
}

function setState(patch) {
  Object.assign(state, patch);
  const h = hashFor(state);
  if (location.hash !== h) { skipHashEvent = true; location.hash = h; innerNav = true; }
  render();
}

// ---------- Formattazione ----------

const N = (n) => (n === null || n === undefined) ? '—' : n.toLocaleString('en-US');
const K = (n) => {
  if (n === null || n === undefined) return '—';
  return n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
};
function fmtDateOnly(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
}
function fmtAxisLabel(ts, span) {
  const d = new Date(ts * 1000);
  if (span <= 36 * 3600) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  if (span <= 60 * 86400) return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatMoney(cents, currency) {
  if (cents === null || cents === undefined) return '—';
  const amount = cents / 100;
  const cur = currency || 'EUR';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(amount); }
  catch (e) { return cur + ' ' + amount.toFixed(2); }
}
function price(g) {
  if (!g) return '—';
  if (g.price_cents === 0) return 'Free to Play';
  if (g.price_cents === null || g.price_cents === undefined) return '—';
  return formatMoney(g.price_cents, g.price_currency);
}
function discountLabel(g) {
  if (!g) return '';
  if (g.discount_percent) return '−' + g.discount_percent + '% · was ' + formatMoney(g.price_initial_cents, g.price_currency);
  return 'no active discount';
}
function tagsFor(g) {
  if (!g || !g.genres) return [];
  return g.genres.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
}
function deltaLabel(g) {
  if (!g || g.trend_pct === null || g.trend_pct === undefined) return 'not enough data yet';
  if (g.trend_pct === 0) return '— no change';
  return (g.trend_pct > 0 ? '▲ ' : '▼ ') + Math.abs(g.trend_pct).toFixed(1) + '% since yesterday';
}
function deltaColor(g) { return (g && g.trend_pct > 0) ? 'var(--color-accent-700)' : 'var(--color-neutral-600)'; }
function rankChangeValue(g) {
  if (!g || !g.trend_pct) return '—';
  return (g.trend_pct > 0 ? '+' : '') + g.trend_pct.toFixed(1) + '%';
}
function reviewsShort(g) { return g && g.total_reviews ? K(g.total_reviews) : '—'; }
function reviewsFull(g) {
  if (!g) return '—';
  const desc = g.review_desc || 'Not loaded yet';
  return g.total_reviews ? desc + ' — ' + K(g.total_reviews) : desc;
}
function sparkFor(g) {
  if (!g) return '';
  const peak = g.peak_24h || g.current_players || 1;
  const cur = g.current_players || 0;
  const scale = Math.max(peak, cur, 1) * 1.1;
  const y1 = 34 - (peak / scale) * 31;
  const y2 = 34 - (cur / scale) * 31;
  return '0,' + y1.toFixed(1) + ' 140,' + y2.toFixed(1);
}

// ---------- Caricamento dati ----------

async function loadHome() {
  if (loading.home) return;
  loading.home = true;
  try {
    const [trending, mostPlayed] = await Promise.all([apiGet('/api/trending'), apiGet('/api/most-played')]);
    const games = Object.assign({}, state.games);
    trending.forEach((g) => { games[g.app_id] = g; });
    mostPlayed.forEach((g) => { games[g.app_id] = g; });
    setState({ trendingIds: trending.map((g) => g.app_id), trendingFilled: trending.filter((g) => g.filled).map((g) => g.app_id), mostPlayedIds: mostPlayed.map((g) => g.app_id), games });
  } catch (err) {
    console.error('[playcount] homepage:', err.message);
    setState({ trendingIds: [], trendingFilled: [], mostPlayedIds: [], error: 'Cannot reach the server. Is it running (npm start)?' });
  } finally {
    loading.home = false;
  }
}

let metaAt = 0;
async function loadMeta() {
  if (loading.list || Date.now() - metaAt < 30000) return;
  loading.list = true;
  metaAt = Date.now();
  try {
    state.status = await apiGet('/api/status');
    render();
  } catch (err) {
    console.error('[playcount] meta:', err.message);
  } finally {
    loading.list = false;
  }
}

async function ensureGame(appId) {
  if (!appId || state.games[appId] || state.missing[appId] || loading.games.has(appId)) return;
  loading.games.add(appId);
  try {
    const stats = await apiGet('/api/game/' + appId);
    const games = Object.assign({}, state.games, { [appId]: stats });
    setState({ games });
  } catch (err) {
    console.error('[playcount] gioco non trovato:', appId, err.message);
    setState({ missing: Object.assign({}, state.missing, { [appId]: err.status === 429 ? 'busy' : true }) });
  } finally {
    loading.games.delete(appId);
  }
}

async function ensureHistory(appId, range) {
  if (!appId) return;
  const key = appId + ':' + range;
  if (state.historyCache[key] || loading.history.has(key)) return;
  loading.history.add(key);
  try {
    const data = await apiGet('/api/game/' + appId + '/history?range=' + range);
    const historyCache = Object.assign({}, state.historyCache, { [key]: data.points || [] });
    setState({ historyCache });
  } catch (err) {
    console.error('[playcount] storico:', key, err.message);
  } finally {
    loading.history.delete(key);
  }
}

function runSearch() {
  const q = (state.query || '').trim();
  if (!q) return;
  if (/^\d+$/.test(q)) { setState({ view: 'game', selectedAppId: Number(q), query: '' }); return; }
  setState({ view: 'search', searchQuery: q, searchResults: null, query: '' });
}

async function loadSearch() {
  const q = state.searchQuery;
  if (state.searchResults !== null || loading.search === q) return;
  loading.search = q;
  try {
    const results = await apiGet('/api/search?q=' + encodeURIComponent(q));
    if (state.searchQuery !== q) return;
    if (results.length === 1) {
      // Un solo risultato: vai al gioco SOSTITUENDO la pagina di ricerca nella cronologia, così "Back" non ci ripassa.
      Object.assign(state, { view: 'game', selectedAppId: results[0].app_id });
      skipHashEvent = true;
      location.replace(hashFor(state));
      render();
      return;
    }
    setState({ searchResults: results });
  } catch (err) {
    console.error('[playcount] ricerca:', err.message);
    if (state.searchQuery === q) setState({ searchResults: [], error: err.status === 429 ? 'Too many searches — wait a minute.' : 'Search failed, try again.' });
  } finally {
    loading.search = null;
  }
}

function renderSearch() {
  loadSearch();
  const r = state.searchResults;
  const body = r === null ? '<div class="loading">Searching the whole Steam catalogue…</div>'
    : r.length === 0 ? '<div class="no-match">No game matches “' + esc(state.searchQuery) + '”.</div>'
    : '<div class="result-list">' + r.map((g) => `
        <div class="result" data-open="${g.app_id}">
          <div class="result-name">${esc(g.name)}</div>
          <div class="result-meta">App ${g.app_id}${g.genres ? ' · ' + esc(g.genres) : ''}${g.release_date ? ' · ' + esc(g.release_date) : ''}</div>
          <div class="result-players">${g.current_players === null || g.current_players === undefined ? '—' : N(g.current_players)}<span>now</span></div>
        </div>`).join('') + '</div>';
  return `
    ${nav('home')}
    <div class="wrap">
      <div class="back-row"><button class="btn btn-secondary" data-back>← Back</button>
        <h1 style="font-size:34px;letter-spacing:.02em;text-transform:uppercase;overflow-wrap:anywhere">Results for “${esc(state.searchQuery)}”</h1></div>
      ${body}
    </div>`;
}

// ---------- Grafico ----------

// Il grafico usa il tempo vero sull'asse X: se il PC era spento e mancano dati, resta un buco (la linea si interrompe)
// invece di unire con una retta due punti lontani ore.
function chart(appId, range, forcedMax, domain) {
  const points = state.historyCache[appId + ':' + range] || [];
  if (points.length < 2) {
    return { peak: 0, line: '', area: '', yLabels: ['', '', '', '', ''], xLabels: ['', '', '', '', ''] };
  }
  const t0 = domain ? domain[0] : points[0].ts;
  const t1 = domain ? domain[1] : points[points.length - 1].ts;
  const span = Math.max(t1 - t0, 1);
  const vals = points.map((p) => p.players);
  const max = forcedMax || Math.max.apply(null, vals) * 1.12 || 1;
  const gaps = points.slice(1).map((p, i) => p.ts - points[i].ts).sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)] || 300;
  const gapLimit = Math.max(typical * 3, 900);
  const X = (ts) => ((ts - t0) / span) * 1000;
  const Y = (v) => 300 - (v / max) * 288;
  const segments = [];
  let cur = [];
  points.forEach((p, i) => {
    if (i > 0 && p.ts - points[i - 1].ts > gapLimit) { segments.push(cur); cur = []; }
    cur.push([X(p.ts), Y(p.players)]);
  });
  segments.push(cur);
  const f = (q) => q[0].toFixed(1) + ',' + q[1].toFixed(1);
  const line = segments.map((sg) => 'M' + sg.map(f).join(' L')).join(' ');
  const area = segments.map((sg) => 'M' + sg[0][0].toFixed(1) + ',300 L' + sg.map(f).join(' L') + ' L' + sg[sg.length - 1][0].toFixed(1) + ',300 Z').join(' ');
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((k) => fmtAxisLabel(t0 + span * k, span));
  return {
    peak: Math.max.apply(null, vals), line, area,
    yLabels: [4, 3, 2, 1, 0].map((k) => K(Math.round(max * k / 4))),
    xLabels
  };
}

function chartSvg(c) {
  return `
    <div class="chart-box">
      <svg viewBox="0 0 1000 300" width="100%" height="300" preserveAspectRatio="none" style="display:block">
        <line x1="0" y1="75" x2="1000" y2="75" stroke="var(--color-divider)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
        <line x1="0" y1="150" x2="1000" y2="150" stroke="var(--color-divider)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
        <line x1="0" y1="225" x2="1000" y2="225" stroke="var(--color-divider)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
        <path d="${c.area}" fill="rgba(148,188,227,0.14)"></path>
        <path d="${c.line}" fill="none" stroke="var(--color-accent)" stroke-width="2" vector-effect="non-scaling-stroke"></path>
      </svg>
    </div>`;
}

// ---------- Rendering ----------

function nav(active) {
  const link = (id, label) => `<a data-nav="${id}" class="${active === id ? 'active' : ''}">${label}</a>`;
  return `
    <div class="wrap">
      <div class="nav">
        <div class="nav-brand"><span>Playcount</span><small>steam player data</small></div>
        ${link('home', 'Trending')}
        ${link('rankings', 'Rankings')}
        ${link('compare', 'Compare')}
        ${link('about', 'About the data')}
      </div>
    </div>`;
}

async function loadRankings() {
  const key = state.rankType + '|' + state.rankGenre;
  if (state.rankings[key] || loading.rank === key) return;
  loading.rank = key;
  try {
    const rows = await apiGet('/api/rankings?type=' + state.rankType + '&limit=50' + (state.rankGenre ? '&genre=' + encodeURIComponent(state.rankGenre) : ''));
    setState({ rankings: Object.assign({}, state.rankings, { [key]: rows }) });
  } catch (err) {
    console.error('[playcount] classifica:', err.message);
    setState({ rankings: Object.assign({}, state.rankings, { [key]: [] }) });
  } finally { loading.rank = null; }
}
async function loadGenres() {
  if (state.genres !== null || loading.genres) return;
  loading.genres = true;
  try { state.genres = await apiGet('/api/genres'); render(); } catch (e) { state.genres = []; } finally { loading.genres = false; }
}

function renderRankings() {
  loadRankings(); loadGenres();
  const rows = state.rankings[state.rankType + '|' + state.rankGenre];
  const types = [['now', 'Playing now'], ['trend', 'Trending 24h'], ['peak', 'Recorded peak']];
  const empty = state.rankType === 'trend'
    ? 'Not enough history yet: trending needs at least 24 hours of data and games with 100+ players.'
    : 'No games found for this filter yet.';
  const value = (g) => state.rankType === 'trend' ? rankChangeValue(g) : state.rankType === 'peak' ? N(g.all_time_peak) : N(g.current_players);
  const sub = (g) => state.rankType === 'peak' ? 'set ' + fmtDateOnly(g.all_time_peak_at) : state.rankType === 'trend' ? N(g.current_players) + ' now' : 'now';
  const body = rows === undefined ? '<div class="loading">Loading…</div>'
    : rows.length === 0 ? '<div class="no-match">' + esc(empty) + '</div>'
    : '<div class="result-list">' + rows.map((g, i) => `
        <div class="result" data-open="${g.app_id}">
          <div class="result-name"><span class="rank-n">${i + 1}</span>${esc(g.name)}</div>
          <div class="result-meta">App ${g.app_id}${g.genres ? ' · ' + esc(g.genres) : ''}</div>
          <div class="result-players">${esc(value(g))}<span>${esc(sub(g))}</span></div>
        </div>`).join('') + '</div>';
  return `
    ${nav('rankings')}
    <div class="wrap">
      <h1 style="font-size:44px;letter-spacing:.02em;text-transform:uppercase;margin:6px 0 18px">Rankings</h1>
      <div class="range-head" style="margin-top:0">
        <div class="seg">${types.map(([id, label]) => `<span class="seg-opt ${state.rankType === id ? 'active' : ''}" data-rank="${id}">${label}</span>`).join('')}</div>
        <select class="input" id="genreSel" style="max-width:240px;height:36px">
          <option value="">All genres</option>
          ${(state.genres || []).map((gn) => `<option value="${esc(gn)}" ${gn === state.rankGenre ? 'selected' : ''}>${esc(gn)}</option>`).join('')}
        </select>
      </div>
      ${body}
    </div>`;
}

function scanBanner() {
  const st = state.status;
  if (!st) { loadMeta(); return ''; }
  if (!st.games_total) return '<div class="banner">Importing the Steam catalogue… this takes a minute.</div>';
  if (st.scan_progress >= 0.95) return '';
  return `<div class="banner"><b>First scan in progress:</b> ${N(st.games_measured)} of ${N(st.games_total)} games measured (${Math.round(st.scan_progress * 100)}%). Rankings fill in as the scan advances.</div>`;
}

function renderHome() {
  if (state.trendingIds === null) loadHome();
  loadMeta();
  const filled = new Set(state.trendingFilled || []);

  const trendingIds = state.trendingIds || [];
  const mostPlayedIds = state.mostPlayedIds || [];

  const trendingHtml = trendingIds.length ? trendingIds.map((appId, i) => {
    const g = state.games[appId];
    if (!g) return '';
    return `
      <div class="trend-row" data-open="${appId}">
        <div class="trend-rank">${String(i + 1).padStart(2, '0')}</div>
        <div class="capsule">${g.header_image ? `<img src="${esc(g.header_image)}" alt="">` : '<span>capsule</span>'}</div>
        <div class="trend-info">
          <div class="trend-name">${esc(g.name)}</div>
          <div class="trend-meta"><span>#${g.app_id}</span><span>${esc(g.release_date || '')}</span><span>${reviewsShort(g)} reviews</span></div>
          <div class="trend-tags">
            <span class="tag tag-accent">${esc(price(g))}</span>
            <span class="delta" style="color:${deltaColor(g)}">${esc(filled.has(appId) ? 'most played right now' : deltaLabel(g))}</span>
          </div>
        </div>
        <div class="trend-num">
          <div class="now">${N(g.current_players)}</div>
          <div class="now-label">in game now</div>
          <svg viewBox="0 0 140 34" width="140" height="34" style="display:block;margin-top:4px;opacity:.85" preserveAspectRatio="none">
            <polyline points="${sparkFor(g)}" fill="none" stroke="var(--color-accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"></polyline>
          </svg>
          <div class="peak-label">24h peak ${N(g.peak_24h)}</div>
        </div>
      </div>`;
  }).join('') : `<div class="loading">${state.trendingIds !== null ? 'No data yet — the first poll is still running, reload in a few seconds.' : 'Loading…'}</div>`;

  const allTimeHtml = mostPlayedIds.length ? `
    <table class="table">
      <thead><tr><th style="width:34px">#</th><th>Game</th><th style="text-align:right">Peak</th></tr></thead>
      <tbody>
        ${mostPlayedIds.map((appId, i) => {
          const g = state.games[appId];
          if (!g) return '';
          return `
            <tr style="cursor:pointer" data-open="${appId}">
              <td style="font-family:var(--font-heading);font-size:17px;color:var(--color-neutral-600)">${i + 1}</td>
              <td>
                <div style="font-family:var(--font-heading);font-size:18px;line-height:1.15">${esc(g.name)}</div>
                <div style="font-family:var(--font-mono);font-size:10px;color:var(--color-neutral-600)">set ${fmtDateOnly(g.all_time_peak_at)}</div>
              </td>
              <td style="text-align:right;font-family:var(--font-mono);font-size:14px;white-space:nowrap">${N(g.all_time_peak)}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
    <div class="note-box">
      <div class="label-mono">Note</div>
      <p>Peaks are the highest concurrent-player count this site has recorded since it started tracking a game — not Steam's all-time record. Console, Game Pass and other storefronts are not included.</p>
    </div>` : `<div class="loading">${state.mostPlayedIds !== null ? 'No data yet.' : 'Loading…'}</div>`;

  return `
    ${nav('home')}
    <div class="wrap">
      <div class="hero">
        <div>
          <h1>What Steam is playing<br>right now</h1>
          <p>Live concurrent players, 24-hour peaks and all-time records, for every game on Steam. Popular games are refreshed every five minutes; quieter ones less often.</p>
        </div>
        <div>
          <div class="label-mono" style="margin-bottom:10px">Look up a game</div>
          <div class="search-row">
            <input class="input" type="text" id="searchInput" placeholder="Any Steam game — name or App ID, e.g. Dota 2 or 570" value="${esc(state.query)}">
            <button class="btn btn-primary" id="searchBtn">Search</button>
          </div>
          ${state.noMatch ? '<div class="no-match">No game matches that ID or name.</div>' : ''}
          <div class="suggested-ids">
            <span class="tag tag-neutral" data-open="730">730</span>
            <span class="tag tag-neutral" data-open="570">570</span>
            <span class="tag tag-neutral" data-open="1091500">1091500</span>
            <span class="tag tag-neutral" data-open="2358720">2358720</span>
          </div>
        </div>
      </div>
      ${state.error ? `<div class="no-match" style="margin-bottom:24px">${esc(state.error)}</div>` : ''}
      ${scanBanner()}
      <div class="columns">
        <div>
          <div class="section-head"><h2>Trending now</h2><span class="meta">${filled.size ? 'by 24h change · filling up with live leaders' : 'by 24h change'}</span></div>
          ${trendingHtml}
        </div>
        <div>
          <div class="section-head" style="margin-bottom:18px"><h2>Most played ever</h2><span class="meta">by recorded peak</span></div>
          ${allTimeHtml}
        </div>
      </div>
    </div>`;
}

function renderGame() {
  const appId = state.selectedAppId || 730;
  ensureGame(appId);
  ensureHistory(appId, state.range);

  const g = state.games[appId];
  const c = chart(appId, state.range);
  const trendRankIdx = (state.trendingIds || []).indexOf(appId);

  if (!g && state.missing[appId]) {
    const busy = state.missing[appId] === 'busy';
    return `${nav('home')}<div class="wrap"><div class="back-row"><button class="btn btn-secondary" data-back>← Back</button></div>
      <div class="no-match">${busy ? 'Too many lookups right now — wait a minute and reload.' : 'App ' + appId + ' was not found: Steam has no public data for this ID (it may be a DLC, a tool, a removed or private app).'}</div></div>`;
  }
  if (!g) {
    return `${nav('home')}<div class="wrap"><div class="loading">Loading game data…</div></div>`;
  }

  const plate = [
    { label: 'Players now', value: N(g.current_players), note: 'live' },
    { label: '24-hour peak', value: N(g.peak_24h), note: g.peak_24h_at ? fmtDateTime(g.peak_24h_at) : '—' },
    { label: 'All-time peak', value: N(g.all_time_peak), note: fmtDateOnly(g.all_time_peak_at) },
    { label: '24h trend', value: rankChangeValue(g), note: 'avg players vs day before' },
    { label: 'Reviews', value: reviewsShort(g), note: g.review_desc || 'no summary yet' },
    { label: 'Released', value: g.release_date || '—', note: 'on Steam' }
  ];
  const records = [
    { label: 'All-time peak', value: N(g.all_time_peak) + ' · ' + fmtDateOnly(g.all_time_peak_at) },
    { label: '24-hour peak', value: N(g.peak_24h) },
    { label: '7-day peak', value: N(g.peak_7d) },
    { label: '30-day peak', value: N(g.peak_30d) },
    { label: '30-day average', value: N(g.avg_30d) },
    { label: 'Share of all-time peak', value: g.all_time_peak ? Math.round(g.current_players / g.all_time_peak * 100) + '%' : '—' },
    { label: 'Tracking since', value: g.tracked_since ? fmtDateTime(g.tracked_since) : 'not measured yet' }
  ];
  const store = [
    ['Developer', g.developers || '—'], ['Publisher', g.publishers || '—'], ['Released', g.release_date || '—'],
    ['Reviews', reviewsFull(g)], ['Platforms', g.platforms || '—'], ['Languages', g.languages_count ? String(g.languages_count) : '—']
  ];
  const ranges = ['24h', '7d', '30d', '1y', 'all'];

  return `
    ${nav('home')}
    <div class="wrap">
      <div class="back-row">
        <button class="btn btn-secondary" data-back>← Back</button>
        <input class="input" type="text" id="searchInput2" placeholder="App ID or game name" style="max-width:320px;height:34px">
        <button class="btn btn-secondary" id="searchBtn2">Search</button>
        <button class="btn btn-secondary" style="margin-left:auto" data-compare="${appId}">Compare with another game</button>
      </div>

      <div class="detail-grid">
        <div class="capsule header-capsule">${g.header_image ? `<img src="${esc(g.header_image)}" alt="">` : '<span>header capsule</span>'}</div>
        <div>
          <div class="detail-eyebrow"><a href="https://store.steampowered.com/app/${g.app_id}" target="_blank" rel="noopener" style="margin-right:12px">Open on Steam ↗</a>App ${g.app_id}${trendRankIdx >= 0 ? ' · rank ' + (trendRankIdx + 1) + ' trending' : ''}</div>
          <h1 class="detail-title">${esc(g.name)}</h1>
          <div class="detail-tags">${tagsFor(g).map((t) => `<span class="tag tag-outline">${esc(t)}</span>`).join('')}</div>
          <div class="detail-price-row">
            <div class="detail-price">${esc(price(g))}</div>
            <div class="detail-discount">${esc(discountLabel(g))}</div>
          </div>
        </div>
      </div>

      <div class="plate">
        ${plate.map((c2) => `
          <div class="plate-cell">
            <div class="p-label">${esc(c2.label)}</div>
            <div class="p-value">${esc(c2.value)}</div>
            <div class="p-note">${esc(c2.note)}</div>
          </div>`).join('')}
      </div>

      <div class="range-head">
        <h2 style="font-size:26px;letter-spacing:.02em;text-transform:uppercase">Concurrent players</h2>
        <a class="btn btn-secondary" href="/api/game/${appId}/export.csv?range=${state.range}" download style="margin-left:auto">Download CSV (${state.range})</a>
        <div class="seg">${ranges.map((r) => `<span class="seg-opt ${state.range === r ? 'active' : ''}" data-range="${r}">${r}</span>`).join('')}</div>
      </div>
      <div class="chart-grid">
        <div class="y-axis">${c.yLabels.map((y) => `<div>${esc(y)}</div>`).join('')}</div>
        <div>
          ${chartSvg(c)}
          <div class="x-axis">${c.xLabels.map((x) => `<div>${esc(x)}</div>`).join('')}</div>
        </div>
      </div>

      <div class="records-grid">
        <div>
          <h3>Records</h3>
          <table class="table"><tbody>
            ${records.map((r) => `<tr><td style="color:var(--color-neutral-700)">${esc(r.label)}</td><td style="text-align:right;font-family:var(--font-mono);white-space:nowrap">${esc(r.value)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div>
          <h3>Store data</h3>
          <table class="table"><tbody>
            ${store.map((s) => `<tr><td style="color:var(--color-neutral-700)">${esc(s[0])}</td><td style="text-align:right">${esc(s[1])}</td></tr>`).join('')}
          </tbody></table>
        </div>
      </div>
    </div>`;
}

function renderCompare() {
  const compareA = state.compareA;
  const compareB = state.compareB;
  ensureGame(compareA); ensureGame(compareB);
  ensureHistory(compareA, state.range); ensureHistory(compareB, state.range);

  const ga = state.games[compareA];
  const gb = state.games[compareB];
  const ca = chart(compareA, state.range);
  const cb = chart(compareB, state.range);
  const shared = Math.max(ca.peak, cb.peak, 1) * 1.12;
  const hA = state.historyCache[compareA + ':' + state.range] || [];
  const hB = state.historyCache[compareB + ':' + state.range] || [];
  const all = hA.concat(hB);
  const domain = all.length ? [Math.min.apply(null, all.map((p) => p.ts)), Math.max.apply(null, all.map((p) => p.ts))] : undefined;
  const sa = chart(compareA, state.range, shared, domain);
  const sb = chart(compareB, state.range, shared, domain);

  const win = (x, y) => [x >= y ? 'var(--color-text)' : 'var(--color-neutral-600)', y >= x ? 'var(--color-text)' : 'var(--color-neutral-600)'];
  const row = (label, av, bv, af, bf) => { const c = win(av, bv); return { label, a: af, b: bf, aColor: c[0], bColor: c[1] }; };
  const cmpRows = (ga && gb) ? [
    row('Players now', ga.current_players, gb.current_players, N(ga.current_players), N(gb.current_players)),
    row('24-hour peak', ga.peak_24h, gb.peak_24h, N(ga.peak_24h), N(gb.peak_24h)),
    row('All-time peak', ga.all_time_peak, gb.all_time_peak, N(ga.all_time_peak) + ' · ' + fmtDateOnly(ga.all_time_peak_at), N(gb.all_time_peak) + ' · ' + fmtDateOnly(gb.all_time_peak_at)),
    row('Share of all-time peak', ga.all_time_peak ? ga.current_players / ga.all_time_peak : 0, gb.all_time_peak ? gb.current_players / gb.all_time_peak : 0,
      ga.all_time_peak ? Math.round(ga.current_players / ga.all_time_peak * 100) + '%' : '—',
      gb.all_time_peak ? Math.round(gb.current_players / gb.all_time_peak * 100) + '%' : '—'),
    row('Trend', ga.trend_pct || 0, gb.trend_pct || 0, rankChangeValue(ga), rankChangeValue(gb)),
    row('Price', 0, 0, price(ga), price(gb)),
    row('Reviews', 0, 0, reviewsFull(ga), reviewsFull(gb)),
    row('Released', 0, 0, ga.release_date || '—', gb.release_date || '—')
  ] : [];

  const labelFor = (g, id) => g ? g.name + ' (' + id + ')' : String(id);
  const textA = state.cmpTextA !== null ? state.cmpTextA : labelFor(ga, compareA);
  const textB = state.cmpTextB !== null ? state.cmpTextB : labelFor(gb, compareB);
  const ranges = ['24h', '7d', '30d', '1y', 'all'];

  return `
    ${nav('compare')}
    <div class="wrap">
      <div class="back-row">
        <button class="btn btn-secondary" data-back>← Back</button>
        <h1 style="font-size:34px;letter-spacing:.02em;text-transform:uppercase">Head to head</h1>
      </div>

      <div class="cmp-cols">
        <div>
          <div class="cmp-label"><span class="cmp-swatch-a"></span>Game A</div>
          <input class="input" id="selA" list="dlA" autocomplete="off" placeholder="Game name or App ID" value="${esc(textA)}"><datalist id="dlA"></datalist>
          <div class="cmp-current">${ga ? N(ga.current_players) : '—'}</div>
          <div class="label-mono">in game now · app ${compareA}</div>
        </div>
        <div>
          <div class="cmp-label"><span class="cmp-swatch-b"></span>Game B</div>
          <input class="input" id="selB" list="dlB" autocomplete="off" placeholder="Game name or App ID" value="${esc(textB)}"><datalist id="dlB"></datalist>
          <div class="cmp-current">${gb ? N(gb.current_players) : '—'}</div>
          <div class="label-mono">in game now · app ${compareB}</div>
        </div>
      </div>

      <div class="range-head">
        <h2 style="font-size:26px;letter-spacing:.02em;text-transform:uppercase">Players, same scale</h2>
        <div class="seg">${ranges.map((r) => `<span class="seg-opt ${state.range === r ? 'active' : ''}" data-range="${r}">${r}</span>`).join('')}</div>
      </div>
      <div class="chart-grid">
        <div class="y-axis">${sa.yLabels.map((y) => `<div>${esc(y)}</div>`).join('')}</div>
        <div>
          <div class="chart-box">
            <svg viewBox="0 0 1000 300" width="100%" height="300" preserveAspectRatio="none" style="display:block">
              <line x1="0" y1="75" x2="1000" y2="75" stroke="var(--color-divider)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
              <line x1="0" y1="150" x2="1000" y2="150" stroke="var(--color-divider)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
              <line x1="0" y1="225" x2="1000" y2="225" stroke="var(--color-divider)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
              <path d="${sa.area}" fill="rgba(148,188,227,0.14)"></path>
              <path d="${sa.line}" fill="none" stroke="var(--color-accent)" stroke-width="2" vector-effect="non-scaling-stroke"></path>
              <path d="${sb.line}" fill="none" stroke="var(--color-text)" stroke-width="2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"></path>
            </svg>
          </div>
          <div class="x-axis">${sa.xLabels.map((x) => `<div>${esc(x)}</div>`).join('')}</div>
        </div>
      </div>

      ${(state.missing[compareA] || state.missing[compareB]) ? '<div class="no-match" style="margin-top:24px">One of the two games was not found on Steam.</div>' : ''}
      <table class="table" style="margin-top:52px">
        <thead><tr><th>Metric</th><th style="text-align:right">${ga ? esc(ga.name) : '…'}</th><th style="text-align:right">${gb ? esc(gb.name) : '…'}</th></tr></thead>
        <tbody>
          ${cmpRows.map((r) => `
            <tr>
              <td style="color:var(--color-neutral-600)">${esc(r.label)}</td>
              <td style="text-align:right;font-family:var(--font-mono);white-space:nowrap;color:${r.aColor}">${esc(r.a)}</td>
              <td style="text-align:right;font-family:var(--font-mono);white-space:nowrap;color:${r.bColor}">${esc(r.b)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}


function renderAbout() {
  loadMeta();
  const st = state.status;
  const since = st && st.tracking_since ? new Date(st.tracking_since * 1000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const last = st && st.last_poll ? fmtDateTime(st.last_poll) : '—';
  const item = (label, value) => `
    <div class="plate-cell"><div class="p-label">${label}</div><div class="p-value">${value}</div></div>`;
  const iv = st ? st.tier_intervals_minutes : {};
  const mins = (m) => m === undefined ? '—' : m >= 60 ? (m / 60) + ' h' : m + ' min';
  return `
    ${nav('about')}
    <div class="wrap" style="max-width:860px">
      <h1 style="font-size:54px;line-height:1;margin:20px 0 28px;letter-spacing:-0.01em">About the data</h1>
      <div class="plate" style="margin-top:0">
        ${item('Games in catalogue', st ? N(st.games_total) : '—')}
        ${item('Measured so far', st ? N(st.games_measured) : '—')}
        ${item('With players now', st ? N(st.games_active) : '—')}
        ${item('Samples stored', st ? N(st.samples_recorded) : '—')}
        ${item('Tracking since', since)}
        ${item('Last update', last)}
        ${item('Polls / minute', st ? N(st.polls_per_minute) : '—')}
        ${item('Reviews from Steam', st ? (st.reviews_blocked ? 'paused (blocked)' : 'ok') : '—')}
        ${item('Throttled by Steam', st ? (st.throttled ? 'yes' : 'no') + ' · ' + N(st.rate_limited_events) + ' events' : '—')}
      </div>
      <div class="about-text">
        <h3>Every game, at its own pace</h3>
        <p>The whole Steam catalogue is tracked, but not every game is sampled equally often — that would take far more requests than Steam allows. Each game is re-measured at a rhythm that depends on how busy it is: ${mins(iv[1000])} with 1,000+ players, ${mins(iv[100])} with 100+, ${mins(iv[10])} with 10+, ${mins(iv[1])} with at least one player, and ${mins(iv[0])} when empty. A game that wakes up moves to a faster tier automatically. After the first full scan (hours, not minutes) every game has data.</p>
        <h3>Where the numbers come from</h3>
        <p>Player counts come from Steam's public <em>GetNumberOfCurrentPlayers</em> endpoint. Price, reviews, release date and store details come from the public Steam Store API, fetched slowly in the background, busiest games first. Games with no public store page (playtests, hidden apps) show player counts but little else.</p>
        <h3>Trending</h3>
        <p>Trending ranks games with at least 1,000 players by the change in average players over the last 24 hours compared with the 24 hours before. It needs a little over a day of history per game; until then the free slots show the games with the most players right now, and are labelled as such.</p>
        <h3>Recorded peak</h3>
        <p>Steam has no public endpoint for historical peaks, so “peak” here means the highest value this site has recorded since it began tracking a game. For quiet tiers a short spike between two samples can be missed, and older games will show lower than Steam's true record. It becomes more accurate the longer a game is tracked.</p>
        <h3>History kept</h3>
        <p>Raw samples are kept for 30 days; older data is condensed into one peak and one average per day, which are kept forever. Games that have never had a player store nothing.</p>
        <h3>Anything not in the list</h3>
        <p>If a brand-new game isn't in the catalogue yet, searching for it (or opening its App ID) fetches it from Steam on the spot and starts tracking it.</p>
      </div>
    </div>`;
}

// ---------- Loop di rendering + eventi ----------

function render() {
  const app = document.getElementById('app');
  const viewKey = state.view + ':' + (state.view === 'game' ? state.selectedAppId : '');
  if (state.view === 'game') app.innerHTML = renderGame();
  else if (state.view === 'compare') app.innerHTML = renderCompare();
  else if (state.view === 'about') app.innerHTML = renderAbout();
  else if (state.view === 'search') app.innerHTML = renderSearch();
  else if (state.view === 'rankings') app.innerHTML = renderRankings();
  else app.innerHTML = renderHome();
  attachEvents();
  if (viewKey !== lastViewKey) { window.scrollTo(0, 0); lastViewKey = viewKey; }
  document.title = state.view === 'game' && state.games[state.selectedAppId] ? state.games[state.selectedAppId].name + ' — Playcount' : 'Playcount — Steam player data';
}

function attachEvents() {
  const app = document.getElementById('app');

  app.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => setState({ view: el.getAttribute('data-nav'), cmpTextA: null, cmpTextB: null }));
  });
  app.querySelectorAll('[data-back]').forEach((el) => {
    el.addEventListener('click', () => {
      if (innerNav) history.back();     // torna alla pagina precedente (gioco, ricerca, confronto...)
      else setState({ view: 'home' });  // arrivato da un link diretto: la home è l'unica pagina "indietro"
    });
  });
  app.querySelectorAll('[data-compare]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number(el.getAttribute('data-compare'));
      // Il gioco aperto va nel posto A; l'altro resta quello scelto prima (mai lo stesso gioco due volte).
      const other = state.compareA !== id ? state.compareA : state.compareB;
      setState({ view: 'compare', compareA: id, compareB: other !== id ? other : 730, cmpTextA: null, cmpTextB: null });
    });
  });
  app.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => setState({ view: 'game', selectedAppId: Number(el.getAttribute('data-open')) }));
  });
  app.querySelectorAll('[data-range]').forEach((el) => {
    el.addEventListener('click', () => setState({ range: el.getAttribute('data-range') }));
  });

  app.querySelectorAll('[data-rank]').forEach((el) => {
    el.addEventListener('click', () => setState({ rankType: el.getAttribute('data-rank') }));
  });
  const genreSel = document.getElementById('genreSel');
  if (genreSel) genreSel.addEventListener('change', () => setState({ rankGenre: genreSel.value }));

  const searchInput = document.getElementById('searchInput');
  const searchBtn = document.getElementById('searchBtn');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => { state.query = e.target.value; });
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  }
  if (searchBtn) searchBtn.addEventListener('click', runSearch);

  const searchInput2 = document.getElementById('searchInput2');
  const searchBtn2 = document.getElementById('searchBtn2');
  if (searchInput2) searchInput2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.query = e.target.value; runSearch(); } });
  if (searchBtn2) searchBtn2.addEventListener('click', () => { state.query = searchInput2.value; runSearch(); });

  [['selA', 'dlA', 'compareA', 'cmpTextA'], ['selB', 'dlB', 'compareB', 'cmpTextB']].forEach(([inId, dlId, key, textKey]) => {
    const input = document.getElementById(inId);
    const dl = document.getElementById(dlId);
    if (!input) return;
    let timer = null;
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => {
      state[textKey] = input.value;
      clearTimeout(timer);
      const term = input.value.trim();
      if (term.length < 2) return;
      timer = setTimeout(async () => {
        try {
          const rows = await apiGet('/api/suggest?q=' + encodeURIComponent(term));
          dl.innerHTML = rows.map((r) => `<option value="${esc(r.name)} (${r.app_id})"></option>`).join('');
        } catch (e) { /* suggerimenti opzionali */ }
      }, 200);
    });
    input.addEventListener('change', async () => {
      const text = input.value.trim();
      const m = text.match(/\((\d+)\)\s*$/) || text.match(/^(\d+)$/);
      let id = m ? Number(m[1]) : null;
      if (!id && text) {
        try { const r = await apiGet('/api/search?q=' + encodeURIComponent(text)); id = r[0] ? r[0].app_id : null; } catch (e) { /* ignora */ }
      }
      state[textKey] = null;
      if (id) setState({ [key]: id }); else render();
    });
  });
}

// Senza hash iniziale il primo cambio di pagina aggiungerebbe una voce in più alla cronologia: la normalizziamo subito.
if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#/');
applyHash();
render();
