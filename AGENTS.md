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

`Understat` e la sola fonte dati attiva del progetto per dati calcistici.

Questo significa che squadre, partite, giocatori, xG, tiri, cartellini e storico match devono essere letti da `Understat`.

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

### Fonte quote lato utente

`Eurobet` e la fonte primaria delle quote mostrate all'utente.

Regole bloccate:
- se la quota `Eurobet` esiste, puo essere mostrata
- se la quota `Eurobet` non esiste, non va mostrata nessuna quota su quella giocata
- non mostrare all'utente quote da fallback alternativi come se fossero Eurobet
- non mostrare quote stimate dal modello come quote bookmaker utente

### Fallback tecnici

Sono ammessi fallback tecnici interni solo se servono a:
- non bloccare il backend
- completare logica interna
- salvare diagnostica o snapshot

Ma lato UI:
- la quota utente deve restare Eurobet-only

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

### Mercato voluto ma bloccato sulla copertura dati

- `fouls` — **il proprietario vuole questo mercato**, ma con la fonte attuale NON e attivabile in modo affidabile: i falli reali sono presenti solo nell'1-2% dei match Understat (verificato su 7.082 partite). Attivarlo ora significherebbe girare su default inventati e mostrare Over/Under falli non fondati sul dato.
  - Condizione per attivarlo: abilitare una fonte supplementare che copra i falli per-partita (es. `SofaScoreSupplementalScraper`, oggi disattivato, oppure FBref), poi ricalcolare le medie per-lega e validare in backtest.
  - Fino ad allora `fouls` resta fuori dal ranking value, ma NON perche non lo si voglia: e un blocco tecnico da rimuovere quando arriva il dato.

### Mercati da non riattivare automaticamente

- `corners` — stesso limite dei falli (dato reale ~1-2%). Non riattivare senza fonte unica coerente che copra i corner per-partita.

Motivo del blocco falli/corner:
- in configurazione `Understat-only` questi dati non sono coperti come totali reali affidabili
- quindi non devono essere rimessi nel ranking o mostrati come mercati forti solo per "riempire" la UI, finche non esiste una fonte dati che li copra

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
