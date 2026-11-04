# Modello A — preparazione e attivazione controllata della Fase 4

**Implementazione locale verificata; attivazione sospesa in attesa delle verifiche e autorizzazioni dell'ambiente. Raccolta spenta, validazione statistica non conclusa.** Le Fasi 1–3 restano chiuse. Il [protocollo](MODEL-A-VALIDAZIONE-PROSPETTICA.md) definisce finestre, metriche ed esclusioni; questa guida descrive consegna tecnica, prove e procedura operativa.

## Funzionamento implementato

| Area | Comportamento e confini |
|---|---|
| Copertura indipendente | `ModelAProspectiveCollection` legge il calendario dei cinque campionati, con stagioni e intervallo UTC espliciti. Chiama il vero `PredictionService` senza quote e senza audit di scommessa. Nightly ordinaria A/C e opportunità restano invariate. La copertura riguarda il calendario importato, senza dimostrarne la completezza rispetto al provider. |
| Finestra | Nuove inferenze tra T−24h e T−60min inclusi. Nessun recupero retroattivo delle mancate. Cambio di kickoff: nuova identità di calendario, conservando il motivo sulla precedente. Rinviate/annullate sono escluse solo con stato esplicito. |
| Deduplicazione | Scope canonico con SHA-256 atteso, protocollo immutabile, ledger per protocollo/partita/kickoff e claim UUID prima dell'inferenza. La conferma verifica manifest e claim nel payload: protocolli sovrapposti non si attribuiscono eventi altrui. Pagine da 100, finestre aperte prioritarie. |
| Arresti ambigui | Dopo un claim l'inferenza non viene ripetuta automaticamente. Il riavvio cerca l'evento salvato; altrimenti conserva `unconfirmed` e motivo. Evita una seconda previsione con input successivi, ma non garantisce copertura completa dopo un crash. Riparazioni solo dopo diagnosi e decisione esplicita, mai previsioni postume. |
| Input | Copia degli argomenti consumati, hash snapshot/componenti, identificativi/hash delle fonti e timestamp locali esistenti con significato. Acquisizione, ispezione, pubblicazione e revisione distinti; timestamp assenti/futuri/invalidi non inventati. |
| Limite temporale | Fonti e training non hanno genealogia completa: `inputAvailableThrough=null`, `classification=technical_only`, `rigorousEligible=false`. Raccolta tecnica possibile, senza dichiararla idonea alla validazione temporale rigorosa. |
| File | Fsync contenuto, pubblicazione esclusiva senza sovrascrittura e fsync directory dove supportato; retry idempotenti, recupero d'avvio/periodico equo, audit e conservazione di corrotti/parziali. File rimossi dopo conferma DB. Windows espone `process_crash_only`; directory sync obbligatorio fallisce in chiuso dove non supportato. |
| Runner effimero | `MODEL_A_PROSPECTIVE_STORAGE=database`: receipt pending fino al commit, accepted solo alla conferma. Il runner attende receipt e drain. Nessuno spool effimero presentato come persistente: evento in memoria perso prima del commit non è accettato; il claim persistente permette di rilevarne la mancanza. |
| Risultati | Refresh default OFF mediante HTTP Understat esistente, senza modificare matches. Evidenze append-only final/postponed/canceled/not_final/missing/conflict/unverified/provider_error. ID/squadre/kickoff controllati; nessun punteggio inventato. Cursore persistente, lease rinnovata e liveness anche a zero candidati. |
| Rettifiche | Nuova osservazione, mai riscrittura degli originali. Default 20 candidati/ciclo e orizzonte 30 giorni dal kickoff originario. Rettifiche vecchie/rinvii oltre orizzonte richiedono classificazione o recupero esplicito. Understat è fonte statistica, non ufficiale. |
| Associazione | Un più recente missing/provider_error/non-final/conflitto sospende prudentemente la coppia corrente conservando il vecchio esito. Scelta da preregistrare: disservizi possono cambiare temporaneamente il campione valutabile. |
| SQL | `paired-results.sql` sceglie prima la prima previsione nella finestra, poi richiede provenienza verificata, timestamp e hash validi. I produttori attuali non soddisfano quel gate. `technical-paired-results.sql` espone separatamente coppie tecniche e motivo. Entrambi richiedono origine e protocollo espliciti. |
| Monitor | Calendario, analizzate, ammissibili/mancanti, claim, conferme/pendenti, errori spool, liveness, esiti non associati, provenienza non verificabile. Schema controllato anche per PK/indici/trigger. Non misurabile=null; contatori audit includono retry, non sono il denominatore delle partite. |
| Avvisi | Checker default OFF, sole SELECT; exit nonzero per problemi operativi, summary/artifact GitHub opt-in. Provenienza tecnica informativa di default; `--require-rigorous-inputs` o flag relativo rende il requisito bloccante. Stato scientifico comunque non verificato. Nessun nuovo servizio esterno o invio di messaggi. |

Directory sync attesta quell'operazione, **non la resistenza a perdita di alimentazione**. La creazione iniziale dello spool non sincronizza i genitori: predisporre la directory sul volume, sincronizzarne anche la creazione e provarne ripristino e permessi. `0700/0600` non certificano ACL/mount remoti. Shutdown cooperativo: la deadline non cancella I/O nativo/DB bloccato né garantisce che close termini nel budget. Servono grace period e supervisor provati sul target; dopo un kill i claim ambigui rimangono visibili.

## Pubblicazione e operazioni

| Percorso | Effetto |
|---|---|
| Push/PR nei workflow esaminati | CI senza secret DB; nessun warmup, schema o deploy collegato al push. CI estesa al branch di preparazione. |
| `calibration-warm.yml` | Solo dispatch con `authorize_database_writes=true` e `OPERATIONAL_CALIBRATION_ENABLED=true`: cache/profili non vengono più scritti a seguito del push. |
| Nightly esistente | Automazioni pianificate già presenti, incluso il proprio warmup, invariate. Nessuna sospensione indiscriminata dei controlli. |
| Nuovo collector | Ogni 30 minuti o dispatch, subordinato all'opt-in repository; dispatch richiede consenso aggiuntivo. Nessuna migrazione/bootstrap. Nessuna variabile abilitata da questo lavoro. GitHub può ritardare i run. |
| Hostless | Auto-deploy, branch seguito e review app da verificare nell'account. Browser locale indisponibile: i workflow non provano l'assenza di trigger esterni. In mancanza di prova consegnare il branch, senza main o PR che possa avviare review app. |

`node backend/scripts/check-operational-workflow-gates.js` controlla i contratti nel repository, non le impostazioni esterne. Vedere [Hostless](../operations/hostless-deployment.md) e [GitHub Actions](../github-actions-nightly-sync.md). Commit e risultato del push appartengono al report Git, non sono uno stato operativo permanente di questa guida.

## Verifiche della consegna

Fixture e database/spool locali, senza credenziali operative o provider reali. Artefatti ignorati sotto `artifacts/model-a-phase4/`, non backup operativo.

| Controllo | Evidenza |
|---|---|
| Build | `npm --prefix backend run build` superata. |
| Suite Windows, Node 24.17 | **1.440 test, 1.439 passati, zero falliti, uno saltato** (SIGTERM POSIX). Log `completion-windows-final.log`. |
| Suite Linux, Node 20.20.2 | **1.450 test, 1.433 passati, zero falliti, 17 saltati**: 16 inspector richiedono Node ≥22.13, uno training richiede CatBoost. Container di prova senza rete/credenziali, copia del sorgente. Log/riepilogo `completion-linux-suite`. |
| SIGTERM e volume | Segnale OS al collector Linux: una inferenza/claim, nessuna seconda partita, run interrotto e claim non confermato visibili. Volume temporaneo tra due container distinti non root con fsync/hardlink e hash: superato. Nessuna prova Hostless/power loss. |
| Regressione A/C | Golden numerici e manifest originali conservati; deviazioni testuali limitate agli osservatori autorizzati, annullate in memoria dal controllo. Casi acceso/spento, senza quote e runtime A/C inclusi nelle suite. Nessun sorgente matematico o runtime C modificato. |
| Guasti/recupero | Spool con DB temporaneamente offline, kill/restart, ID idempotenti, oltre 256 pendenti, errore directory sync, receipt DB non confermato, riavvio risultati. Non dimostrano SLA remoto. |
| Configurazione | Checker gate e `docker compose ... config --quiet` superati; nessun servizio operativo/volume Hostless avviato. |
| Gate finali | Typecheck, lint backend, lint esplicito script e controllo diff superati; scansione segreti prima del commit. Ripetere i controlli pertinenti dopo ogni modifica al codice. |

Windows aveva riprodotto il crash nativo `0xC0000005` nei processi libSQL e residui fixture/EPERM. L'ultimo verde **non dimostra che l'intermittenza sia risolta**. `backend/scripts/diagnose-nightly-tests.js` conserva TAP, exit/signal e residui isolati; distingue crash nativo, errore test e cleanup senza retry impliciti. Causa interna del driver non dimostrata: nessuna modifica a dipendenze/formule/golden numerici per ottenere il verde. I conteggi variano se un processo muore prima di scoprire tutti i test e tra runtime con skip differenti.

Controlli ripetibili da radice, senza caricare `.env` operativo:

```powershell
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run lint
node backend/scripts/check-operational-workflow-gates.js
docker compose -f docker-compose.model-a-research.yml --env-file .env.model-a-prospective.example config --quiet
powershell -NoProfile -File scripts/verify-model-a-linux.ps1
git diff --check
```

Lo script Linux copia solo sorgenti/fixture consentiti, senza montare checkout o credenziali/DB/artefatti. Build dedicata con lockfile, rete disabilitata nei test. Richiede Docker Linux e download iniziale dipendenze; non è avvio del Compose operativo. Diagnostico Windows, da backend: `node scripts/diagnose-nightly-tests.js`. Ripetizioni esplicite non sostituiscono un gate fallito.

## Prestazioni

Stesso driver `request-benchmark.js`, fixture simulate, libSQL persistente locale, 50 richieste, concorrenza 10, tre processi/directory nuovi per variante; baseline compilata separatamente da `7a6c16b3`, senza suite concorrenti. Valori: mediana delle tre misure, non percentile dei 150 eventi aggregati.

| Variante | p50 risposta | p95 risposta | Richieste/s | p95 ammissione persistente | Conferme/s fino al drain |
|---|---:|---:|---:|---:|---:|
| Baseline, file | 52,51 ms | 57,27 ms | 188,6 | 57,27 ms | 125,7 |
| Attuale, file | 68,99 ms | 74,16 ms | 146,0 | 74,16 ms | 101,3 |
| Attuale, database | 32,25 ms | 41,00 ms | 299,9 | 187,88 ms | 180,5 |

Intervalli p95 risposta: baseline 57,02–64,99 ms, file 72,77–100,72 ms, database 38,30–42,47 ms. Controlli spenti nelle nove prove: p50 11,76–19,89 ms, p95 18,19–30,25 ms, throughput 480,2–746,7/s. Ogni prova: 50/50 eventi confermati, zero rifiuti/errori, backlog finale zero; **450 eventi, nessuna perdita osservata**. Risposta database può essere pending: la colonna ammissione misura la conferma effettiva. Garanzie file e database diverse, non confrontare soltanto latenza di risposta.

Nessun miglioramento complessivo dello spool dimostrato: le evidenze aggiuntive hanno costo materiale. Ottimizzato l'hash interno sul JSON già normalizzato, senza rimuovere normalizzazione pubblica o controlli. La sonda `backend/benchmarks/model-a-recorder-costs.js` separa JSON/spool/audit inclusivi di fsync: su 50 eventi file circa 55 ms spool e 93 ms audit nell'intero ciclo, contro circa 1 ms JSON su 100 eventi attuali. Sonda con sink simulato, non percentili richiesta né Turso; audit include lavoro successivo all'ammissione. Nessun fsync rimosso.

Budget accettabile e prestazioni su storage/rete reali da stabilire. Il collector separato non cambia la pianificazione delle opportunità, ma condivide CPU/DB. Log `completion-bench-{baseline,file,database}-{1,2,3}.json`, `completion-bench-summary.json`, `completion-recorder-costs.json`.

## Storage e ripristino

| Scelta | Preparazione | Limiti |
|---|---|---|
| GitHub finito + Turso esistente | Workflow database, ledger prima del calcolo e conferma dopo commit. Riusa infrastruttura, nessun servizio aggiuntivo obbligatorio. | Target/secret/schema, quote e costi reali da verificare. DB offline: nessuno spool runner, claim/mancanze visibili senza rigenerazione silenziosa. GitHub può ritardare/fermarsi. |
| Linux con volume | `docker-compose.model-a-research.yml` separato, profilo esplicito, immagine distinta, root read-only/tmpfs, volume e nessuna porta HTTP. Flag false di default. | Solo validato, non avviato. Verificare UID/permessi, directory precreata/parent sincronizzato, capacità/quote/supervisor. Monitor da lanciare separatamente: il solo flag nel Compose non lo avvia. |
| Volume Hostless | Solo dopo verifica account/mount/costi; documentazione ufficiale su [filesystem](https://docs.hostless.cloud/app/filesystem) e [costi](https://docs.hostless.cloud/billing/costbreakdown). | Prezzo effettivo, backup e sostituzione container non verificati. Nulla acquistato/provisionato. Scratch non persistente. |

DB: [backup Turso](../operations/turso-backup.md) autorizzato includendo tabelle prospettiche/coordination. Spool: fermare nuove inferenze, preservare intero volume/audit/parziali, checksum e restore in volume separato con stesso DB/protocollo; verificare recupero/idempotenza prima del riuso. Misurare byte/evento, crescita audit, spazio libero e retention backup. Nessuna cancellazione automatica pendenti o promessa di capacità sufficiente.

## Procedura di attivazione controllata

**Preparata, non eseguita. Pubblicare codice non autorizza schema, deploy o accensione.**

1. Nominare ambiente/DB e verificare target web/GitHub, branch seguito, auto-deploy/review app, secret senza esporli, runtime/orologio UTC/segnali. Scegliere runner database oppure volume. Stabilire responsabile controlli e budget; non modificare produzione per una verifica locale.
2. Preregistrare protocollo, stagioni effettive nel DB, Top5, intervallo futuro UTC, origine prospective_a, finestra, prima previsione ed esclusioni. Distinguere raccolta tecnica da validazione rigorosa, oggi senza forecast idonei. Verificare import calendario, non scegliere il campione dopo gli esiti.
3. Compilare codice verificato, impostare `MODEL_A_COLLECTION_PROTOCOL_ID`, `MODEL_A_COLLECTION_SEASONS` (lista separata da virgole), `MODEL_A_COLLECTION_FROM` e `MODEL_A_COLLECTION_TO` UTC espliciti futuri. Eseguire `node backend/scripts/model-a-prospective-collect.js --print-scope` senza credenziali: non legge il DB. Conservare scope e sha256 restituiti e impostare `MODEL_A_COLLECTION_MANIFEST_SHA256`. Scope diverso richiede protocollo diverso. `.env.model-a-prospective.example` è solo modello: non sovrascrivere env esistenti né committare valori reali.
4. Ottenere consenso specifico per backup/schema/configurazione sul target. Provare prima `backend/experiments/model-a-prospective/schema.sql` su DB isolato, poi applicarlo manualmente solo dove autorizzato. Non usare bootstrap ordinario per ispezionare produzione. IF NOT EXISTS non corregge colonne/PK incompatibili: predisporre modifica additiva esplicita, senza drop. Nessuna migrazione automatica del collector.
5. Distribuire con raccolta spenta. Runner: storage database, nessun volatile fallback. Volume: spool privato precreato, UID/hardlink/fsync/parent/spazio/backup/restore provati. Compose separato non modifica docker-compose.yml operativo. Monitor read-only con scope/hash; accesso e configurazione richiedono autorizzazione.
6. Dopo consenso, abilitare collector/recorder, refresh e monitor. Workflow: variabili repository esplicite; dispatch authorize_collection=true. Processo dedicato: intervallo e supervisor. Monitor separato: MODEL_A_PROSPECTIVE_MONITORING_ENABLED=true e `node backend/scripts/check-model-a-prospective.js --configured-database`. Nessuna API quote o puntata necessaria.
7. Controllare fixture nuova senza quote: claim precedente, origine/protocollo/hash, finestra e conferma DB. Confrontare calendario/ledger, escluse/mancanti e stadi null con motivo; niente backfill dopo finestra.
8. Provare sul target autorizzato SIGTERM/restart/sostituzione container, DB offline/ripristino e shutdown del supervisor. File accettato deve restare nello spool o nel DB; receipt pending non è persistito. Claim ambiguo da verificare prima di interventi.
9. Verificare esiti reali, rinvio/annullamento/rettifica e cursore dopo riavvio. Con N candidati/pagina20 un giro richiede almeno ceil(N/20) esecuzioni: frequenza e grace coerenti. Default monitor liveness2h, pendenti1h, grace risultati6h, orizzonte30giorni; variazioni preregistrate, non per nascondere errori.
10. Verificare destinatari notifiche GitHub e controllo dell'assenza di run: il monitor nello stesso job non avvisa se GitHub non parte. Conservare evidenze/versioni. Sospendere sulle anomalie senza cancellarle.

**Disattivazione:** spegnere nuove inferenze/pianificazione, verificare drain, conservare DB/volume/audit e fermare secondo procedura. Recorder spento non recupera lo spool: serve sessione successiva controllata su stesso volume/DB senza nuove inferenze. Nessuna rimozione file/reset ledger per far apparire completo il campione.

## Blocchi e criteri

| Problema | Bloccante raccolta tecnica? | Prossima azione |
|---|---|---|
| Target/schema/autorizzazione | Sì | Identità DB, backup/schema manuale e flag autorizzati. Vecchie sole SELECT locali trovavano tabelle assenti, senza certificare lo stato attuale. |
| Runtime/storage scelti | Sì | Prova target di permessi/commit/restart/offline/drain. Volume non necessario nel runner database; file mode vietato sullo scratch. |
| Scope/import/monitoraggio | Sì | Manifest futuro, import funzionante, controllo finestre e responsabile avvisi. |
| Genealogia temporale | No tecnica; sì validazione rigorosa | Conservare limite per evento; servono evidenze ulteriori reali, non un cambio etichetta. |
| Windows/libSQL intermittente | Non da solo per Linux provato | Diagnostico ripetibile e fallimenti visibili. Ultimi gate verdi, causa nativa irrisolta. |
| Carico/quote/costi | Sì prima accensione | Budget e prova autorizzata; benchmark locali non dimostrano sostenibilità remota. |
| Rettifiche vecchie/ufficialità | Limite da accettare | Classificazione fuori orizzonte/fonte ufficiale se necessaria; non inventare risultati. |
| Main/Hostless | Solo pubblicazione main | Verificare auto-deploy/review app; consegna branch separata ammessa. |

| Criterio | Stato |
|---|---|
| A — Preparazione tecnica | Implementazione e gate locali completati; accettazione ambiente e decisioni operative necessarie. Non conclusa in senso incondizionato. |
| B — Raccolta prospettica | Non attivata da questo lavoro. |
| C — Validazione statistica | Non conclusa: campione futuro indipendente adeguato, copertura/esclusioni, Brier/Log Loss/calibrazione e incertezza, distinguendo rigoroso/tecnico. Nessuna prova di maggiore affidabilità o profitto. |

## File della consegna

| Responsabilità | File principali |
|---|---|
| Cattura/persistenza | PredictionService.ts, ModelAProspectiveInputs.ts, ModelAProspectiveRecorder.ts, ModelAProspectiveSpool.ts |
| Collector | ModelAProspectiveCollection.ts, scripts/model-a-prospective-collect.js, schema SQL e workflow prospettico |
| Risultati | ModelAProspectiveResultRefresh.ts, paired-results.sql, technical-paired-results.sql |
| Monitor | ModelAProspectiveMonitoring.ts, model-a-prospective-inspect.js, check-model-a-prospective.js, helper alerts/result-monitoring |
| Pubblicazione | calibration-warm.yml, ci.yml, check-operational-workflow-gates.js |
| Prove/configurazione | Test model-a-prospective/workflow/calibrazione, deviazioni sorgente autorizzate, benchmark, diagnostico nightly, scripts/verify-model-a-linux.ps1, Compose/env example separati |
| Guide | Handoff/protocollo/A, README, GitHub Actions/Hostless e README fixture golden |

Nessuna nuova dipendenza, formula, peso o sorgente C; nessun Docker operativo o DB remoto modificato. Gli osservatori PredictionService cambiano hash e identità APP-A-*: registrare nuova versione anche a numeri invariati. Non equivalgono a modifica predittiva o promozione C.
