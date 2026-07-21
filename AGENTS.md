# AGENTS.md - scommeseSportive

Questo file definisce le istruzioni specifiche del progetto `scommeseSportive`.
Vale in aggiunta alle istruzioni globali di Codex e serve a bloccare le decisioni architetturali e di prodotto gia prese per questo repo.

## 1. Missione del progetto

`scommeseSportive` e una web app operativa per:
- importare dati calcistici
- calcolare prediction pre-match
- recuperare quote bookmaker
- proporre una sola giocata finale consigliata per partita
- archiviare quote e replay delle partite concluse

Obiettivo del prodotto:
- esperienza chiara per utente finale che vuole analizzare partite e quote
- codice mantenibile e portabile
- stack gratuito/open-source o con free tier realmente usabile
- architettura semplice: modular monolith

## 2. Decisioni architetturali bloccate

Queste decisioni sono gia state prese e non vanno rimesse in discussione senza richiesta esplicita del proprietario del progetto:

- frontend: `React`
- backend: `Node.js + Express + TypeScript`
- database: `libSQL / Turso`
- containerizzazione: `Docker + docker-compose`
- architettura: modular monolith, non microservizi
- fruizione primaria: web-first

Non introdurre:
- microservizi
- codebase duplicate
- orchestrazioni complesse
- provider a pagamento obbligatori
- infrastruttura non necessaria

## 3. Fonte dati ufficiale

### Regola principale

`Understat` e la fonte dati PRIMARIA del progetto per dati calcistici.

Questo significa che squadre, partite, giocatori, xG, tiri e storico match nascono da `Understat`.

### Fonte supplementare (dal 2026-07)

`football-data.co.uk` e una fonte **supplementare** HTTP/CSV (no browser, no API key), usata SOLO per riempire i campi che Understat copre male o per niente: falli, corner, tiri, tiri in porta, cartellini, arbitro (Referee solo Premier League). Regole:
- riempie solo i campi NULL via COALESCE: NON sovrascrive mai i dati Understat
- una riga CSV = una partita; il matching e per data + nomi squadra (mappa alias in `FootballDataService.ts`)
- si aggiorna nella nightly (solo stagione corrente) — vedi `FootballDataService`
- ha sostituito lo scraper `SofaScore` (Playwright) per questi campi; l'unico dato non coperto e il possesso

### Fonti disattivate

Non reintrodurre nel flusso attivo:
- `FotMob`
- `Transfermarkt`
- `FBref`

Questi path legacy non devono essere ripristinati senza una richiesta esplicita e motivata del proprietario del progetto.

Se trovi file o riferimenti legacy:
- rimuovili se non servono piu
- non creare fallback silenziosi verso fonti legacy

## 4. Regole quote

### Fonte quote lato utente (aggiornato 2026-07)

**Le quote possono provenire da piu bookmaker.** La precedente regola "Eurobet-only"
e superata: il proprietario gioca su piu operatori (`Eurobet`, `888`, ecc.) e
sceglie lui su quale piazzare, dato che le differenze di quota tra bookmaker sono
tipicamente di pochi centesimi (salvo casi rari).

Regole bloccate:
- **e ammesso mostrare quote da piu bookmaker reali**, purche sia sempre indicato
  **quale bookmaker** ha espresso quella quota
- **mai attribuire a un bookmaker una quota che non ha espresso**: la provenienza
  deve essere veritiera e tracciata (`source` nello snapshot)
- **mai mostrare come quota bookmaker una quota stimata o completata dal modello**
  (es. sorgenti `*_plus_model_completion` o quote sintetiche): queste restano
  esclusivamente interne. Usarle per calcolare il value sarebbe circolare
- se per una giocata non esiste **nessuna** quota bookmaker reale, non va mostrata
  nessuna quota per quella giocata

### Fallback tecnici

Sono ammessi fallback tecnici interni solo se servono a:
- non bloccare il backend
- completare logica interna
- salvare diagnostica o snapshot

Lato UI:
- sono ammesse quote di piu bookmaker reali, sempre con la fonte dichiarata
- **non** sono ammesse quote sintetiche o completate dal modello

## 5. Mercati supportati

### Mercati attivi e coerenti con Understat

Sono priorita del progetto:
- `1X2`
- `double chance`
- `draw no bet`
- `goal / over-under`
- `btts`
- `shots`
- `shots on target`
- `yellow cards over/under` (mercato attivo: dato gialli coperto ~50% dei match, modello squadra e giocatore implementati)
- `exact score`
- `handicap` (europeo e asiatico)
- **scommesse singole sui giocatori** (`player props`): tiri giocatore, tiri in porta giocatore, gialli giocatore. Valutate quando esiste una quota bookmaker corrispondente e il matching giocatore non e ambiguo (`playerProps.ts`, `PredictionService.buildPlayerPropMarkets`).

### Falli e corner — dato ora disponibile (2026-07)

- `fouls` e `corners` — **voluti dal proprietario**, che li gioca abitualmente. Il blocco storico era la copertura del **dato statistico** (falli/corner all'1-2% su Understat). **Risolto:** ora coperti a ~100% su tutte e 4 le stagioni via **football-data.co.uk** (§3). Understat resta primaria: football-data riempie solo i campi NULL (COALESCE).
- **Situazione QUOTE (verificata live sul provider, 2026-07):**
  - **Corner: ottenibili.** Chiavi valide di the-odds-api (tutte verificate live): `alternate_totals_corners`, `alternate_spreads_corners`, `alternate_team_totals_corners`, `corners_1x2`. Il codice chiedeva `'corners'`, chiave **inesistente** ("Invalid markets") — per questo non arrivavano mai quote corner. Corretto in `routes.ts` (`eventAdditionalMarkets`).
  - **Falli: NON ottenibili, filone chiuso.** Tutte le varianti (`fouls`, `totals_fouls`, `alternate_totals_fouls`) restituiscono "Invalid markets"; la documentazione ufficiale dei mercati conferma che per il calcio esistono corner e cartellini ma **non i falli**. Ricerca alternative (2026-07): nessun provider con free tier reale documenta i falli sul calcio; le opzioni potenzialmente capaci sono **a pagamento con prezzo su richiesta**, vietate da §2. I bookmaker che offrono i falli (incluso quello usato dal proprietario) sarebbero raggiungibili solo via scraping, escluso da §8. **Il mercato falli resta non attivabile.** Le uniche quote falli presenti negli snapshot sono `*_plus_model_completion`, cioe generate dal modello: **non utilizzabili** (sarebbe circolare).
  - Attenzione: `'shots'`, `'shots_on_target'`, `'cards'` sono anch'esse chiavi **non valide**; le equivalenti valide sono `alternate_totals_cards`, `alternate_spreads_cards`, `player_shots`, `player_shots_on_target`.
- Prima di mostrare corner/falli come mercati forti in UI: **validare i modelli in backtest di mercato** con quote reali (come fatto per i cartellini) e sbloccarli nel filtro value (`DISABLED_CATEGORIES` in `ValueBettingEngine`, piu la soglia EV oggi a 0.120). Attivarli solo dopo esito positivo.

Regola generale: non mostrare un mercato come "forte" solo per riempire la UI se il modello non e stato validato sul dato reale.

## 6. Regole prediction e UX

### Pronostico finale

Per ogni partita deve esserci:
- una sola giocata finale consigliata **sui mercati squadra** (1X2, over/under, gialli, ecc.)
- motivazione breve, leggibile e umana

Non trasformare il prodotto in una lista caotica di pick equivalenti sui mercati squadra.

### Scommesse singole sui giocatori

Le `player props` (tiri, tiri in porta, gialli giocatore) sono una categoria **distinta** dal pronostico squadra e possono essere mostrate come singole giocate sui giocatori, quando:
- esiste una quota bookmaker corrispondente per quel giocatore/mercato/linea
- il matching del giocatore non e ambiguo
- il campione dati del giocatore e sufficiente (vedi filtri in `buildPlayerPropMarkets`)

Queste NON contano come "seconda giocata squadra": vivono in una sezione player dedicata. Vanno comunque presentate in modo ordinato (le migliori per confidenza/EV), non come lista indiscriminata di tutti i giocatori.

### Schermate interne

Le analisi interne di apprendimento non devono essere mostrate all'utente finale.

Restano interne:
- post-match learning review
- tuning adattivo
- analisi degli errori del modello
- debug dei filtri/ranking

Non reintrodurre nella UI:
- card debug
- pannelli learning
- spiegazioni tecniche EV/edge/score nel consiglio finale

### Replay

La sezione partite concluse deve restare focalizzata su:
- pronostico finale consigliato
- risultato reale
- esito della giocata

Non aggiungere rumore tecnico non richiesto.

## 7. Regole frontend

### Obiettivo UI

La UI deve essere:
- leggibile
- veloce da capire
- adatta a chi vuole consultare partite e quote rapidamente

### Vincoli UI

- privilegiare leggibilita del testo e contrasto
- mantenere il font principale orientato alla leggibilita
- usare badge e stati chiari per:
  - quote Eurobet disponibili / non disponibili
  - sync in corso / pronta
  - mercati supportati

Non introdurre:
- dashboard troppo dense
- pannelli "power user" non richiesti
- visualizzazioni decorative che peggiorano la chiarezza

## 8. Regole backend

- mantenere separazione chiara tra route, service, db e modelli
- non mettere logica pesante direttamente nelle route se puo stare in service
- nessuna assunzione MySQL/Postgres: il DB reale e `libSQL / Turso`
- evitare dipendenze inutili
- usare timeout e retry solo dove servono davvero
- non introdurre scrapers browser-based se esiste gia una fonte HTTP/JSON stabile

## 9. Regole database

- non droppare tabelle o colonne senza richiesta esplicita
- preferire evoluzioni additive e compatibili
- preservare i dati esistenti
- non sovrascrivere `team_stats_json` o altri payload in modo distruttivo
- mantenere compatibilita con `libSQL / Turso`

## 10. Docker e runtime

Questo progetto deve restare eseguibile in modo riproducibile con:

```powershell
docker compose up -d --build
```

Ogni modifica importante che tocca runtime o dipendenze deve preservare:
- build backend
- build frontend
- avvio container
- healthcheck backend

## 11. Checklist obbligatoria prima di chiudere task sostanziali

Se il task tocca codice applicativo, eseguire quando sensato:

### Backend
- `npm run build` in `backend`
- `npm test` in `backend`

### Frontend
- `npm run build` in `frontend`

### Runtime
- `docker compose up -d --build backend frontend` se il task tocca runtime, dipendenze, env o API
- verifica `http://localhost:3001/api/health`

### Regressioni funzionali minime
- verificare che `Understat` resti la sola fonte dati attiva
- verificare che gli endpoint legacy non vengano reintrodotti
- verificare che la UI non mostri quote non-Eurobet

## 12. Cose da non fare mai in questo repo

- non reintrodurre `FotMob`, `Transfermarkt` o `FBref` nel flusso attivo
- non mostrare quote fallback come se fossero Eurobet
- non mostrare learning interno/debug all'utente finale
- non aggiungere mercati non coperti bene dalla fonte dati unica
- non complicare l'architettura con microservizi o tool superflui
- non introdurre servizi a pagamento obbligatori
- non rompere la portabilita Docker-first del progetto

## 13. Regola di escalation

Se una richiesta futura entra in conflitto con queste decisioni bloccate:
- non cambiare silenziosamente il progetto
- segnala il conflitto in modo diretto
- proponi le opzioni tecniche
- procedi solo con la variante piu coerente o con richiesta esplicita
