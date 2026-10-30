# Playcount — giocatori Steam di TUTTI i giochi

Un solo processo Node: sito + API + tracker. Nessun database da installare (SQLite integrato in Node).

## Avvio

```powershell
npm install
copy .env.example .env      # poi apri .env e incolla la tua STEAM_API_KEY
npm start
```

Apri http://localhost:3001

Serve Node 22.13 o superiore (va bene anche 24) (`node -v`). La Steam API key è gratis: https://steamcommunity.com/dev/apikey
(senza key funziona comunque, ma il catalogo include anche DLC e software).

## Come traccia tutto il catalogo

1. All'avvio scarica l'elenco completo dei giochi Steam (decine/centinaia di migliaia) e lo riscarica ogni notte.
2. Per ogni gioco chiede a Steam i giocatori attuali, con frequenza proporzionale all'attività:

| Giocatori | Ogni quanto |
|---|---|
| 1.000+ | 5 minuti |
| 100+ | 30 minuti |
| 10+ | 3 ore |
| 1+ | 12 ore |
| 0 | 2 giorni |

   Un gioco che si risveglia passa da solo al livello più veloce. Ritmo massimo: `STEAM_REQ_PER_SEC` (default 5, ≈430.000 chiamate al giorno).
3. In background scarica prezzo, recensioni, sviluppatore ecc. (una richiesta ogni 2 secondi, prima i giochi più giocati).
4. I campioni grezzi si tengono 30 giorni; poi restano un picco e una media al giorno, per sempre. I giochi con zero giocatori da sempre non scrivono nulla.

## Cose da sapere (onestà)

- **La prima scansione completa richiede ore** (circa 6–9 ore a 5 richieste/s per ~150.000 giochi). Il sito è usabile subito (i 35 giochi più famosi vengono misurati per primi, il resto avanza in ordine di App ID) e in homepage c'è una barra di avanzamento.
- **Il PC deve restare acceso** per accumulare storico. Se lo spegni, l'orario dei campioni ha dei buchi (nessun dato inventato).
- **"Picco" = massimo registrato dal sito** da quando traccia il gioco: Steam non ha un endpoint pubblico per i record storici. Un picco brevissimo tra due campioni dei livelli lenti può sfuggire.
- **Trending** richiede almeno 24 ore di storico e 1.000+ giocatori; prima di allora mostra i più giocati ora (con etichetta).
- **I limiti reali di Steam non sono documentati.** Se risponde 429 il tracker rallenta e si mette in pausa da solo; `/api/status` (e la pagina "About") mostrano quante volte è successo e quanti campioni al minuto stai ottenendo. Se succede spesso, abbassa `STEAM_REQ_PER_SEC` nel `.env`.
- Spazio su disco: indicativamente qualche centinaio di MB al mese con tutto il catalogo (file `data.sqlite`).
- Giochi senza pagina store (playtest, app nascoste, es. Deadlock) mostrano i giocatori ma pochi dati store.
- Un gioco non ancora nel catalogo (appena uscito) si aggiunge da solo cercandolo per nome o App ID.

## API

`/api/status`, `/api/trending`, `/api/most-played`, `/api/search?q=`, `/api/suggest?q=`, `/api/game/:id`, `/api/game/:id/history?range=24h|7d|30d|1y|all`, `/api/compare?ids=730,570`

## Se la porta è occupata

`EADDRINUSE`: il server è già acceso in un altro terminale. Chiudilo (Ctrl+C) o cambia `PORT` nel `.env`.
