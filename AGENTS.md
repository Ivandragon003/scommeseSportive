# scommeseSportive - Istruzioni di progetto

## Prodotto e architettura

- Web app per importare dati calcistici, calcolare previsioni pre-match, recuperare quote bookmaker e archiviare quote e replay delle partite concluse. Mantieni un'esperienza chiara e un codice portabile.
- Stack deciso: React; Node.js/Express/TypeScript; libSQL/Turso; Docker Compose. Architettura modular monolith, fruizione primaria web-first. Cambi materiali richiedono una decisione esplicita dell'utente.
- Usa software gratuito/open-source o free tier realmente utilizzabili; non introdurre provider a pagamento obbligatori, microservizi, codebase duplicate o infrastruttura superflua.

## Riferimenti secondo il task

- Avvio e configurazione: `README.md`, `docker-compose.yml` e gli script nei `backend/package.json` e `frontend/package.json`.
- Import e fonti: `backend/src/services/FootballDataService.ts`, `docs/github-actions-nightly-sync.md`; transizioni tra competizioni: `docs/competition-transitions/README.md`.
- Mercati, selezione e matching: `backend/src/services/PredictionService.ts`, `backend/src/services/playerProps.ts`, `backend/src/models/value/ValueBettingEngine.ts` e `backend/src/api/routes.ts`.
- Modelli e decisioni sperimentali: `docs/FORMULARIO-sistema-scommesse.md`, `docs/FORMULARIO-scelte-scartate.md` e il report pertinente in `docs/performance/`. Per riaprire l'ottimizzazione leggi `docs/performance/model-optimization-status-2026-07.md`.
- Quote storiche, anytime e corner/falli: `docs/performance/closing-odds-ingest-2026-07.md`, `docs/performance/anytime-scorer-e5-2026-07.md` e `docs/performance/fouls-corners-validation-2026-07.md`.
- Packaging Android: `docs/android-private-apk.md`. Sicurezza della cronologia: `docs/security/history-cleanup.md`.
- I report datati descrivono esperimenti e snapshot storici: verifica codice, configurazione e dati pertinenti prima di presentarne copertura, metriche o funzionalità come attuali. Non trasformare la loro roadmap in lavoro automaticamente autorizzato.

## Fonti e integrità dei dati

- Understat resta la fonte primaria per squadre, partite, giocatori, xG, tiri e storico.
- `football-data.co.uk` è ammessa come fonte supplementare HTTP/CSV senza browser o API key. Per statistiche incomplete (falli, corner, tiri, tiri in porta, cartellini, arbitro) conserva i valori Understat e riempi i mancanti con semantica `COALESCE`; matching per data e alias squadra. Non assumere copertura uniforme dell'arbitro fuori Premier League o disponibilità del possesso. Il servizio gestisce anche quote storiche di chiusura: preservane provenienza e distinzione dalle statistiche.
- Per aggiornamenti nightly della fonte supplementare segui il flusso della stagione corrente documentato. Lo scraper SofaScore è stato sostituito per questi campi.
- Non riattivare FotMob, Transfermarkt o FBref, né fallback silenziosi verso queste fonti, senza richiesta esplicita e motivata. Rimuovi riferimenti legacy inutili quando pertinente al task, preservando compatibilità e lavoro estraneo.
- Preferisci HTTP/JSON stabile; non introdurre scraper browser quando esiste questa alternativa. Il blocco del mercato falli non autorizza autonomamente scraping bookmaker o nuovi provider a pagamento.

## Quote e mercati

- Sono ammesse quote di più bookmaker reali, sempre con bookmaker e provenienza veritieri, tracciati nel campo `source` dello snapshot. Non attribuire a Eurobet o ad altri operatori quote che non hanno espresso.
- Quote sintetiche o completate dal modello (incluse `*_plus_model_completion`) restano interne: non mostrarle come quote bookmaker e non usarle per calcolare value o dimostrare ROI/CLV, perché il confronto sarebbe circolare. Se manca una quota reale, mostra la sua indisponibilità.
- Fallback tecnici possono evitare blocchi backend, completare logica interna o salvare diagnostica/snapshot, rispettando questi confini.
- Mercati previsti: 1X2, doppia chance, draw no bet, goal/over-under, BTTS, tiri, tiri in porta, cartellini totali over/under e handicap europeo/asiatico. Exact score serve solo a probabilità interne e analisi: non richiedere il mercato bookmaker `correct_score`, escluso dalla selezione operativa.
- Per `alternate_totals_cards` confronta Total Cards/Bookings con **booking points**, non soli gialli: `cardsTotalOver/Under` e settlement `cards_total` usano gialli + 2 × rossi. Understat rappresenta ogni espulsione come 0 gialli + 1 rosso; non restringere ai soli rossi diretti. Riferimento: `bookingPoints` in `backend/src/utils/dataHelpers.ts`.
- Player props: tiri, tiri in porta, gialli e marcatore anytime (`player_goal_scorer_anytime`). Richiedono quota reale per giocatore/mercato/linea, matching non ambiguo e campione sufficiente secondo `buildPlayerPropMarkets`.
- Corner e falli sono desiderati, ma il dato statistico disponibile non basta ad attivarne le giocate. Conserva i blocchi di `DISABLED_CATEGORIES` e i filtri EV finché un backtest di mercato con quote reali non giustifica lo sblocco. Non presentare mercati come forti senza validazione reale.
- Nelle verifiche di luglio 2026 il provider supportava `alternate_totals_corners`, `alternate_spreads_corners`, `alternate_team_totals_corners`, `corners_1x2`, `alternate_totals_cards`, `alternate_spreads_cards`, `player_shots`, `player_shots_on_target`; le chiavi generiche `corners`, `shots`, `shots_on_target`, `cards` erano invalide. Prima di cambiare l'integrazione verifica la documentazione ufficiale corrente e le chiavi già usate nelle route.
- Il mercato falli resta non attivabile secondo la decisione documentata: le verifiche del luglio 2026 non trovavano quote disponibili dal provider o alternative gratuite adeguate. Una nuova evidenza va valutata esplicitamente; le quote generate dal modello non rimuovono il blocco.

## Direzione del modello

- L'ottimizzazione incrementale del modello è considerata chiusa secondo il report di luglio 2026. Non riproporre micro-ottimizzazioni goal senza ipotesi sostanzialmente nuova e metrica non già testata.
- L'esperimento opzionale di calibrazione/dispersione tiri richiede valutazione indipendente dalla selezione sulla pipeline completa: GO solo se il miglioramento sopravvive a calibrazione e blending su almeno 4/5 leghe. Verifica nel report e nel codice se l'esperimento è ancora aperto prima di proporlo.
- Per nuove priorità usa la roadmap documentata (quote storiche, statistiche giocatore, dati inutilizzati, igiene dati, mercati per tempo e corner), verificando quanto è già stato implementato. In particolare, non riproporre anytime o ingest di chiusura come assenti basandoti solo sul report iniziale. Recent Form ha un precedente NO-GO: collegare dati non prova un miglioramento.

## Presentazione e UX

- Una sola giocata finale consigliata sui mercati squadra per partita, con motivazione breve e comprensibile. Player props in una sezione distinta e ordinata per confidenza/value, senza elencare indiscriminatamente tutti i giocatori.
- Mantieni interne learning review post-match, tuning adattivo, analisi degli errori e debug di filtri/ranking. Non aggiungere pannelli debug/learning o spiegazioni tecniche EV/edge/score nel consiglio finale.
- Replay focalizzato su pronostico consigliato, risultato reale ed esito della giocata.
- Testi leggibili, contrasto adeguato, font chiaro e stati espliciti per disponibilità delle quote reali e relativo bookmaker, sincronizzazione e mercati supportati. Evita dashboard dense, pannelli avanzati non richiesti e visualizzazioni decorative che ostacolano la lettura.

## Backend, database e sicurezza

- Separa route, servizi, database e modelli; la logica pesante appartiene ai servizi. Introduci dipendenze, timeout e retry solo dove necessari.
- Mantieni compatibilità libSQL/Turso, senza assunzioni MySQL/PostgreSQL. Evoluzioni additive e compatibili; preserva dati e payload come `team_stats_json`. Drop di tabelle/colonne richiedono richiesta esplicita.
- Mantieni segreti e credenziali fuori da sorgenti, log, output condivisi e Git. Usa configurazione locale e ambiente previsti dal progetto.
- Rispetta i confini di autorizzazione globali per operazioni esterne o distruttive; segnala conflitti con decisioni di prodotto senza cambiarle silenziosamente. Non includere modifiche estranee nei commit.

## Verifica e completamento

- Usa i controlli pertinenti alla modifica e gli script effettivi nei package. Backend: `npm test` include già la build; `npm run typecheck` e `npm run lint` quando pertinenti. Frontend: `npm run test:ci`, `npm run build`, typecheck/lint secondo lo scope. Evita ripetizioni della stessa build senza necessità.
- Per runtime, dipendenze, ambiente o API preserva build, avvio e healthcheck: `docker compose up -d --build backend frontend` e `http://localhost:3001/api/health`. L'avvio completo riproducibile resta `docker compose up -d --build`; esegui la verifica runtime quando pertinente al task.
- Per modifiche a fonti o quote verifica priorità Understat con supplemento consentito, assenza di riattivazione legacy e provenienza reale delle quote mostrate da qualsiasi bookmaker ammesso.
- Per sole istruzioni o documentazione verifica diff, coerenza e riferimenti senza avviare test applicativi o chiamate provider non necessarie. Riporta controlli eseguiti e limiti; non equiparare una verifica mirata all'intero gate applicativo.
