# scommeseSportive - Istruzioni di progetto

## Prodotto e architettura

- Web app per importare dati calcistici, calcolare previsioni pre-match, recuperare quote bookmaker e archiviare quote e replay delle partite concluse. Mantieni un'esperienza chiara e un codice portabile.
- Stack deciso: React; Node.js/Express/TypeScript; libSQL/Turso; Docker Compose. Architettura modular monolith, fruizione primaria web-first. Cambi materiali richiedono una decisione esplicita dell'utente.
- Usa software gratuito/open-source o free tier realmente utilizzabili; non introdurre provider a pagamento obbligatori, microservizi, codebase duplicate o infrastruttura superflua.

## Documentazione corrente e riferimenti secondo il task

- `README.md` è il punto di ingresso unico. Ogni tema ha una guida canonica collegata; non aggiungere resoconti datati, roadmap duplicate o snapshot di saldi, crediti e deploy come descrizione del prodotto.
- Le sole decisioni storiche da conservare come documentazione sono le scelte scartate in `docs/FORMULARIO-scelte-scartate.md`. I dati di prova immutabili restano distinti dalle istruzioni operative.

- Avvio e configurazione: `README.md`, `docker-compose.yml` e gli script nei `backend/package.json` e `frontend/package.json`.
- Import e fonti: `backend/src/services/FootballDataService.ts`, `docs/github-actions-nightly-sync.md`; transizioni tra competizioni: `docs/competition-transitions/README.md`.
- Mercati, selezione e matching: `backend/src/services/PredictionService.ts`, `backend/src/services/playerProps.ts`, `backend/src/models/value/ValueBettingEngine.ts` e `backend/src/api/routes.ts`.
- Architettura e modelli: `docs/SYSTEM-DESIGN.md`, `docs/models/MODEL-A.md`, `docs/models/MODEL-C.md` e `docs/FORMULARIO-sistema-scommesse.md`.
- Decisioni fallite e loro applicabilità a C: `docs/FORMULARIO-scelte-scartate.md`. Training, policy, holdout e riproduzione: `docs/research-platform.md` e `backend/ml/README.md`.
- Quote, azioni manuali e contabilità: `docs/operations/README.md`. Hosting: `docs/operations/hostless-deployment.md`; backup: `docs/operations/turso-backup.md`.
- Packaging Android: `docs/android-private-apk.md`. Genera o ricompila l'APK solo su richiesta esplicita dell'utente; una modifica web non autorizza automaticamente un nuovo pacchetto Android. Sicurezza della cronologia: `docs/security/history-cleanup.md`.
- Il codice e la configurazione descrivono il comportamento implementato; stato remoto, versione C adottata e disponibilità dei provider richiedono riscontri dell'installazione. Non trasformare un vecchio risultato o un'ipotesi del catalogo in lavoro automaticamente autorizzato.

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

- Prima di riaprire un'ipotesi leggere il catalogo delle scelte scartate. Le bocciature storiche di A non sono automaticamente risultati di C; non giustificano però di ripetere la stessa ricerca su test già consultati. Non proporre micro-ottimizzazioni goal senza ipotesi sostanzialmente nuova e confronto completo.
- L'eventuale studio di calibrazione/dispersione tiri è distinto dal modello goal C: richiede una valutazione indipendente dalla selezione nella pipeline completa, con beneficio dopo calibrazione e blending in almeno 4/5 leghe. Non presentarlo come una bocciatura già dimostrata o un miglioramento certo.
- Verificare nel codice ciò che è già implementato: ingest di chiusura, anytime, forma/riposo nelle feature C e corner concessi non vanno riproposti come assenti da vecchie roadmap. Nessuna nuova priorità o integrazione è implicita nella pulizia documentale.

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
