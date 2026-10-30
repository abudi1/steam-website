// Avvia tutto ciò che tiene i dati aggiornati: catalogo, campionamento, dettagli store, manutenzione.
const cron = require('node-cron');
const poller = require('./poller');
const details = require('./details');
const { seedPriority, ensureCatalog } = require('./catalog');
const { refreshTrends, rollupDaily, rollupOnStartup } = require('./maintenance');

function safe(name, fn) {
  return () => { try { return fn(); } catch (err) { console.error(`[${name}] ${err.message}`); } };
}

function startTracking() {
  seedPriority();
  poller.start();
  details.start();
  ensureCatalog();
  setTimeout(safe('manutenzione', rollupOnStartup), 3000).unref();
  setTimeout(safe('trend', refreshTrends), 15000).unref();
  setInterval(safe('trend', refreshTrends), 2 * 60 * 1000).unref();
  cron.schedule('10 3 * * *', safe('manutenzione', () => rollupDaily(false)));
  cron.schedule('17 4 * * *', ensureCatalog);
}

module.exports = { startTracking };
