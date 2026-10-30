// Lavori periodici: trend dei giochi popolari, riepilogo giornaliero e pulizia dei campioni grezzi.
const db = require('./db');

const DAY = 86400;
const RAW_DAYS = Number(process.env.RAW_DAYS) > 0 ? Number(process.env.RAW_DAYS) : 30;

const popular = db.prepare('SELECT app_id, tracked_since FROM games WHERE current_players >= 100');
const avgBetween = db.prepare('SELECT AVG(players) AS avg FROM player_snapshots WHERE app_id = ? AND ts >= ? AND ts < ?');
const setTrend = db.prepare('UPDATE games SET trend_pct = ? WHERE app_id = ?');
const clearTrends = db.prepare('UPDATE games SET trend_pct = NULL WHERE current_players < 100 AND trend_pct IS NOT NULL');

// Variazione % della media giocatori: ultime 24h vs 24h precedenti. Calcolata solo per i giochi con ≥100
// giocatori (sono gli unici che possono finire in "trending") e salvata nella tabella, così le classifiche
// sono una semplice ORDER BY.
function refreshTrends() {
  const now = Math.floor(Date.now() / 1000);
  const rows = popular.all();
  db.exec('BEGIN');
  try {
    for (const g of rows) {
      let trend = null;
      if (g.tracked_since !== null && g.tracked_since <= now - DAY) {
        const last = avgBetween.get(g.app_id, now - DAY, now + 1)?.avg ?? null;
        const prev = avgBetween.get(g.app_id, now - 2 * DAY, now - DAY)?.avg ?? null;
        if (last !== null && prev !== null && prev > 0) trend = Number((((last - prev) / prev) * 100).toFixed(1));
      }
      setTrend.run(trend, g.app_id);
    }
    clearTrends.run();
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Riassume i giorni conclusi in picco+media (tabella player_daily, conservata per sempre) e cancella i
// campioni grezzi più vecchi di RAW_DAYS giorni. `full` ricalcola tutta la finestra grezza.
function rollupDaily(full = false) {
  const now = Math.floor(Date.now() / 1000);
  const todayStart = Math.floor(now / DAY) * DAY;
  // Il limite è allineato a mezzanotte UTC: un giorno non viene mai riassunto a metà (altrimenti un picco
  // già salvato verrebbe sostituito da uno calcolato su dati parziali).
  const cutoff = Math.floor((now - RAW_DAYS * DAY) / DAY) * DAY;
  const from = full ? cutoff : Math.max(cutoff, todayStart - 3 * DAY);
  db.prepare(`
    INSERT OR REPLACE INTO player_daily (app_id, day, peak, avg)
    SELECT app_id, ts / ${DAY}, MAX(players), CAST(ROUND(AVG(players)) AS INTEGER)
    FROM player_snapshots WHERE ts >= ? AND ts < ? GROUP BY app_id, ts / ${DAY}`).run(from, todayStart);
  const removed = db.prepare('DELETE FROM player_snapshots WHERE ts < ?').run(cutoff).changes;
  db.meta.set('last_rollup_at', now);
  if (removed) console.log(`[manutenzione] riepilogo giornaliero fatto, ${Number(removed).toLocaleString('en-US')} campioni vecchi rimossi`);
}

// All'avvio: se il riepilogo non gira da più di 36 ore (computer spento, primo avvio dopo un aggiornamento)
// ricalcola tutta la finestra, altrimenti solo gli ultimi giorni.
function rollupOnStartup() {
  const last = Number(db.meta.get('last_rollup_at')) || 0;
  rollupDaily(Date.now() / 1000 - last > 36 * 3600);
}

module.exports = { refreshTrends, rollupDaily, rollupOnStartup, RAW_DAYS };
