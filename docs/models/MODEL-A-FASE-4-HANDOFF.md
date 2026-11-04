# Modello A — passaggio di consegne Fase 4

**Preparazione tecnica avanzata, ancora bloccata; raccolta spenta; validazione statistica non conclusa.** Le Fasi 1–3 restano chiuse. Le modifiche riguardano osservazione, persistenza, riconciliazione, test e controlli. Non cambiano formule, pesi, calibrazione o blending operativi. Il [protocollo canonico](MODEL-A-VALIDAZIONE-PROSPETTICA.md) definisce campione, finestre, metriche ed esclusioni.

## Problemi risolti

| Area | Implementazione e prova |
|---|---|
| Input effettivi | `ModelAInputCapture` copia argomenti/parametri prima di Dixon–Coles, ensemble e analisi; conserva snapshot JSON, SHA-256 riproducibile, hash e timestamp locali dei componenti. Test di copia indipendente, riordino JSON, modifica rilevata e cattura fallita. |
| Provenienza temporale | `observedInputsThrough` descrive l'ultima osservazione locale. `inputAvailableThrough` resta null perché fonti, revisioni e training non hanno genealogia temporale completa. Il limite è nel payload e viene contato come non valutabile. |
| Avvio | Il costruttore di `PredictionService` avvia il recupero; il test termina un processo con SIGKILL e verifica il recupero automatico tramite quel costruttore su libSQL locale persistente, anche dopo kickoff. |
| Recupero periodico | Il timer riprova i file non confermati. Il cursore circolare evita che i primi 256 sempre falliti blocchino gli altri. Test con 257 file e con database temporaneamente indisponibile. |
| Spool | Scrittura e fsync precedono il controllo temporale e la pubblicazione esclusiva tramite hard link. Nessuna sovrascrittura per collisione ID. Lettura incrementale fino a coda piena. File corrotti/parziali conservati e diagnosticati. |
| Shutdown | Timer fermo subito; richieste HTTP già in corso ancora ammesse entro chiusura server/deadline. Poi si chiudono le ammissioni e si attende nel budget residuo anche la riconciliazione già avviata. Test con segnali simulati, richieste in corso e writer risultati bloccato. |
| Audit | `audit.ndjson` persiste tentativi, ammissioni, rifiuti/motivi, inammissibili, recuperi, conferme, errori e riepiloghi risultati. Contatori di processo e persistiti distinti. Un retry non è una nuova previsione. |
| Risultati | Cursore keyset per `match_id`, massimo 200 candidati/tick, niente sovrapposizioni sullo stesso sink. Verifica ID, squadre e kickoff quando disponibili, UTC, idempotenza e conflitti. Test con 205 casi precedenti non verificabili, rinvio, rettifica e ritorno al punteggio iniziale. |
| Copertura | CLI locale in sola lettura: calendario nello scope contro previsioni, finestre mancanti, backlog, provenienza non valutabile, struttura/indici/trigger e audit. Non pianifica inferenze né certifica completezza del calendario. |
| Golden | Manifest pre-C ed `expected.json` invariati. Eccezioni testuali separate e limitate ai blocchi autorizzati, annullate in memoria prima degli hash originali. Test contro cambi estranei, rollback e duplicati; sei scenari numerici invariati. |

Il recupero riprova idempotentemente i file ancora presenti, senza garantire recupero di rifiuti, cancellazioni o disco guasto. La barriera temporale riguarda il **contenuto sincronizzato prima del kickoff**, secondo l'orologio locale; la comparsa del nome finale non ha un timestamp indipendente. Una prova d'interruzione dopo il link conserva un `.json` e un `.partial`, restituisce un solo evento e segnala il parziale. Il controllo successivo al link rifiuta la pubblicazione se rileva il kickoff. Non viene eseguito fsync della directory: crash/power loss e supporto degli hard link richiedono prova sul filesystem previsto. I/O sincrono bloccato non può essere interrotto dalla deadline JavaScript.

Il cursore risultati è in memoria e riparte dall'inizio al riavvio; un errore singolo viene contato e ritentato al ciclo successivo. Understat è una fonte statistica, non ufficiale della competizione. Il sistema riconcilia rettifiche già presenti nel database, senza garantirne l'acquisizione dal provider. Previsioni ed esiti originali non vengono riscritti. Il SQL di associazione considera lo stesso istante kickoff anche con fusi equivalenti e applica il cutoff a osservazione e registrazione dell'esito.

## Audit della copertura e dell'ambiente

| Controllo prioritario | Evidenza verificata | Conseguenza |
|---|---|---|
| Generatore automatico A | La Nightly recommendation chiama A dopo il controllo delle quote; altri claim possono essere saltati. Web senza decisioni automatiche e worker T−15 ritirato. | Nessuna copertura universale garantita; visite utente e baseline diagnostica non la sostituiscono. |
| Finestra | La Nightly usa ora effettiva → prossima esecuzione, distinta da T−24h/T−60min del protocollo. | Contare copertura e ritardi prima di analizzare gli esiti. |
| Processo del recorder | Il workflow non esporta `MODEL_A_PROSPECTIVE_*` né configura spool persistente. Il CLI drena nel `finally`, senza handler di segnale web. | Abilitare solo il web non copre le previsioni del runner; timeout/kill restano da provare su quel processo. |
| Volume | Compose senza mount persistente. La documentazione Hostless distingue root in sola lettura, scratch temporaneo e volumi; il mount effettivo dell'account non è stato verificato. | Non equiparare una cartella al volume. Il browser locale era disabilitato; il controllo HTTP dell'healthcheck configurato ha restituito 403, senza confermare salute o configurazione. |
| Costo | I [volumi Hostless](https://docs.hostless.cloud/billing/costbreakdown) sono separati dalla quota gratuita condivisa. | Nessun volume a pagamento introdotto; serve una decisione compatibile con il vincolo economico del progetto. |
| Database | Sole `SELECT` sul target del `.env` locale: calendario presente, tabelle prospettiche assenti. Equivalenza con secret GitHub e Hostless non verificata. | Nessuna migrazione eseguita. Il nuovo ispettore consente audit del calendario anche prima del provisioning; metriche forecast non misurabili restano null. |
| Esecuzioni remote | Variabili GitHub Nightly e recommendation attive; i tre run Nightly esaminati del 4 novembre 2026 sono falliti al gate Understat. | Un flag attivo non prova che siano state prodotte previsioni; nessun rerun operativo avviato. |
| Main e produzione | Il push su `main` per i file coinvolti avvia `calibration-warm.yml`, che applica lo schema cache e salva profili usando i secret Turso; osservato anche un run push riuscito. | Merge/push su `main` sospesi. Non si aggira l'effetto con marker o modifiche silenziose al workflow. Auto-deploy Hostless non verificato. |

Le osservazioni remote sono evidenze dell'audit, non certificazioni permanenti. Ripeterle prima dell'attivazione; dettagli riproducibili nelle guide [Nightly](../github-actions-nightly-sync.md) e [Hostless](../operations/hostless-deployment.md). L'audit privato `configured-target-readonly-audit.json` registra istante, scope e identità non certificata del target; non importa `DatabaseService` e non esegue scritture o bootstrap.

Lo snapshot degli input ora conserva anche `sourceTimestamps`: dichiarazioni di `created_at` e `last_updated` già lette per fixture, squadre e arbitro, più l'eventuale osservazione dell'esito. Timestamp SQLite locali e osservazioni provider sono distinti; valori futuri/invalidi e fonti discordanti non vengono promossi a prova temporale. `inputAvailableThrough` resta null. Non vengono introdotte letture aggiuntive, filtri o ricostruzioni dei dati.

Il nuovo test del timer inserisce evidenza finale dopo l'avvio, verifica una sola osservazione attraverso più tick e poi una correzione, lasciando invariata la previsione. Non chiama manualmente il riconciliatore e non effettua richieste Understat. Dimostra il ciclo automatico locale, senza provare acquisizione remota, ufficialità o continuità del processo di destinazione.

## File interessati

- Integrazione: `backend/src/services/PredictionService.ts`; nuovo `backend/src/research/ModelAProspectiveInputs.ts`.
- Affidabilità: `ModelAProspectiveRecorder.ts`, `ModelAProspectiveSpool.ts`, `ModelAProspectiveShutdown.ts` nella cartella research.
- Esiti: `ModelAProspectiveResults.ts`, soli metodi prospettici di `backend/src/db/DatabaseService.ts`, `backend/experiments/model-a-prospective/paired-results.sql`.
- Operatore: nuovo `backend/scripts/model-a-prospective-inspect.js`.
- Test: `backend/test/model-a-prospective-*.test.js`, `operational-a-regression.test.js`, `fixtures/operational-a/authorized-source-deviations.json` e relativo README. Nuovi casi su input, monitoraggio, recovery, rotazione risultati e CLI.
- Documentazione: questa guida, protocollo prospettico e rimando nella guida A. Lo schema proposto esistente non richiede modifiche per queste aggiunte.

| Modifiche del proseguimento | File |
|---|---|
| Timestamp esistenti degli input | `backend/src/research/ModelAProspectiveInputs.ts`, `backend/src/services/PredictionService.ts`, test input e integrazione, fixture delle deviazioni autorizzate e relativo README |
| Audit prima dello schema recorder | `backend/scripts/model-a-prospective-inspect.js`, `backend/test/model-a-prospective-inspect.test.js` |
| Esiti automatici | Nuovo `backend/test/model-a-prospective-auto-results.test.js` |
| Procedure e blocchi | Questa guida, `MODEL-A-VALIDAZIONE-PROSPETTICA.md`, `docs/github-actions-nightly-sync.md`, `docs/operations/hostless-deployment.md` |

Non sono cambiati sorgenti dei modelli matematici, configurazioni/pesi, frontend, ML, lockfile, migrazioni automatiche o Docker. Distribuzione, attivazione e modifica del database operativo restano fuori dal perimetro di questi interventi locali.

## Verifiche ripetibili

Da radice, senza caricare `.env` operativo:

```powershell
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run lint
git diff --check
```

`npm test` include la build. Per i soli test mirati dopo quella build:

```powershell
$prospectiveTests = @(Get-ChildItem backend/test/model-a-prospective-*.test.js | ForEach-Object { $_.FullName })
node --test --test-concurrency=1 $prospectiveTests
node --test backend/test/operational-a-regression.test.js backend/test/ensemble-xg.test.js backend/test/prediction-context-builder.test.js
node --test backend/test/research-recommendation-runtime.test.js backend/test/challenger-runtime-integration.test.js
```

L'ispettore opzionale richiede Node >=22.13; i suoi test saltano esplicitamente su Node 20. Questa condizione non aumenta il requisito del backend. Le prove creano solo database e spool temporanei con fixture simulate.

Risultati locali correnti (Windows, Node 24.17.0, `@libsql/client` 0.14.0):

| Controllo | Risultato |
|---|---|
| Build tramite `npm test`, poi suite completa `npm run test:ci` dopo l'ultimo test aggiunto | **1.372 test: 1.371 passati, 1 fallito, 0 saltati. Gate non verde.** Il file `research-nightly.test.js` termina con `test failed` senza un errore JS dettagliato. Nel run intermedio erano falliti un diverso processo store e una pulizia `EPERM`. |
| Gruppo mirato prospettico + golden/xG/contesto + runtime A/C | **98/98 passati, 0 saltati**, inclusi calendario senza schema, timestamp locali e timer esiti; log `continuation-targeted.log`. |
| File nightly fallito, riesecuzione isolata con reporter TAP | **16/16 passati**. Non chiude l'intermittenza della suite. |
| Compatibilità Node 20 di input, timer esiti e CLI | **6 passati e 9 saltati esplicitamente**: il CLI operatore richiede Node >=22.13; il backend conserva Node 20. |
| Typecheck e lint backend, lint esplicito del nuovo CLI | Superati; nessuna dipendenza aggiunta. |
| Backend compilato effettivo, DB/spool locali temporanei, job esterni spenti | HTTP health 200; riconciliazione d'avvio confermata in audit; SIGTERM **simulato tramite IPC**, uscita 143 e drain true. Nessuna prova di segnale OS nel deploy. |
| Revisione indipendente e diff | Corretti shutdown delle richieste in corso, equità recovery, attesa risultati e semantica cutoff. Nessun nuovo difetto concreto nella revisione statica successiva; formule/configurazioni/C/Docker fuori dal diff. |

Gli artefatti locali sono sotto `artifacts/model-a-phase4/`, ignorati da Git: suite aggiornata `continuation-suite-complete.log`, gruppo `continuation-targeted.log`, `continuation-nightly-isolated.log`, `backend-smoke-final.cjs`/`.json` e `continuation-benchmark-{1,2,3}.json`. I log del primo passaggio restano separati (`backend-suite-final.log`, `targeted-final.log`, `benchmark-final-*`). Conservarli con commit e ambiente se servono al passaggio di consegne. La suite intermedia Windows/Node 20 del primo passaggio aveva riportato 1.337 test: 1.325 passati, 7 falliti e 5 saltati; fallimenti per pulizia file (`ENOTEMPTY`/`EPERM`) e arresti nativi `0xC0000005` in file SQLite. Non è la suite finale di questa revisione.

Il vecchio errore in `research-nightly.test.js` è stato riprodotto anche isolatamente su Windows/Node 24 dopo quattro run verdi: termina il processo nativo con `0xC0000005`, senza errore JavaScript. Una sonda delle fixture non ha trovato operazioni client pendenti o transazioni logicamente aperte. Non è dimostrata la causa interna del driver, né che il fallimento generico del diverso file `research-recommendation-nightly.test.js` nella suite finale abbia esattamente la stessa causa. Non sono stati aggiunti retry del processo o aggiornamenti delle dipendenze per forzare il verde. I conteggi possono variare quando un processo termina prima di scoprire tutti i test. I successi mirati non equivalgono a suite completa verde.

L'audit successivo ha separato la CI Linux dal problema Windows: su `main` il run esaminato fallisce soltanto sul vecchio hash sorgente Dixon–Coles (i sei scenari numerici e il file nightly passano). Quella CI non verifica questo branch; la correzione del controllo è già nel branch. Nel driver locale `@libsql/client` le connessioni cedute alle transazioni vengono finalizzate separatamente dalla chiusura del client. Le sonde delle fixture recommendation hanno osservato errori `EPERM` effettivamente catturati e ignorati dal cleanup; non dimostrano il nesso con il crash. Nessuna modifica a driver, dipendenze o comportamento C è stata applicata sulla base di questa sola correlazione.

## Prestazioni

Il benchmark riproducibile chiama `PredictionService` con fixture simulate, libSQL locale persistente e spool sincronizzato; non misura HTTP, Turso remoto o produzione. Da `backend`, usare una nuova directory locale dedicata per ogni prova:

```powershell
$env:MODEL_A_BENCH_DURABLE_DIR = 'C:/percorso/temporaneo/nuova-prova'
node experiments/model-a-prospective/request-benchmark.js 'C:/percorso/temporaneo/risultato.json'
Remove-Item Env:MODEL_A_BENCH_DURABLE_DIR
```

Il processo non carica `.env`; usare un ambiente senza flag recorder ereditati. Il flag cambia soltanto nel processo di prova. Non rimuovere o riusare lo spool di una raccolta effettiva. Audit e snapshot aggiungono fsync e payload: occorre una nuova misura sul volume previsto. Non sono rimossi fsync per migliorare i tempi. Senza budget di latenza concordato e prove rappresentative, l'accettabilità operativa non è dimostrata.

Tre prove indipendenti aggiornate, ciascuna con 50 chiamate e concorrenza 10, directory/DB nuovi e nessuna suite in esecuzione. Tabella: mediana delle tre misure, non percentile aggregato dei 150 eventi.

| Metrica | Recorder spento | Recorder acceso |
|---|---:|---:|
| p50 | 11,64 ms | 50,68 ms |
| p95 | 18,23 ms | 56,11 ms |
| Throughput | 762,1/s | 191,9/s |
| Intervallo p95 delle tre prove | 17,97–18,91 ms | 55,57–81,18 ms |

Ogni prova accesa ha 50 eventi accettati e 50 confermati, nessun rifiuto/errore, backlog finale zero: **150 eventi complessivi, nessuna perdita osservata**. Il costo resta materiale: circa 38 ms aggiuntivi al p95 delle fixture e throughput ridotto di circa il 75%; una delle tre prove raggiunge 81,18 ms al p95. Non confrontare direttamente questi numeri con il precedente singolo benchmark su macchina/cache diverse né attribuire la variabilità a una causa non misurata. Lettura incrementale e limiti della coda riducono il lavoro del recupero; togliere fsync dall'ammissione o dall'audit cambierebbe le garanzie. Non è stata adottata una scorciatoia prestazionale senza prova di correttezza. Non si conclude che il costo sia accettabile in produzione.

## Blocchi ancora aperti

1. **Input temporalmente verificabili.** Gli snapshot mostrano quanto osservato localmente, senza dimostrare tutte le disponibilità delle fonti e del training. Risolvere la genealogia oppure preregistrare uno studio limitato all'osservazione locale, distinto dalla validazione rigorosa richiesta. La seconda possibilità richiede una decisione del proprietario e non è adottata da questo lavoro.
2. **Volume di destinazione.** Il Compose non monta un volume spool; la guida Hostless descrive filesystem effimero. Un percorso non basta. Servono storage privato persistente, permessi reali, backup/restore, hard link, capacità e sopravvivenza alla sostituzione del container. Docker non è stato modificato o riavviato.
3. **Campionamento e alert.** Il recorder osserva chiamate esistenti, senza garantire una previsione per fixture nella finestra 24h–1h. Fissare origine, calendario, frequenza, responsabilità delle richieste e ricevente degli alert. Il CLI rileva buchi nel calendario disponibile, senza generare previsioni o ricostruire richieste mai registrate.
4. **Suite e ambiente.** Provare segnali reali, rete/DB indisponibile e ripristino sull'ambiente autorizzato. Restano i fallimenti nativi/filesystem della suite Windows, da risolvere o classificare sul runtime di destinazione prima dell'attivazione; un run isolato verde non li chiude.
5. **Carico ed esiti.** Definire budget di latenza/backlog e controllare Turso e volume reali. Stabilire verifica degli esiti e recupero delle rettifiche non recepite. Scegliere una fonte ufficiale se richiesta dal protocollo, senza etichettare Understat come tale.

Gli stadi non esposti non bloccano l'osservazione tecnica locale se restano null con motivo: grezzo prima del contesto, blending separato e decisione esatta non identificabile. Non diventano confronti statisticamente disponibili. `direct_a`, `shared_ac` e `internal` restano origini distinte; il chiamante può proiettare un pacchetto research dopo la previsione A.

## Procedura per la successiva attivazione controllata

**Procedura preparata, non eseguita. Serve autorizzazione distinta per ambiente, schema e flag. Non attivare con i blocchi precedenti ancora aperti.**

1. Preregistrare UTC d'avvio, protocollo, campionati/stagioni/origine, finestra e prima previsione, versioni, esclusioni, copertura, budget latenza e ricevente degli alert. Congelare formule/pesi; conservare commit e hash della configurazione senza segreti.
2. Applicare esplicitamente `backend/experiments/model-a-prospective/schema.sql` solo a un DB di prova isolato e ripetere test sul runtime/filesystem previsto. Non avviare `DatabaseService` con credenziali operative per un'ispezione: lo startup inizializza lo schema applicativo.
3. Associare volume e singolo database; verificare permessi del servizio, accesso privato, spazio/crescita audit, hard link, backup e restore. `0700/0600` non certificano ACL Windows o permessi remoti. Una directory locale non prova persistenza dopo sostituzione container.
4. Ottenere autorizzazione specifica per schema/deploy/flag nell'ambiente nominato. Fare backup e controllo colonne/indici/trigger; applicare lo schema solo al DB autorizzato. `IF NOT EXISTS` non aggiorna strutture incompatibili. Nessuna migrazione recorder è collegata allo startup.
5. Distribuire prima con `MODEL_A_PROSPECTIVE_ENABLED=false`. Configurare `MODEL_A_PROSPECTIVE_SPOOL_DIR` sul volume verificato, `MODEL_A_PROSPECTIVE_ALLOW_VOLATILE` assente/false, `MODEL_A_PROSPECTIVE_SHUTDOWN_MS` entro 100–30.000 ms e grace period sufficiente. Credenziali solo nella configurazione server prevista, mai nei report.
6. Dopo il consenso, accendere il flag. Controllare nuove previsioni pre-kickoff: origine, stadi, hash, timestamp/limiti, righe immutable, audit e backlog. Confrontare tutte le fixture nello scope, incluse astensioni e probabilità mancanti. `inputAvailableThrough=null` resta non valutabile per il criterio temporale rigoroso.
7. Provare riavvio e segnali reali, richieste in corso, timeout, DB offline/ripristinato e un esito verificabile. Un evento accettato deve essere nel DB o nello spool conservato; lo stesso ID non deve duplicare righe. Controllare correzioni e durata dell'intero ciclo risultati.
8. Monitorare audit/log esterni, spazio, parziali/corrotti, tentativi senza conferma, errori risultati e fixture scadute senza previsione. Nessun alert remoto viene configurato da questo lavoro. Sospendere lo studio in caso di anomalie, conservando i dati.

Per ispezionare una **copia locale consistente già autorizzata** con Node >=22.13, sostituire scope e percorsi con quelli preregistrati, usando gli identificativi effettivi del database:

```powershell
node backend/scripts/model-a-prospective-inspect.js --db-url "file:///C:/prove/copia.db" --competition "Serie_A" --season "2026/2027" --from "2026-11-04T00:00:00Z" --to "2026-12-01T00:00:00Z" --cutoff "2026-11-10T00:00:00Z" --origin direct_a --spool-dir "C:/prove/spool-copia"
```

Il CLI rifiuta URL remoti e file mancanti, non legge `.env` e non modifica schema o spool. Il cutoff filtra l'istante della previsione, **senza provare che fosse già inserita nel DB a quell'ora**: un recupero successivo compare nell'osservazione attuale. `measuredAt` e `timeSemantics` esplicitano la distinzione. Audit e spool sono osservazioni correnti separate, non una fotografia storica atomica.

Con tabelle prospettiche assenti o incompatibili l'ispettore espone comunque il calendario se leggibile. Controllare `calendarEvaluable`, `coverageEvaluable`, `storageStatus` e `schema.tables`: le metriche non misurabili sono null, non zero. La tabella risultati mancante non impedisce il confronto fra calendario e forecast già presenti. Lo schema complessivo resta non compatibile ed exit code 1 segnala il blocco all'attivazione, senza installare nulla.

**Disattivazione:** spegnere il flag nella configurazione autorizzata e riavviare secondo la procedura verificata, conservando volume, DB, audit e backup. Un riavvio a flag spento non drena automaticamente i pendenti: serve un successivo processo controllato a flag attivo con lo stesso volume/DB. Non eliminare file per far apparire nullo il backlog; i corrotti richiedono diagnosi esplicita.

## Compatibilità e conclusione

Non sono cambiati formule o sorgenti C né i modelli condivisi. Nei casi provati, acceso/spento lascia invariati probabilità e decisioni A. Le osservazioni in `PredictionService` cambiano comunque hash operativo e versione `APP-A-*`; le identità che incorporano l'hash vanno registrate come nuova versione, anche a flag spento. Non equivale a una modifica predittiva né autorizza promozioni di C.

| Criterio | Stato |
|---|---|
| A — Preparazione tecnica | Non conclusa: generatore/copertura, storage del processo scelto, genealogia temporale, alert e prove ambiente restano bloccanti; suite Windows ancora intermittente. |
| B — Raccolta attiva | Non avviata da questi interventi; nessuna migrazione, abilitazione o distribuzione operativa. |
| C — Validazione statistica | Non conclusa: richiede campione indipendente adeguato e temporalmente valutabile. Nessun miglioramento di affidabilità o profitto dimostrato. |
| Git | Main non integrato per gli effetti automatici sul DB. Nessun branch eliminato: il lavoro Fase 4 non è incorporato in main e l'uso esterno degli altri branch non è certificato. Hash e pubblicazione vanno verificati nel report di consegna, senza conservarli come stato permanente del prodotto. |
