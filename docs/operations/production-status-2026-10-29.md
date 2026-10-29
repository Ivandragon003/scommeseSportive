# FootPredictor: stato della produzione, 29 ottobre 2026

**Deploy web completato. Sistema automatico T−15 non completato: il worker
standalone Hostless ha entrambi i deployment falliti per timeout di coda.
Il cron watchdog è operativo in modalità worker spento: 14 check reali `ok`
nei Logs, sebbene la lista Runs resti vuota.**
Scheduler T−15 e nuove registrazioni shadow restano disabilitati. Nightly di
manutenzione e cron watchdog sono attivi. Nessun ciclo prospettico
reale completo è stato dichiarato. I report storici e i benchmark restano immutati.

## A. Hostless

- Progetto: `Ivandragon003's Project`, ID `6a838a83424e48848fce82b0`, verificato
  nel browser integrato. Ruolo `Editor`, impostazioni e deploy accessibili;
  lettura della fatturazione non disponibile con i permessi correnti.
- Backend `scommese-sportive-backend`: repository
  `Ivandragon003/scommeseSportive`, branch `main`, Docker, directory e contesto
  `/backend`, `Dockerfile`; start/post-build personalizzati vuoti. Una replica
  fissa, 0,1 vCPU/256 MiB, massimo una replica.
- Frontend Site `scommese-sportive-frontend`: stesso repository/branch,
  directory e contesto `/frontend`, installazione `npm ci`, build
  `npm run build`, output `./build`.
- Revisione web ancora LIVE: `122fd360994f84ca0d405cf25a9734cf48e94431`.
  Backend `6ae3213f30465a147074f461`; frontend `6ae322cd7b2d5d826aa0c130`.
- Deployment manuale backend della revisione `60a6baac` richiesto alle 15:18
  CET, ID `6ae355cd7b2d5d826aa4c4c4`, ancora in coda. Al checkpoint 15:21
  backend e frontend restano LIVE `122fd360`; nessun nuovo deploy frontend.
  Auto-deploy disattivati. Login/sessione, calendario e dashboard A/C verificati;
  health `200`, route legacy `410`, API research anonima `401`.
- Il worker embedded `footpredictor-t15`, ID `6ae3240430465a1470752801`, resta
  preservato e disabilitato: record presente, deployment `missing`, `ready=false`,
  gestione ambiente `404`/`App worker not found`. Nessuna causa radice dimostrata.
- Il proprietario ha completato l'autorizzazione della GitHub App: il wizard
  ora conferma `Connected as Ivandragon003`, un repository accessibile, ed è stato
  selezionato esattamente `Ivandragon003/scommeseSportive`, branch `main`.
  Il precedente limite di accesso GitHub è risolto, senza disconnettere la
  connessione legacy. Non è presentato come causa o soluzione del guasto embedded.
- Creato il worker ufficiale standalone `footpredictor-t15-standalone`, ID
  `6ae33d3659ba816e50f640fd`, il 29 ottobre alle 13:33 CET. Tier `FREE`, una
  replica; CPU minimo 0,01/massimo 0,1 vCPU, RAM minimo 128/massimo 256 MiB,
  `scaledDown=false`, `overdue=false`, `autorelease=false`. Configurate in
  sicurezza 22 variabili necessarie, senza mostrarne i secret.
- Il wizard aveva selezionato `ed9e58ad`: deployment iniziale
  `6ae33d3659ba816e50f6410b`. Dopo la correzione nativa pubblicata, richiesto
  esplicitamente alle 13:37 CET il deployment `6ae33df530465a14707721ec` da
  `cc842005dfd994bc21f787604b107436f5544bc1`.
- **Standalone non operativo:** lista verificata alle 15:14 CET, entrambi
  i deployment `6ae33d3659ba816e50f6410b` (`ed9e58ad`) e
  `6ae33df530465a14707721ec` (`cc842005`) falliti con
  `Deployment waited too long in the queue`. Risorsa `Sleeping`; nessun avvio
  build, processo o heartbeat dimostrato. Il messaggio identifica il timeout
  di attesa, non la causa della coda. Nessun nuovo tentativo worker creato.
  Il dialogo Restart richiedeva un ultimo deployment riuscito, assente: annullato
  con `No`, senza eseguire un restart generico.
- Il comando iniziale esegue C smoke in sola lettura, E2E sintetico con ambiente
  isolato, poi attesa inattiva con scheduler `false`. Non c'è un ciclo di
  riavvii automatici dei test; un'eventuale partenza non abilita puntate.
- I precedenti tentativi cron embedded sono falliti con `400`. È poi stato
  creato tramite UI il cron standalone `footpredictor-watchdog`, ID
  `6ae3434030465a1470779a0f`, alle 13:59 CET
  (`2026-10-29T12:59:44.237Z`): tier `FREE`, Custom
  0,1 vCPU/128 MiB, ogni cinque minuti UTC, auto-deploy disattivato. Otto
  variabili, nessuna chiave quote, sorgente `cc842005`, `scaledDown=false`;
  worker atteso disabilitato. Il preset
  Small da 0,25 vCPU richiedeva una carta per capacità gratuita residua
  indicata di 0,2 vCPU: annullato, poi configurazione Custom accettata.
- La UI del cron mostra due deployment riusciti, entrambi `cc842005`: LIVE
  delle 15:11 `6ae3540c7b2d5d826aa4a15c` e originale delle 13:59
  `6ae3434030465a1470779a1f`. La pubblicazione del cron è confermata anche
  dall'avviso della piattaforma. Runs resta vuoto e gli stati UI oscillano,
  ma la ricerca `"ok"` nei Logs restituisce 14 check reali riusciti ogni cinque
  minuti, dalle 14:10:21 alle 15:15:13 CET (`13:10:21Z`–`14:15:13Z`). Il comando
  SELECT-only è operativo con worker atteso spento; Runs non rappresenta le
  esecuzioni effettive. I ritardi di output rispetto all'intervallo cron,
  7–21 s, non sono misure di runtime o puntualità T−15. Riferimento privato:
  `backend/artifacts/backups/production-20261029-1029/watchdog-hostless-success-timeline.json`.
- Il controllo operativo di stato fatturazione visibile nella UI restituisce
  `200`, `state=current`, `restoring=false`, alle 14:04 CET. Non sono stati
  letti saldo o fatture: non è una verifica dei costi retroattivi e non
  dimostra la causa della coda.
- Nessuna carta, cambio di piano o risorsa a pagamento attivata. La fatturazione
  effettiva resta non verificata. Il report tecnico è stato inviato su esplicita
  autorizzazione dell'utente alla chat ufficiale Hostless Support, circa alle
  14:29 CET del 29 ottobre; invio verificato subito dopo, alle 13:30:17 UTC.
  Hostless ha confermato la ricezione dei dettagli e delle richieste di
  preservare servizi/database senza attivare risorse a pagamento. Non ha ancora
  fornito diagnosi o correzione. L'errore concreto di timeout in coda è stato
  poi inviato nello stesso caso; nessuna nuova diagnosi.
  [Scheda del blocco](hostless-blocker-2026-10-29.md).
  Testo e screenshot di prova sono conservati soltanto negli artifact privati
  del backup locale, esclusi da Git; nessun token del widget o dato di posta
  viene pubblicato.

## B. GitHub e vecchia automazione

- Pubblicata prima la patch isolata
  `e046bc4fb625d64910ea63d250330c4f47117368`, poi il codice completo `122fd360`
  su `main`. Remote verificato: `Ivandragon003/scommeseSportive`.
- Workflow e script nightly remoti riletti e confrontati con la patch:
  nessuna chiamata `place-valid-bets`, `AUTO_BET` o `/bets/place`.
- `Nightly Sync`, ID `253787848`, riattivato (`active`). Run manuale
  [40857398332](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40857398332)
  riuscito; il log conferma manutenzione senza registrazione futura.
- Dopo il run: 258 giocate, ultima creazione `2026-10-25T07:09:40.275Z`,
  invariati rispetto al controllo precedente. Nessuna nuova giocata nightly.
  Import, manutenzione e liquidazione restano nel workflow.
- La nuova release backend risponde `410` sul POST alla route legacy anche
  anonimo: il ritiro è verificato sul remoto, oltre alla rimozione del chiamante.
- CI della revisione `122fd360`, run
  [40858594561](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40858594561):
  Backend e Frontend completati con successo.
- `Prepare prediction calibration`, sospeso per evitare bootstrap concorrente
  durante il rilascio, è stato riattivato (`active`). Training settimanale e
  watchdog sono pubblicati; nessun training nuovo è stato forzato per il deploy.
- Correzione della contesa nativa locale pubblicata in
  `cc842005dfd994bc21f787604b107436f5544bc1`; il web LIVE resta `122fd360`.
  CI [40874265295](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40874265295)
  riuscita: 768 test backend, 767 superati, un test opzionale saltato, zero
  fallimenti. Preparazione calibrazione
  [40874265300](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40874265300)
  riuscita. Il successo non certifica un avvio del worker, i cui deployment sono falliti in coda.
- L'identità della cache calibrazione dipende dall'intero `dist`: warmup e
  deploy devono usare la stessa revisione. Il warmup `60a6baac` è riuscito e
  la sua immagine di produzione ha superato il gate cache locale SELECT-only
  sul Turso reale: 40 profili per passaggio, 80 hit validi, 100 SELECT, cinque
  leghe e due istanze fresche di PredictionService; zero fit, scritture o
  chiamate provider. Non prova il fix sul runtime Hostless o la causa dei
  warning CPU. Il deploy della stessa revisione resta in coda.
- Correzione osservabilità quote e relativa nota tecnica pubblicate su `main`
  in `60a6baac666920ec494dd416e064990cd220435b`, push verificato. CI
  [40889233354](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40889233354)
  conclusa con successo: 777 test backend, 776 passati, un opzionale saltato,
  zero fallimenti; lint, typecheck e build frontend superati. Calibrazione
  [40889233171](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40889233171)
  conclusa con successo, warmup compreso. Il web LIVE rimane `122fd360`.
- Watchdog GitHub ancora manuale; manca `TURSO_WATCHDOG_READONLY_TOKEN` e il suo
  contratto non è stato modificato. Il processo web e la nightly non avviano T−15.

## C. Turso, backup e integrità

- Database esistente confermato:
  `libsql://scomessesportive-ivandragon003.aws-eu-west-1.turso.io`.
- Credenziali applicative esistenti riutilizzate; SQL verificato con token `rw`,
  senza esposizione o rigenerazione. Accesso SQL e amministrazione della
  piattaforma sono distinti; non è servito un nuovo accesso amministrativo Turso.
- Prima delle migrazioni: 8.834 partite, 10.915 snapshot quote, 183.913 previsioni,
  258 giocate, un budget, una sessione budget, due utenti e quattro sessioni
  amministrative. Sono conteggi osservati, non una metrica di qualità predittiva.
- Backup coerente `/dump`: 445.882.733 byte, SHA-256
  `00403b5a72a69f07c57928e3e5d75f70dbf3fd29878ca18bbc58de2f640f9462`.
  Riferimento privato locale, escluso da Git:
  `backend/artifacts/backups/production-20261029-1029/manifest.json`.
  ACL limitate a utente corrente, SYSTEM e amministratori.
- Ripristino isolato completo: 29 tabelle, `integrity_check=ok`, zero violazioni
  delle chiavi esterne, manifest `complete=true`.
- Migrazioni `015–019`, compresa `018`, applicate due volte su una copia isolata:
  conteggi e hash dei contenuti delle 29 tabelle esistenti invariati, integrità
  `ok`, zero violazioni FK. L'archivio di ripristino originale è rimasto intatto.
- Migrazioni remote `015–019` poi applicate; registro con 20 versioni, inclusi
  i due prefissi storici `007`. `integrity_check` remoto post-deploy: `ok`.
- Confronto post-deploy con il backup: righe e valori di `bets` (258), `budgets`
  (1) e `budget_sessions` (1) identici (`byteEquivalentValues=true`). Nessuna
  cancellazione, nuovo database o ripristino sopra la produzione.
- Il manifest dichiara `quotaReviewedByOperator=false` e
  `quotaCheckWaivedByUser=true`: la verifica quote account è stata omessa su
  istruzione diretta dell'utente, senza dichiararla eseguita.
- Backup periodico, retention esterna e disponibilità del PITR restano da
  configurare/verificare. Il backup manuale locale non è un servizio continuativo.

## D. Modelli e mercati

- Registry reale: A `A-80cb25df5552621e`, C `C-906371b0b3a1e2c8`.
  Registrazione via CLI autorizzata con artefatti esistenti, senza retraining.
  A resta riferimento; nessun Champion C, nessuna promozione.
- C usa `joint-goal-coherent-v2`, è compatibile con la baseline A registrata e
  conserva `productionValidated=false`. I 26 mercati restano `EXPERIMENTAL`.
- **Inferenza CatBoost verificata su Hostless:** terminale dell'app backend,
  Node 20.20.2/Linux, artefatto C letto dal Turso reale, 1.000 chiamate
  `predictHybrid`, probabilità valide e somma 1; p95 circa 0,5125 ms,
  RSS massimo 105,75 MiB. Input sintetico, zero chiamate provider e zero scritture DB.
- Questa prova dimostra caricamento/inferenza nel runtime Hostless, non un
  ciclo pre-match reale A/C, puntualità T−15 o qualità delle previsioni.
  Python resta training/parità; l'inferenza di produzione è JSON CatBoost in Node.
- Il codice ammette registrazioni soltanto per mercati `SHADOW`/`ACTIVE` con
  evidenze indipendenti coerenti. `EXPERIMENTAL` resta escluso anche dai portafogli
  shadow. Il collaudo tecnico non promuove modelli o mercati e non aggira i gate.
- Registry, validazione cronologica e rollback sono conservati. Nessun test
  storico finale è stato riutilizzato per ottimizzare modelli durante il deploy.

## E. Quote

- Provider reale: The Odds API; nessun provider, chiave o abbonamento aggiunto.
  Manager persistente, scope `primary`, limite 500 crediti/mese, riserva 50.
- Il probe gratuito `/v4/sports` delle 11:03:11 UTC aveva misurato 280 usati,
  220 residui e costo zero. Il successivo audit autorizzato, eseguito tra
  14:02:31 e 14:02:56 UTC (15:02 CET), ha effettuato **cinque richieste reali,
  15 crediti complessivi**, portando il residuo da 220 a **205** e l'usato a 295.
- Richiesti soltanto `h2h`, `spreads`, `totals`, tre crediti per ciascuna lega.
  La risposta include anche `h2h_lay`: è un campo restituito dal provider,
  non un mercato aggiunto alla selezione operativa automatica.

| Lega | Eventi futuri | Record di mercato | Entro 5 minuti al controllo | Obsoleti |
| --- | ---: | ---: | ---: | ---: |
| Serie A | 12 | 575 | 575 | 0 |
| Premier League | 21 | 883 | 883 | 0 |
| La Liga | 20 | 737 | 727 | 10 |
| Bundesliga | 18 | 717 | 681 | 36 |
| Ligue 1 | 18 | 673 | 673 | 0 |
| Totale | 89 | 3.585 | 3.539 | 46 |

- Nessun record con timestamp di mercato mancante. I 46 record oltre cinque
  minuti sono esclusi dall'ammissione temporale; i 3.539 freschi descrivono
  l'istante dell'audit e non rimangono validi indefinitamente o per futuri T−15.
- Eurobet non restituito in nessuna delle cinque leghe. Tra i bookmaker reali
  osservati: Codere (IT), Pinnacle, Betfair, William Hill, Unibet nelle varianti
  restituite, Betclic (FR), Betsson e altri. Conservati nomi e fonte reali;
  nessuna attribuzione o quota sintetica Eurobet.
- La cache e il budget condivisi hanno conservato richieste e contatori. L'audit
  è Linux locale → provider/Turso, **non** un'esecuzione del worker Hostless,
  una decisione T−15 o una prova di copertura continua al 100%.
- Digest delle otto tabelle protette invariati dopo l'audit: `bets`, `budgets`,
  `budget_sessions`, `research_portfolios`, `research_bets`, `research_decisions`,
  `research_jobs`, `research_models`. Scheduler T−15 e nuove registrazioni shadow
  restano disabilitati: nessuna decisione, puntata o modifica contabile creata
  da queste richieste. Nightly di manutenzione e cron watchdog sono attivi.
- Report completo privato, escluso da Git:
  `backend/artifacts/backups/production-20261029-1029/quote-acceptance/provider-quote-acceptance.json`.
  Sono pubblicati solo questi aggregati, non risposte raw, credenziali o backup.
- L'ultima dashboard autenticata conferma limite 500, residuo provider 205,
  usato 295, sei prenotazioni di rete (un probe da zero crediti e cinque
  richieste quote da tre crediti), ultimo recupero quote alle 15:02 CET.
  Sessione valida; portafogli invariati.
- Il piano contrattuale gratuito e il reset di fatturazione non sono attestati
  dai soli contatori. Nessuna rotazione di chiavi/account o acquisto effettuato;
  il limite di freschezza resta cinque minuti e la riserva configurata resta 50.

## F. Automazioni, monitoraggio e notifiche

- Scheduler T−15 non abilitato; nessun heartbeat, job decisionale, puntata shadow
  o puntualità remota verificati. Dopo refresh, Sistema conferma `Fermo`.
  I due deployment standalone falliti in coda non hanno eseguito i collaudi preparati.
- Contratto nel codice: polling 15 s, target T−15, tolleranza 60 s, quote massimo
  300 s, nessun recupero retroattivo o dopo kickoff, lease e vincoli persistenti.
- E2E Docker isolato senza rete, 0,1 vCPU/256 MiB: 135 partite storiche fixture,
  tre match simultanei, sei puntate A/C simulate, due worker, restart/subentro
  e liquidazioni senza duplicati. Picco 168,76 MiB, polling osservato 14,316 s,
  coorte 3,542 s, restart 2,096 s, settlement 0,214 s. Sono prove locali
  sintetiche, non esecuzioni del worker Hostless o eventi reali.
- Cron standalone watchdog operativo: due deployment `cc842005` riusciti e
  14 check reali `ok` nei Logs ogni cinque minuti nella finestra sopra indicata.
  La lista Runs vuota è incompleta rispetto ai Logs. I Logs confermano
  `expectedEnabled=false`: il worker è intenzionalmente spento e non sono
  attesi allarmi per questo stop. Nessun nuovo canale gratuito collegato e
  nessuna consegna di notifica provata.
  Lo script SELECT-only è passato anche separatamente in Docker con 0,1 vCPU
  e 128 MiB sul Turso reale: exit 0, `ok`, worker `UNOBSERVED`, nessuna issue,
  arretrato liquidazioni zero; zero scritture e zero chiamate provider.
- Il cron riusa il token applicativo `rw`, minimo accesso già disponibile,
  mentre il comando esegue soltanto letture. Non si presenta il token come
  credenziale di sola lettura; nessuna chiave quote copiata. La riduzione dei
  privilegi resta distinta dal contratto GitHub, che richiede ancora il token
  dedicato `TURSO_WATCHDOG_READONLY_TOKEN` e non lo sostituisce con quello `rw`.
- Alert Hostless preesistenti preservati: 21 regole e una destinazione. Osservati
  warning CPU alle 11:45 CET, rientro alle 12:28 e nuovo warning alle 13:44;
  High Response Time storico del 23 ottobre e fallimento embedded alle 11:46.
  L'ultimo avviso CPU indica `CPU Recovered`/`Resolved`: il warning più recente
  risulta rientrato nel controllo dei messaggi. Un ulteriore avviso appErrors
  riporta un errore senza stack; non è sufficiente ad attribuirne la causa.
  Gli avvisi di piattaforma non provano la causa dell'arresto o della coda.
- Un avviso operativo della piattaforma del 26 ottobre riconosce vincoli di
  capacità, con possibili deployment lenti e indisponibilità: è compatibile con
  lo stallo osservato, ma non ne dimostra la causa specifica. Non sono pubblicati
  messaggi privati, indirizzi o identificatori di posta.
- Alle 13:40:22 CET il POST `/scraper/odds/match` ha risposto HTTP `200` in circa
  345 ms senza quote: esito atteso con rete informativa disabilitata e cache
  priva del prezzo. Il backend ha però emesso due errori, `odds_cache_only` e
  `fixture_matching_failed`, facendo scattare l'avviso appErrors alle 13:42.
  La causa di questo falso allarme è identificata nella classificazione
  dell'astensione da policy; non è un guasto dimostrato del provider quote.
- Correzione in sei file, ora pubblicata in `60a6baac`: 66/66 test mirati, typecheck, build e lint
  superati; revisione finale senza blocchi. Corretto anche il conteggio API:
  `requestsObserved` resta il totale osservato, `attemptsObserved` distingue i
  tentativi, `requestsSkipped` gli skip, esclusi dai tassi; le righe sono
  marcate `skipped`. **Non ancora distribuita**: il web
  `122fd360` mantiene per ora la classificazione precedente. Nessuna nuova
  richiesta quote o variazione del budget per correggerla.
  Il `503` del percorso bulk e il relativo errore HTTP restano intenzionalmente
  invariati: non si promette assenza di log ERROR per quel percorso.
  [Nota tecnica](odds-cache-policy-2026-10-29.md).
- Riepilogo in-app dalla prima riconciliazione stabile dalle 09:00 Europe/Rome,
  deduplicato; incidenti tecnici immediati, nessuna notifica per singola puntata.
  Nessun nuovo canale esterno è stato attivato; gli alert Hostless erano già presenti.

## G. Portafogli e contabilità

Rilettura dell'app autenticata alle 15:21 CET: entrambi i portafogli ancora
a 1.000 euro, zero impegnato e zero puntate; nessuna scrittura di collaudo.

| Portafoglio | Disponibile | Impegnato | Patrimonio | Puntate |
| --- | ---: | ---: | ---: | ---: |
| `shadow_A` | 1.000 EUR | 0 EUR | 1.000 EUR | 0 |
| `shadow_C` | 1.000 EUR | 0 EUR | 1.000 EUR | 0 |

I due portafogli sono stati realmente inizializzati sul Turso condiviso, con
ledger di apertura separati da 100.000 centesimi. Nessun `main`, capitale
combinato o fusione con il budget legacy. Stake previsto 1%, esposizione 5%,
massimo una puntata per partita/modello. Non sono state registrate puntate
shadow: nessuna liquidazione shadow reale o relativa variazione del saldo è
quindi ancora verificabile. La contabilità legacy è conservata come sopra.
Il refresh della dashboard di produzione conferma per ciascun portafoglio
1.000,00 EUR, zero impegnato e zero puntate, coerenti con le letture SQL.

## H. Verifiche e limiti

- Checkpoint remoto delle 15:21 CET sulla versione ancora LIVE `122fd360`:
  health anonimo `200`, POST legacy `410`, ricerca anonima `401`; nuovo accesso
  autenticato riuscito e sessione funzionante. Non è un test remoto del fix `60a6baac`.
- Gate cache locale dall'immagine di produzione `60a6baac` verso Turso reale:
  40 profili per passaggio, 80 hit validi, 100 SELECT, cinque leghe e due
  istanze fresche di PredictionService; zero fit, scritture o provider.
- CI reale aggiornata `60a6baac`, run `40889233354`: successo, 777 test backend,
  776 superati, un opzionale CatBoost saltato, zero fallimenti; frontend lint,
  typecheck e build superati. Calibrazione `40889233171` riuscita.
- CI reale `cc842005`, run `40874265295`: 768 test backend, 767 superati,
  un test opzionale saltato, zero fallimenti; calibrazione `40874265300` riuscita.
  Il test opzionale è
  `real CatBoost training compares three candidates and exported JSON matches Python inference`.
- Suite locale della correzione nativa: 768/768 superati; typecheck e lint
  superati in quel primo controllo. L'ultimo gate Windows sulla patch odds
  **non è passato**: 777 asserzioni singole verdi, ma crash nativo
  `0xC0000005` del file ResearchStore, pur con 31/31 sue asserzioni passate.
  Non è dimostrato un nesso causale con la correzione nativa né che il crash
  sia preesistente. Dettagli e distinzione dello stress non recuperabile nella
  [nota sull'avvio locale](local-research-startup-2026-10-29.md).
- Frontend CI della revisione web `122fd360`: lint, typecheck e build superati;
  test frontend locali 175/175. Python locale: 13/13; monitoring mirato: 12/12.
- Correzione cache-only pubblicata in `60a6baac`, non ancora sul web LIVE:
  66/66 mirati e revisione finale senza
  blocchi; il gate Linux completo è ora superato, mentre il crash Windows
  resta un limite non risolto e non viene presentato come successo.
  L'indagine limitata ha osservato: baseline prima di `cc842005`, 12 run con
  11 riusciti e uno con `SQLITE_BUSY` legacy, nessun crash nativo; il corpus
  precedente di 26 test sul file corrente può ancora terminare nativamente;
  un riproduttore del solo driver, 1.360 cicli di contesa, non è andato in crash.
  Queste prove non identificano ancora la causa; nessun aggiornamento dipendenze
  o correzione speculativa è stato applicato.
- Gate Linux isolato Node 20, preparato da 534 soli file tracciati, circa 10 MB,
  senza ambiente o credenziali e con rete disabilitata. Limiti **della suite QA**:
  2 CPU/1 GiB, non dimensionamento del worker di produzione.
  Prima esecuzione: 777 test, 772 superati, quattro falliti perché Python
  mancava nell'immagine QA dei test backup, un opzionale saltato. L'immagine
  QA privata è stata ricostruita con `python3` e `python-is-python3`:
  **run completo Linux riuscito, 777 test, 776 superati, un opzionale CatBoost
  saltato, zero fallimenti**. Nessun cambiamento al Dockerfile di produzione:
  CatBoost continua a inferire in Node senza Python. Il fallimento nativo
  Windows resta distinto e non è stato risolto da questa verifica Linux.
- Scansione storia candidata: unica segnalazione verificata come assertion
  sintetica in `hostless-integration.js:263`, non una credenziale.
- Remoto verificato: deploy web `122fd360`, autenticazione/sessione,
  calendario/dashboard, integrità DB e migrazioni, registry, inferenza C
  sintetica, quota probe persistente, nightly e ritiro legacy. L'audit reale
  quote a cinque leghe è stato eseguito separatamente da Linux locale verso
  provider/Turso, preservando i digest delle otto tabelle protette.
- Watchdog SELECT-only: 14 check reali `ok` nei Logs Hostless dalle 14:10:21
  alle 15:15:13 CET, oltre alla prova Docker sul Turso reale senza scritture
  o provider. Monitor operativo con worker atteso spento; consegna notifiche
  e rilevamento di un guasto del worker abilitato ancora da collaudare.
- Android: compatibilità nel codice conservata; nessun dispositivo reale collaudato.
- **Nessun ciclo prospettico reale completo**, nessuna prova di uptime,
  heartbeat, restart o puntualità del worker Hostless. La creazione delle
  risorse e i test locali non sostituiscono questi gate.

## I. Esito e intervento indispensabile

| Domanda finale | Risposta verificata |
| --- | --- |
| Nuova versione pubblicata? | Sì, frontend e backend `122fd360` online su Hostless. |
| Vecchia registrazione nightly disabilitata? | Sì: chiamante rimosso, nightly riuscita senza nuove giocate, endpoint remoto `410`. |
| Worker T−15 operativo? | No: embedded mancante/ambiente `404`; entrambi i deployment standalone falliti per timeout in coda, senza heartbeat. |
| Watchdog indipendente operativo? | Sì: 14 check SELECT-only `ok` nei Logs Hostless, con worker atteso spento. Runs vuoto non rappresenta le esecuzioni; notifiche e guasto di un worker abilitato non collaudati. |
| A e C funzionano in remoto? | Registry e baseline compatibili; inferenza C su Hostless riuscita con input sintetico. Ciclo reale A/C non completato. |
| Shadow Betting attivo? | No: scheduler T−15 spento, mercati `EXPERIMENTAL`, zero puntate. |
| Turso esistente collegato? | Sì, migrazioni e letture/scritture autorizzate verificate, contabilità legacy preservata. |
| Opera con PC e smartphone spenti? | Il web sì; il processo automatico completo non è operativo. |
| Cosa resta? | Risoluzione timeout worker e collaudo notifiche del watchdog già operativo, rilascio web `60a6baac` con warmup allineato, freschezza quote al T−15, gate mercati e primo ciclo reale con liquidazione. CI e calibrazione riuscite; Windows mantiene un limite nativo non risolto. |
| Costi aggiuntivi? | Nessun piano/carta/servizio a pagamento attivato. Fatturazione effettiva account non verificata. |
| Serve il proprietario? | Autorizzazione GitHub completata. Il timeout dei deployment è stato segnalato all'assistenza Hostless, che ha confermato ricezione senza diagnosi o soluzione. Nessun nuovo token o accesso amministrativo Turso richiesto per le prove eseguite. |

Preservare web, database e storico funzionanti. Non creare ulteriori worker
per tentare di superare la coda e non abilitare due processi operativi. Attendere
uno stato pronto e verificare i log del deployment esplicito; se la coda senza
log persiste, coinvolgere proprietario/assistenza Hostless. Dopo l'avvio,
completare collaudi e notifiche del monitor indipendente già operativo, quote
fresche al T−15 e ciclo prospettico senza
forzare puntate. Backup periodico, retention e disponibilità PITR restano pendenti.

## Rollback

Disabilitare nuove decisioni e fermare il worker se necessario, mantenendo
storico e liquidazioni. Conservare migrazioni additive, ledger e portafogli.
Un rollback del codice deve preservare la patch nightly e il ritiro legacy:
la vecchia immagine senza il blocco `410` non è un ripristino sicuro automatico.
Non sovrascrivere la produzione con un backup più vecchio senza piano di
riconciliazione e autorizzazione. L'auto-deploy rimane disattivato per mantenere
controllo sulle prossime pubblicazioni.
