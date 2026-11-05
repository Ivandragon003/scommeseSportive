# Modello A — preparazione e attivazione controllata della Fase 4

**Implementazione locale verificata; attivazione sospesa in attesa delle verifiche e autorizzazioni dell'ambiente. Raccolta spenta, validazione statistica non conclusa.** Le Fasi 1–3 restano chiuse. Il [protocollo](MODEL-A-VALIDAZIONE-PROSPETTICA.md) definisce finestre, metriche ed esclusioni; questa guida descrive consegna tecnica, prove e procedura operativa.

## Funzionamento implementato

| Area | Comportamento e confini |
|---|---|
| Copertura indipendente | `ModelAProspectiveCollection` legge il calendario dei cinque campionati, con stagioni e intervallo UTC espliciti. Chiama il vero `PredictionService` senza quote e senza audit di scommessa. Nightly ordinaria A/C e opportunità restano invariate. Default calendario Understat importato; opt-in football-data.org solo ricerca, con mapping revisionato verso ID esistenti e policy nel manifest. Acquisizioni append-only, dedup e controllo completo di fixture/squadre/coppie. Leghe non disponibili restano non misurabili e producono run parziale/avviso; nessun fallback silenzioso. `matches` e Nightly operative non vengono aggiornati. |
| Calendario alternativo | Sorgente, stagione unica, mapping SHA-256, cardinalità e freschezza fissati prima nel protocollo. Solo `TIMED` è un kickoff confermato; `SCHEDULED` resta provvisorio. Proiezione interna sul match effettivo prima del contesto, salvata nel forecast con ID acquisizione/osservazione distinti. |
| Finestra | Nuove inferenze tra T−24h e T−60min inclusi. Nessun recupero retroattivo delle mancate. Cambio di kickoff: nuova identità di calendario, conservando il motivo sulla precedente. Rinviate/annullate sono escluse solo con stato esplicito. |
| Deduplicazione | Scope canonico con SHA-256 atteso, protocollo immutabile, ledger per protocollo/partita/kickoff e claim UUID prima dell'inferenza. La conferma verifica manifest e claim nel payload: protocolli sovrapposti non si attribuiscono eventi altrui. Pagine da 100, finestre aperte prioritarie. |
| Arresti ambigui | Dopo un claim l'inferenza non viene ripetuta automaticamente. Il riavvio cerca l'evento salvato; altrimenti conserva `unconfirmed` e motivo. Evita una seconda previsione con input successivi, ma non garantisce copertura completa dopo un crash. Riparazioni solo dopo diagnosi e decisione esplicita, mai previsioni postume. |
| Input | Copia degli argomenti consumati, hash snapshot/componenti, identificativi/hash delle fonti e timestamp locali esistenti con significato. Acquisizione, ispezione, pubblicazione e revisione distinti; timestamp assenti/futuri/invalidi non inventati. |
| Parametri e fit | Conservati ID/fitted_at del record caricato e hash del blob già letto, senza query aggiuntive; cache caricata a osservatore spento resta non osservata. Fit in processo: hash/conteggio degli argomenti effettivi prima dei filtri interni, massimo kickoff e date future rispetto all'osservazione. Nessuna ricostruzione del training storico o disponibilità xG. |
| Limite temporale | Fonti e training non hanno genealogia completa: `inputAvailableThrough=null`, `classification=technical_only`, `rigorousEligible=false`. Raccolta tecnica possibile, senza dichiararla idonea alla validazione temporale rigorosa. |
| File | Fsync contenuto, pubblicazione esclusiva senza sovrascrittura e fsync directory dove supportato; retry idempotenti, recupero d'avvio/periodico equo, audit e conservazione di corrotti/parziali. File rimossi dopo conferma DB. Windows espone `process_crash_only`; directory sync obbligatorio fallisce in chiuso dove non supportato. |
| Runner effimero | `MODEL_A_PROSPECTIVE_STORAGE=database`: receipt pending fino al commit, accepted solo alla conferma. Il runner attende receipt e drain. Nessuno spool effimero presentato come persistente: evento in memoria perso prima del commit non è accettato; il claim persistente permette di rilevarne la mancanza. |
| Risultati | Refresh default OFF mediante HTTP Understat esistente, senza modificare matches. Evidenze append-only final/postponed/canceled/not_final/missing/conflict/unverified/provider_error. ID/squadre/kickoff controllati; nessun punteggio inventato. Cursore persistente, lease rinnovata e liveness anche a zero candidati. |
| Rettifiche | Nuova osservazione, mai riscrittura degli originali. Default 20 candidati/ciclo e orizzonte 30 giorni dal kickoff originario. Rettifiche vecchie/rinvii oltre orizzonte richiedono classificazione o recupero esplicito. Understat è fonte statistica, non ufficiale. |
| Recupero fuori orizzonte | Nuovo CLI con piano SELECT-only, scope finito massimo 366 giorni, nessuna nuova previsione. Scritture solo con due argomenti espliciti e i flag recorder/refresh attivi; cursore e lease separati, finali pendenti limitati allo scope. |
| Associazione | Un più recente missing/provider_error/non-final/conflitto sospende prudentemente la coppia corrente conservando il vecchio esito. Scelta da preregistrare: disservizi possono cambiare temporaneamente il campione valutabile. |
| SQL | `paired-results.sql` sceglie prima la prima previsione nella finestra, poi richiede provenienza verificata, timestamp e hash validi. I produttori attuali non soddisfano quel gate. `technical-paired-results.sql` espone separatamente coppie tecniche e motivo. Entrambi richiedono origine e protocollo espliciti. |
| Valutazione | CLI read-only con cutoff/origine/protocollo/hash espliciti, query canoniche, Brier/Log Loss/decili/bootstrap 2.000 per campionato-settimana e versioni. Strict controlla anche snapshot/hash; tecnico descrittivo. Grezzo pre-contesto e blending mancanti non sono inventati, confronto primario incompleto. |
| Monitor | Calendario, analizzate, ammissibili/mancanti, claim, conferme/pendenti, errori spool, liveness, esiti non associati, provenienza non verificabile. Schema controllato anche per PK/indici/trigger. Calendario alternativo assente/scaduto/incompleto/conflittuale resta non misurabile; i run parziali non sono nascosti dall’ultimo successo. Non misurabile=null; contatori audit includono retry, non sono il denominatore delle partite. |
| Receipt persistenti | Rifiuti/errori/inammissibili conservati nel ledger anche dopo delivery_unconfirmed e riavvio. Motivi consentiti o redatti; scope per protocollo/fixture, senza inventare contatori globali delle API. |
| Budget | Variabili MODEL_A_COLLECTION_PREDICT_BUDGET_MS=30000 e MODEL_A_COLLECTION_CONFIRMATION_BUDGET_MS=45000, interi positivi fino a 3.600.000. Misure monotone risposta e conferma end-to-end; riepilogo performance_json persistito. Avviso/exit1 senza cancellare o ritentare inferenze. Mancanti, invalidi, senza campioni e parziali distinti dal budget rispettato. |
| Avvisi | Checker default OFF, sole SELECT; exit nonzero per problemi operativi, summary/artifact GitHub opt-in. Provenienza tecnica informativa di default; `--require-rigorous-inputs` o flag relativo rende il requisito bloccante. Stato scientifico comunque non verificato. Nessun nuovo servizio esterno o invio di messaggi. |

Directory sync attesta quell'operazione, **non la resistenza a perdita di alimentazione**. Su POSIX la creazione del percorso ora sincronizza anche le nuove voci nei rispettivi genitori fino al primo antenato esistente; un errore viene ritentato prima dell'ammissione. Creazione pregressa esterna, mount, ripristino e permessi restano da verificare. `0700/0600` non certificano ACL/mount remoti. Shutdown cooperativo: la deadline non cancella I/O nativo/DB bloccato né garantisce che close termini nel budget. Servono grace period e supervisor provati sul target; dopo un kill i claim ambigui rimangono visibili.

## Pubblicazione e operazioni

| Percorso | Effetto |
|---|---|
| Push/PR nei workflow esaminati | CI senza secret DB; nessun warmup, schema o deploy collegato al push. CI estesa al branch di preparazione. |
| `calibration-warm.yml` | Solo dispatch con `authorize_database_writes=true` e `OPERATIONAL_CALIBRATION_ENABLED=true`: cache/profili non vengono più scritti a seguito del push. |
| Nightly esistente | Automazioni pianificate già presenti, incluso il proprio warmup, invariate. Nessuna sospensione indiscriminata dei controlli. |
| Nuovo collector | Ogni 30 minuti o dispatch, subordinato all'opt-in repository; dispatch richiede consenso aggiuntivo. Nessuna migrazione/bootstrap. Chiave, mapping e scope predisposti; gate della raccolta spento. Monitor indipendente provato in sola lettura e poi spento. GitHub può ritardare i run. |
| Hostless | Pannello ora accessibile anche nel browser integrato: i quattro servizi esistenti seguono main con auto-deploy spento; review app/site spente. Deploy backend/frontend e riavvio controllato eseguiti con bootstrap e raccolta spenti; servizi live verificati. Restano separati i webhook/GitHub Apps amministrativi non accessibili e l’accettazione dei primi eventi reali. Ripetere i gate prima del push. |

`node backend/scripts/check-operational-workflow-gates.js` controlla i contratti nel repository, non le impostazioni esterne. Vedere [Hostless](../operations/hostless-deployment.md) e [GitHub Actions](../github-actions-nightly-sync.md). Commit e risultato del push appartengono al report Git, non sono uno stato operativo permanente di questa guida.

La pianificazione GitHub esegue il workflow sul branch predefinito; il solo branch di preparazione non la attiva. Anche il dispatch iniziale richiede il file sul branch predefinito. Per scegliere quel runner occorre prima un'integrazione sicura in main, escluso l'auto-deploy esterno, oppure scegliere il processo dedicato autorizzato. Vedere le [regole GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

L'account GitHub con accesso write può ispezionare branch, PR e controlli, ma l'elenco webhook richiede privilegi ulteriori: un 404 senza scope admin non significa nessun webhook. Prima dell'integrazione controllare con il proprietario webhook e installazioni esterne, oltre all'auto-deploy/review app Hostless. Non modificare protezioni, autorizzazioni o branch predefinito per aggirare il limite.

Il backend osservato è Running e il deploy precedente è Deployed LIVE; /api/health risponde status=ok. L'incidente Service is unstable rimane firing/acknowledged, con ultima osservazione precedente al deploy live: non basta a dichiarare né instabilità attuale né risoluzione. I log recenti esaminati mostrano richieste GET / con 404; non attribuirle al probe del pannello, configurato TCP. Il successo del deploy non certifica l'import: gli ultimi log Nightly esaminati riportano fallimento Understat e dati incompleti nei 25 abbinamenti campionato/stagione. Verificare import e copertura prima di accendere il collector. Il calendario alternativo ora disponibile è esplicito, limitato alla ricerca e non sostituisce gli xG o gli esiti Understat.

La diagnosi diretta dei cinque endpoint correnti ha identificato HTML di manutenzione restituito con HTTP 200 al posto del calendario JSON. Corretto il riconoscimento locale: lo scraper lancia UNDERSTAT_INVALID_RESPONSE per risposte non oggetto o prive di dates array; prima potevano diventare zero partite con errore nullo. dates:[] resta valido e i gate esistenti decidono la completezza. Il diagnostico GitHub verifica ora tutte le cinque leghe e il contenuto, senza DB o credenziali. La correzione non ripristina il provider: il calendario operativo Understat resta non aggiornabile; il percorso research opzionale consente il confronto con una fonte separata. Nessuna Nightly operativa rilanciata, nessun refit o storico modificato. [Procedura di controllo](../github-actions-nightly-sync.md#indisponibilità-understat-e-controllo-del-calendario).

La lettura aggregata del DB configurato localmente trova calendari già importati e partite future in tutti i cinque campionati. Non costituisce confronto con il calendario corrente del provider, oggi non acquisibile, né certifica i nuovi kickoff. L'estrazione conserva cutoff UTC e sourceComparisonPossible=false; nessun aggiornamento viene effettuato per far coincidere i conteggi. Il confronto privato dell’identità con Hostless e Actions è stato poi completato.

Il preflight autenticato football-data.org Free ha acquisito in sola lettura il calendario 2026/2027 delle cinque leghe: 380 Serie A, 380 Premier League, 380 La Liga, 306 Bundesliga e 306 Ligue 1. Una mappatura esplicita di 96 squadre verso gli ID del DB locale configurato associa tutte le 1.752 coppie ordinate senza conflitti. La prima prova ha individuato il formato reale con `filters.season` e `match.season`, correggendo e testando l'adapter. La chiave è nel solo `.env` ignorato; nessun secret remoto o flag è stato impostato. Evidenze locali ignorate: `autonomy-live-calendar-preflight.json`, payload per lega e `calendar-reviewed-mapping-2026.json`; non sono un backup operativo. Prima dell'avvio preservare il mapping revisionato e il suo hash, verificare il target e rifare un'acquisizione fresca. La disponibilità gratuita non garantisce puntualità: orari provvisori restano esclusi.

Anche il diagnostico pubblico eseguito sul runner Linux GitHub rileva HTTP 200/text-html e calendario non valido per tutte le cinque leghe, terminando correttamente con exit 1. Questo fallimento della disponibilità esterna va distinto dalla CI dei test: non dichiarare ripristinato l'import perché il codice passa le regressioni. Per il solo probe supplementare resta la semantica di raggiungibilità HTTP già esistente, che ammette redirect senza certificarne il contenuto CSV.

Prima dell’applicazione autorizzata, il preflight SQL read-only sul Turso configurato localmente rilevava assenti le sette tabelle prospettiche originali e le due tabelle calendario. Il controllo corretto della cache trova invece `runtime_calibration_profiles` presente: la precedente ricerca di runtime_calibration_cache usava erroneamente il nome del file di migrazione come tabella. Quel preflight usava sole letture. Il confronto inizialmente impedito dai valori write-only è stato completato tramite impronta dell’hostname nel terminale Hostless e diagnostica SELECT-only nel runner GitHub, senza esporre URL/token. Il backend non dichiara mount spool e ora mantiene esplicitamente false le variabili del recorder/collector. Target, piano gratuito, backup e schema sono stati verificati separatamente; il runner database non richiede un nuovo volume. Restano le prove degli eventi reali nel pilot autorizzato.

L'accensione del collector usa il vero PredictionService: oltre alle tabelle Fase 4 può scrivere la cache runtime di calibrazione su cache miss e avvia l'associazione agli esiti già nel DB con recorder attivo. Il flag refresh controlla il refresh HTTP separato, non tutte le associazioni locali. La mancanza di un comando warmup non significa assenza di queste scritture accessorie esistenti; autorizzarle esplicitamente nel piano del target, senza cambiare formule o calibrazione.

Per consolidare il repository, eseguire fetch/prune e controllare SHA, commit esclusivi, PR, protezioni, worktree e utilizzatori dei branch. Dopo aver escluso effetti operativi, aggiornare main e integrare l'intero ramo verificato, includendo atomicamente il gate del warmup; non effettuare un push parziale che lo lasci automatico. Verificare di nuovo flag remoti, controlli/segreti e CI del commit esatto. Un merge locale o un push del branch non prova l'integrazione remota su main. Cancellare branch solo se interamente incorporati e senza utilizzatori o deploy associati; un backup divergente va conservato. Se gli automatismi esterni non sono verificabili, mantenere il branch pubblicato e indicare il controllo mancante: non usare force push, marker presunti o cambi di protezione.

Il lavoro Fase 4 è già stato integrato atomicamente su main su richiesta esplicita dell'utente; i branch di preparazione incorporati e confermati inutilizzati sono stati eliminati. Non ricreare il branch per ripetere il merge. Il backup divergente resta locale e conservato. Questo consolidamento non certifica i webhook amministrativi non accessibili e non autorizza deploy, schema o accensione. Le nuove verifiche si riferiscono al commit effettivo; Git e CI non attestano raccolta reale o validazione statistica.

## Verifiche della consegna

Fixture e database/spool locali, senza credenziali operative o provider reali. Artefatti ignorati sotto `artifacts/model-a-phase4/`, non backup operativo.

| Controllo | Evidenza |
|---|---|
| Build | `npm --prefix backend run build` superata. |
| Suite Windows, Node 24.17 | Esecuzione finale: **1.529 test, 1.524 passati, due falliti, tre saltati**. Wrapper `research-recommendation-nightly.test.js` e `research-worker.test.js`: `test failed` dopo le asserzioni, senza causa interna dimostrata. In una prova precedente fallivano altri due processi, incluso exit 3221225477 (0xC0000005) dopo sei asserzioni passate. Gate Windows non verde: nessun retry trasforma il fallimento in successo. Log `autonomy-windows-final.log` e `autonomy-windows-full.log`. |
| Suite Linux, Node 20.20.2 | Copia Docker finale isolata, senza rete/credenziali/host mount: **1.538 test, 1.510 passati, zero falliti, 28 saltati** (Node ≥22.13 per inspector/CLI read-only, più training CatBoost). Volume fsync/hardlink verificato fra due container non root distinti. Log `autonomy-linux-final.log`. La CI del commit esatto resta un controllo separato. |
| Frontend | Nuova esecuzione locale: **45 suite, 427 test passati**; typecheck/lint/build superati localmente e in CI. La precedente installazione locale aveva Testing Library 16 incompatibile con manifest/lock 13.4: nessuna modifica frontend o lockfile per correggere i controlli. |
| Prova completa isolata | Calendario sintetico delle cinque leghe, vero collector/PredictionService/recorder database, nessuna quota. Conferma persistente, poi refresh finale e rettifica append-only; valutatore tecnico con una coppia e rigoroso vuoto. Tabelle partita e forecast originale invariati. Due test passati, nessun provider o DB remoto. |
| SIGTERM e volume | Segnale OS al collector Linux: una inferenza/claim, nessuna seconda partita, run interrotto e claim non confermato visibili. Volume temporaneo tra due container distinti non root con fsync/hardlink e hash: superato. Nessuna prova Hostless/power loss. |
| Regressione A/C | Golden numerici e manifest originali conservati; deviazioni testuali limitate agli osservatori autorizzati, annullate in memoria dal controllo. Casi acceso/spento, senza quote e runtime A/C inclusi nelle suite. Nessun sorgente C modificato nella Fase 4; il cambio di identità delle dipendenze condivise è però un blocco operativo C, rilevato separatamente sul vero artefatto. |
| Guasti/recupero | Spool con DB temporaneamente offline, kill/restart, ID idempotenti, oltre 256 pendenti, errore directory sync, receipt DB non confermato, riavvio risultati. Non dimostrano SLA remoto. |
| Configurazione | Checker gate e `docker compose ... config --quiet` superati; nessun servizio operativo/volume Hostless avviato. |
| Gate finali | Build, typecheck, lint backend, lint esplicito script e controllo diff superati; scansione segreti prima del commit. Ripetere i controlli pertinenti dopo ogni modifica al codice. |
| Nuovi controlli mirati | 112 test passati senza fallimenti o skip su calendario, collector, monitor/inspect, esiti, valutatore e golden A, prima dell’ultima correzione del formato; quest’ultima è compresa nella suite Linux finale. Build/typecheck/lint e lint script esplicito passati dopo la correzione. |
| Riesame operativo | Sui sorgenti invariati, test model-a-prospective e operational-workflow-gates: 152 test, 149 passati, zero falliti, tre skip POSIX attesi su Windows. Checker workflow superato; sole SELECT remote di schema, nessun provider o migrazione. Log operational-readiness-targeted.log e operational-target-preflight.json. |
| Risposta Understat | 28 test mirati superati, senza skip: payload malformati, mapping invariato delle cinque leghe, retry, import con fixture, limiti di risposta e completezza. Probe HTTP e parser compilato sui cinque endpoint reali rilevano manutenzione, senza import o DB. Lettura aggregata del calendario separata e read-only. Log understat-fix-targeted.log, understat-top5-readonly.jsonl, understat-compiled-live-check.jsonl e understat-calendar-preflight.json. |

Windows ha riprodotto `0xC0000005` in research-store anche isolatamente: la causa interna del driver resta non dimostrata. Una suite verde **non dimostra che l'intermittenza sia risolta**. `backend/scripts/diagnose-nightly-tests.js` conserva TAP, exit/signal e residui isolati; distingue crash nativo, errore test e cleanup senza retry impliciti. La fixture di cardinalità ora viene pulita dal padre dopo l'uscita del figlio, con asserzioni 300/600 invariate; il figlio usa un reporter indipendente senza ereditare NODE_TEST_CONTEXT. Sono verificati successo, errore e selezione vuota: non si accetta un exit zero senza il test atteso. Nessuna modifica a driver/dipendenze/formule/golden numerici. I conteggi variano quando un processo termina prima di scoprire tutti i test e fra runtime con skip differenti.

Nell'ultima prova isolata i due file Windows falliti non riproducono il crash: worker passa 6/6 ed esce 0; recommendation passa 19/19 ed esce 0, ma lascia 33 file di fixture. Il diagnostico segnala correttamente exit1 e li elimina soltanto dopo la chiusura del figlio. Questi esiti distinguono asserzioni, uscita e pulizia; non dimostrano la causa del fallimento completo. Log `autonomy-windows-worker-isolated.log` e `autonomy-windows-recommendation-diagnostic.log`.

La riesecuzione diagnostica isolata di nightly passa 16/16 asserzioni con exit del figlio 0, ma lascia 16 database di fixture alla chiusura: il diagnostico restituisce correttamente exit1 e poi li rimuove dal padre. Non equivale a una suite verde né identifica da sola la causa del test failed nella suite completa. Log `consolidation-nightly-diagnostic.log` e `store-native-diagnostic-20261105.log`; nessun retry usato per nascondere l'esito.

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

Lo script Linux copia solo sorgenti/fixture consentiti, senza montare checkout o credenziali/DB/artefatti. Build dedicata con lockfile, rete disabilitata nei test. Richiede Docker Linux e download iniziale dipendenze; non è avvio del Compose operativo. Diagnostico Windows, da backend: `node scripts/diagnose-nightly-tests.js nightly` oppure `recommendation`, `store`, `view`, secondo il file fallito. Ripetizioni esplicite non sostituiscono un gate fallito.

## Prestazioni

Stesso driver `request-benchmark.js`, fixture simulate, libSQL persistente locale, 50 richieste, concorrenza 10, tre processi/directory nuovi per modalità; baseline compilata separatamente da `3dbf1a86`, senza suite o build concorrenti. Valori: mediana delle tre misure, non percentile dei 150 eventi aggregati. Misure Windows, non produzione/Turso remoto. L'alternativa calendario non aggiunge lavoro alle normali chiamate qui misurate; l'acquisizione di cinque feed avviene separatamente nel ciclo del collector.

| Variante | p50 risposta | p95 risposta | Richieste/s | p95 ammissione persistente | Conferme/s fino al drain |
|---|---:|---:|---:|---:|---:|
| Baseline, file | 90,04 ms | 112,28 ms | 112,25 | 112,28 ms | 77,50 |
| Attuale, file | 70,49 ms | 101,87 ms | 127,19 | 101,87 ms | 89,48 |
| Baseline, database | 48,75 ms | 57,55 ms | 216,80 | 272,05 ms | 116,19 |
| Attuale, database | 40,76 ms | 48,63 ms | 247,73 | 225,19 ms | 158,32 |

Intervalli p95 risposta: baseline file 87,41–143,53 ms; attuale file 82,39–103,87 ms; baseline database 54,86–57,73 ms; attuale database 46,83–124,39 ms. Variabilità ampia e un outlier: le mediane non dimostrano un'ottimizzazione causale. Ogni prova: 50/50 eventi confermati, zero rifiuti/errori, backlog finale zero; **600 eventi, nessuna perdita osservata**. Risposta database può essere pending: la colonna ammissione misura la conferma effettiva. Garanzie file e database diverse, non confrontare soltanto latenza di risposta.

Nessun miglioramento complessivo dello spool dimostrato: le evidenze aggiuntive hanno costo materiale. Il codice già evita di normalizzare nuovamente il JSON interno e conserva i metadati del modello in cache senza query extra. `backend/benchmarks/model-a-recorder-costs.js` e `MODEL_A_PROSPECTIVE_DIAGNOSTICS=true` separano JSON/spool/audit inclusivi di fsync; la sonda con sink simulato non attribuisce da sola il costo dell'intera PredictionService, del training o di Turso. Audit include lavoro successivo all'ammissione. Nessun fsync, hash o controllo d'integrità rimosso.

Budget configurabile: risposta predict 30s, conferma end-to-end 45s, limiti diagnostici iniziali da approvare/preregistrare sul target. Non sono timeout o promesse di latenza: un blocco indefinito produce run stale, non una misura conclusa. Soglie superate producono evidenza persistente/avviso senza alterare l'evento. Il collector separato non cambia le opportunità, ma condivide CPU/DB. Log `autonomy-bench-{baseline,current}-{file,database}-{1,2,3}.json` e `autonomy-benchmark-summary.json`.

## Storage e ripristino

Per l'infrastruttura descritta nel repository, la prima scelta proposta è il runner finito con database Turso già esistente: non richiede acquistare un volume Hostless. È una raccomandazione condizionata alla verifica del target e dei limiti effettivi, non una certificazione del piano. GitHub ammette ritardi/drop e disabilita schedule pubblici dopo inattività prolungata: non garantisce tutte le partite. Una finestra utile di 23 ore offre più occasioni, ma vanno misurate; se la continuità osservata è insufficiente, usare il loop già disponibile su un processo/volume esistente autorizzato, senza nuovo servizio obbligatorio né riattivazione T−15.

| Scelta | Preparazione | Limiti |
|---|---|---|
| GitHub finito + Turso esistente | Workflow database, ledger prima del calcolo e conferma dopo commit. Riusa infrastruttura, nessun servizio aggiuntivo obbligatorio. | Target/secret/schema, quote e costi reali da verificare. DB offline: nessuno spool runner, claim/mancanze visibili senza rigenerazione silenziosa. GitHub può ritardare/fermarsi. |
| Linux con volume | `docker-compose.model-a-research.yml` separato, profilo esplicito, immagine distinta, root read-only/tmpfs, volume e nessuna porta HTTP. Flag false di default. | Solo validato, non avviato. Verificare UID/permessi, directory precreata/parent sincronizzato, capacità/quote/supervisor. Monitor da lanciare separatamente: il solo flag nel Compose non lo avvia. |
| Volume Hostless | Solo dopo verifica account/mount/costi; documentazione ufficiale su [filesystem](https://docs.hostless.cloud/app/filesystem) e [costi](https://docs.hostless.cloud/billing/costbreakdown). | Prezzo effettivo, backup e sostituzione container non verificati. Nulla acquistato/provisionato. Scratch non persistente. |

DB: [backup Turso](../operations/turso-backup.md) autorizzato includendo tabelle prospettiche/coordination. Spool: fermare nuove inferenze, preservare intero volume/audit/parziali, checksum e restore in volume separato con stesso DB/protocollo; verificare recupero/idempotenza prima del riuso. Misurare byte/evento, crescita audit, spazio libero e retention backup. Nessuna cancellazione automatica pendenti o promessa di capacità sufficiente.

Preflight della directory esistente, senza avvio del collector:

```powershell
node backend/scripts/check-model-a-spool.js --directory 'C:/percorso/assoluto/spool'
```

Solo dopo autorizzazione alla prova sul percorso nominato aggiungere `--probe`: crea e rimuove un figlio temporaneo privato, verifica scrittura/fsync/hardlink/hash e preserva gli eventi presenti. Su Windows directorySyncConfirmed=false e ACL non certificate. Nessuna delle due modalità dimostra che il mount sia persistente; completare la prova di sostituzione container e backup/restore.

Il calendario opzionale aggiunge anche `model_a_calendar_attempts` e `model_a_calendar_fixtures`, con indici e guardie append-only nel medesimo schema manuale. Non sono create dal collector. L’applicazione al target richiede sempre consenso e backup; è stata verificata separatamente nella prova operativa autorizzata. Su uno schema esistente verificare tutte le colonne e applicare solo le sezioni additive approvate; `IF NOT EXISTS` non corregge incompatibilità.

Lo schema proposto aggiunge performance_json ai run e recorder_status/recorder_reason al ledger. Su uno schema precedente noto privo di tutte e tre le colonne, ispezionare pragma_table_info e, dopo backup/autorizzazione, applicare separatamente `backend/experiments/model-a-prospective/upgrade-readiness.sql`. Il file non è idempotente e non va eseguito su schema nuovo/ignoto o con alcune colonne già presenti. È stato provato soltanto su un database in memoria derivato dallo schema precedente, preservando la previsione e i trigger. Questo upgrade separato non è stato applicato al target, installato direttamente con lo schema completo autorizzato.

Per risultati oltre l'orizzonte ordinario, con credenziali già autorizzate nell'ambiente e senza dotenv:

```powershell
node backend/scripts/model-a-prospective-results-recover.js --from 2026-08-01T00:00:00Z --to 2026-08-31T23:59:59Z --limit 20
```

Sostituire lo scope di esempio con quello richiesto, conservare il piano e verificare match/kickoff. Nessun provider o scrittura nel piano. Dopo consenso specifico, entrambi i flag recorder/refresh devono essere true e il comando deve aggiungere `--execute --authorize-results-writes`. Ogni invocazione elabora una pagina: ripetere lo stesso scope fino a cycleComplete=true, senza toccare il cursore ordinario. I nuovi timestamp attestano la nuova acquisizione, non una disponibilità storica. Intervallo massimo 366 giorni, nessun endpoint futuro, eventuali `--match-id understat_ID` ripetuti. Non spostare osservazioni mancanti nel passato.

## Avvio web controllato e verifica del target

Il backend può essere distribuito senza il bootstrap DB mediante `WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED=false`: default invariato, valori errati bloccanti prima della costruzione del client. Questo è necessario perché il bootstrap ordinario applica schema, migrazioni e backfill anche a recorder spento. Verificato con fixture libSQL reale: schema e righe immutati in bypass, default/true ancora compatibili. Non cambiare formule o Docker per ottenere questa separazione.

La diagnostica manuale `model-a-target-preflight.yml` confronta l'impronta del target con quella osservata privatamente in Hostless; usa soltanto SELECT e cinque chiamate calendario, senza avviare l'app. La presenza della cache va controllata con il nome reale `runtime_calibration_profiles`, non con quello del file 014. Dopo l'autorizzazione DB-specifica occorrono backup completo e ripristino verificato, quota gratuita controllata, schema additivo e ispezione completa. Se un requisito del backup non è dimostrato, la migrazione resta sospesa. Consenso schema e consenso all'accensione sono distinti.

## Procedura di attivazione controllata

**Procedura con autorizzazioni distinte: deploy web e schema sono stati verificati separatamente; l’accensione resta sospesa. Pubblicare codice non autorizza ulteriori operazioni.**

1. Nominare ambiente/DB e verificare target web/GitHub, branch seguito, auto-deploy/review app, webhook/GitHub Apps dal proprietario, secret senza esporli, runtime/orologio UTC/segnali. Confrontare privatamente il DB canonico fra Hostless e Actions. Scegliere runner database oppure volume. Stabilire responsabile controlli e budget; non modificare produzione per una verifica locale.
2. Preregistrare protocollo, stagioni effettive nel DB, Top5, intervallo futuro UTC, origine prospective_a, finestra, prima previsione ed esclusioni. Distinguere raccolta tecnica da validazione rigorosa, oggi senza forecast idonei. Verificare import calendario o scegliere esplicitamente il nuovo calendario research, senza scegliere il campione dopo gli esiti. Per la fonte alternativa: account/chiave autorizzati, mapping completo revisionato e conservato, unica stagione nel formato esatto del DB (per il target letto 2026/2027), conteggi 20/20/20/18/18 e maxAgeSeconds fissati; aggiungere la policy prima di calcolare il manifest. Non riusare protocolli precedenti con una sorgente diversa.
3. Compilare codice verificato, impostare `MODEL_A_COLLECTION_PROTOCOL_ID`, `MODEL_A_COLLECTION_SEASONS` (lista separata da virgole), `MODEL_A_COLLECTION_FROM` e `MODEL_A_COLLECTION_TO` UTC espliciti futuri. Eseguire `node backend/scripts/model-a-prospective-collect.js --print-scope` senza credenziali: non legge il DB. Conservare scope e sha256 restituiti e impostare `MODEL_A_COLLECTION_MANIFEST_SHA256`. Scope diverso richiede protocollo diverso. `.env.model-a-prospective.example` è solo modello: non sovrascrivere env esistenti né committare valori reali.
4. Ottenere consenso specifico per backup/schema/configurazione e scritture accessorie PredictionService sul target. Provare prima `backend/experiments/model-a-prospective/schema.sql` su DB isolato, poi applicarlo manualmente solo dove autorizzato. Verificare separatamente runtime_calibration_profiles e l'eventuale necessità di 014_runtime_calibration_cache.sql, senza invocare calibration:warm o cambiare i profili per completare il solo schema prospettico. Non usare bootstrap ordinario per ispezionare produzione. IF NOT EXISTS non corregge colonne/PK incompatibili: predisporre modifica additiva esplicita, senza drop. Nessuna migrazione automatica del collector.
5. Distribuire con raccolta spenta. Runner: storage database, nessun volatile fallback. Volume: spool privato precreato, UID/hardlink/fsync/parent/spazio/backup/restore provati. Compose separato non modifica docker-compose.yml operativo. Monitor read-only con scope/hash; accesso e configurazione richiedono autorizzazione.
6. Dopo consenso, abilitare collector/recorder, refresh e monitor. Workflow: variabili repository esplicite; dispatch authorize_collection=true. Processo dedicato: intervallo e supervisor. Monitor separato: MODEL_A_PROSPECTIVE_MONITORING_ENABLED=true e `node backend/scripts/check-model-a-prospective.js --configured-database`. Nessuna API quote o puntata necessaria.
7. Controllare fixture nuova senza quote: claim precedente, origine/protocollo/hash, finestra e conferma DB. Confrontare calendario/ledger, escluse/mancanti e stadi null con motivo; niente backfill dopo finestra.
8. Provare sul target autorizzato SIGTERM/restart/sostituzione container, DB offline/ripristino e shutdown del supervisor. File accettato deve restare nello spool o nel DB; receipt pending non è persistito. Claim ambiguo da verificare prima di interventi.
9. Verificare esiti reali, rinvio/annullamento/rettifica e cursore dopo riavvio. Con N candidati/pagina20 un giro richiede almeno ceil(N/20) esecuzioni: frequenza e grace coerenti. Default monitor liveness2h, pendenti1h, grace risultati6h, orizzonte30giorni; variazioni preregistrate, non per nascondere errori.
10. Verificare destinatari notifiche GitHub e controllo dell'assenza di run: il job A indipendente nel watchdog orario può rilevare il collector mai partito; entrambi dipendono però da GitHub Actions, quindi un fermo totale della piattaforma resta un limite. Conservare evidenze/versioni. Sospendere sulle anomalie senza cancellarle.

**Disattivazione:** spegnere nuove inferenze/pianificazione, verificare drain, conservare DB/volume/audit e fermare secondo procedura. Recorder spento non recupera lo spool: serve sessione successiva controllata su stesso volume/DB senza nuove inferenze. Nessuna rimozione file/reset ledger per far apparire completo il campione.

## Accettazione operativa eseguita

| Verifica | Evidenza e limite |
|---|---|
| Identità DB | Impronta privata coincidente fra processo Hostless, configurazione locale e preflight GitHub; URL/token non pubblicati. |
| Backup autorizzato | Export SQL privato, ripristino offline completo, integrity ok e zero violazioni FK; ACL Windows limitata all’utente. Manifest e hash nella directory privata ignorata da Git, non negli artifact pubblici Actions. |
| Schema autorizzato | Prima prova su copia del backup, poi batch transazionale delle sole CREATE prospettiche: nove tabelle e 37 oggetti. Definizioni preesistenti preservate e nuove definizioni rilette confrontate con la prova locale. Nessun dato storico, profilo o parametro modificato dalla procedura. |
| Cache | `runtime_calibration_profiles` era già presente; nessun warmup, migrazione 014 o refit aggiuntivo. |
| Runner | Secret football-data.org e mapping configurati senza attivazione; dopo lo schema, preflight read-only verde per identità e 1.752 fixture mappate delle cinque leghe. La presenza delle tabelle non prova da sola un’ammissione forecast. |
| Monitor | Schema reale compatibile. Prima della registrazione del protocollo il monitor restituisce correttamente critical per scope/attività/esiti non verificabili: non trasformare questo risultato in una raccolta verde. |
| Riavvio web | Riavvio Hostless eseguito dopo la DDL, nuovo processo verificato e nove tabelle ancora disponibili; bootstrap=false, recorder=false e collector=false. Prima della prova il probe conferma zero forecast. Non è una prova di recupero di una previsione reale dopo crash. |
| Fonte esiti | Understat continua a restituire HTML HTTP 200 sulle cinque leghe. Calendario alternativo verificato, aggiornamento xG/esiti ancora indisponibile. |

È predisposto un pilot **tecnico**, distinto dal campione rigoroso: cinque leghe, stagione 2026/2027, kickoff `[2026-11-06T00:00:00Z,2026-11-13T00:00:00Z)`, origine prospective_a e prima previsione nella finestra T−24h/T−60min. Protocollo `model-a-technical-pilot-20261106-v1`, manifest `0f097506f6eb7eccded4c5b30fb39bc1e4945c879b89b825868b7429cbb149fb`; mapping/hash e budget 30s/45s fissati prima dell’avvio. Variabili di raccolta e monitor restano false: questa preparazione non è consenso all’accensione. Prima di attivare oltre tali date serve un nuovo scope/protocollo, non un backfill. A fine pilot spegnere il gate repository e preservare eventi/ledger.

Per un pilot durante il disservizio occorre accettare esplicitamente input tecnici e risultati eventualmente pendenti: non è una verifica dell’affidabilità statistica. Il consenso deve includere forecast, ledger, run, calendario e le scritture accessorie di cache/associazione già previste da PredictionService. In caso di anomalie di integrità, target inatteso o consegne non confermate sospendere nuove inferenze e conservare le evidenze. Il recupero di eventi reali e la latenza Turso end-to-end vanno misurati nel pilot autorizzato, senza introdurre risultati fittizi.

## Compatibilità della baseline congelata C

Il controllo sul vero artefatto C registrato ha individuato un requisito non coperto dalla sola suite: C-906371b0b3a1e2c8 richiede `A-80cb25df5552621e`. Le dipendenze condivise aggiornate identificavano invece `A-38538d45825fba24`, rifiutata dalla guardia `hybrid_baseline_mismatch`. Anche l'identità della pipeline di calibrazione deve coincidere. Fornire arbitrariamente la versione dell'artefatto non dimostra compatibilità.

L’archivio del precedente commit web 6ed36d4 compilato con le dipendenze previste riproduce esattamente A-80cb25df5552621e. Quattro file inclusi nell’identità sono cambiati nel lavoro precedente: correzioni xG mancanti in DC/Poisson e osservatori nei moduli value/analisi. Questa verifica non riapre quelle correzioni né autorizza a rietichettare la nuova baseline come vecchia, riaddestrare C o allentare i controlli.

La correzione su main isola il solo nucleo numerico research della release, in [frozen/a-80cb25df](../../backend/src/research/frozen/a-80cb25df/README.md). Le facciate ForecastCore e delle due pipeline caricano quei byte JavaScript effettivi, anche in sviluppo TypeScript. Il prebuild controlla SHA-256 e inventario prima della copia; i fingerprint sono calcolati dagli stessi moduli storici, senza costanti sostitutive o eccezioni nelle guardie. L'hash legacy lifecycle legge il modulo eseguito. I modelli correnti di PredictionService, inclusa la correzione xG della Fase 1 e gli osservatori del recorder, restano separati e invariati. Non è un nuovo modello C, né un nuovo training.

La fixture immutabile è prodotta dalla release precedente, con xG mancanti/null/vuoti/zero, calibrazione e quote simulate dichiarate: input, matrici e decisioni devono coincidere. Le mutazioni cambiano i fingerprint e la build rifiuta file alterati o aggiunti. La prova privata sul vero artefatto registrato confronta cinque casi xG con la release: input, feature, inferenza C e pipeline coincidono; nessuna scrittura DB. Non sostituisce una previsione reale. Pesi C, schema feature, selettori e guardie non sono modificati.

Verifiche di integrazione: build/typecheck/lint superati; sei test mirati su snapshot e pulizia build, più 19 test esistenti delle pipeline/adoption superati. La revisione indipendente confronta tutti i 22 JS con la compilazione del commit originale, verifica dipendenze chiuse e funzionamento in ts-node. Il golden numerico resta immutato: per le sole differenze libm/V8 negli ultimi bit fra Windows e Linux il confronto usa tolleranza `1e-12 × max(1, |atteso|)`; manifest, hash, byte, struttura e stringhe restano esatti. La prima CI ha rilevato questa differenza e non è stata dichiarata verde. La [CI del runtime d2407853](https://github.com/Ivandragon003/scommeseSportive/actions/runs/42047107204) è verde: backend 1.553 test, 1.525 passati, zero falliti, 28 skip; frontend 45 suite e 427 test passati, oltre a build/typecheck/lint. Ripetere il gate sui successivi commit.

La suite Windows rieseguita durante l'integrazione riporta 1.545 test, 1.540 passati, due processi falliti e tre skip: recommendation-nightly e recommendation-store terminano con `test failed`. Il test della pulizia build inizialmente fallito è stato corretto e passa isolatamente; l'intermittenza Windows/libSQL non è dichiarata risolta. Log `frozen-main-final-suite.log`. La scansione dei nuovi file rileva due falsi positivi, verificati: confronti con `double_chance_1x/x2` nel JS congelato, non credenziali. Nessuna esclusione ampia aggiunta allo scanner e nessun file privato pubblicato.

Il backend temporaneo ca3dc855 è stato verificato LIVE, health 200, baseline 80 e inferenza con il C reale; recorder/collector false e zero forecast. Conservare `ops/model-a-web-compat` finché è sorgente di un deploy; dopo il ritorno verificato a main può essere eliminato perché già incorporato. Prima del rilascio da main ripetere CI, confronto con artefatto reale e verifica runtime dopo LIVE. Non accendere il pilot: il consenso all'attivazione rimane separato e non è stato dato. I limiti Understat e `inputAvailableThrough=null` restano invariati.

## Blocchi e criteri

| Problema | Bloccante raccolta tecnica? | Prossima azione |
|---|---|---|
| Target/schema | Risolto per il target accettato | Identità, backup/restore e schema verificati dopo consenso specifico. Serve consenso separato per accendere la raccolta. |
| Runtime/storage scelti | Accettazione di eventi reali ancora da completare | Database Turso confermato; nessun volume necessario. Receipt, crash/offline e drain sul target durante il pilot autorizzato; prove isolate già passate. |
| Scope/calendario/monitoraggio | Sì | Manifest futuro, sorgente fresca e mapping per il target, controllo finestre e responsabile avvisi. Non serve una quota per la raccolta sportiva. |
| Provider Understat | Sì per aggiornamento xG/esiti; calendario research ha alternativa | Tornare a JSON valido per import e refresh esiti; nel frattempo il calendario opzionale può alimentare solo la raccolta tecnica dopo accettazione del target. La pagina HTML HTTP 200 non è una stagione vuota. |
| Genealogia temporale | No tecnica; sì validazione rigorosa | Conservare limite per evento; servono evidenze ulteriori reali, non un cambio etichetta. |
| Windows/libSQL intermittente | Non da solo per Linux provato | Diagnostico ripetibile e fallimenti visibili. Gate Linux verde; causa nativa irrisolta. |
| Carico/quote/costi | Sì prima accensione | Budget e prova autorizzata; benchmark locali non dimostrano sostenibilità remota. |
| Rettifiche vecchie/ufficialità | Limite da accettare | Classificazione fuori orizzonte/fonte ufficiale se necessaria; non inventare risultati. |
| Main/webhook | Solo pubblicazione main | Gate Hostless osservati spenti; proprietario verifica hook e integrazioni non accessibili all'account write. Confermare anche il disuso dei branch prima della pulizia. |

| Criterio | Stato |
|---|---|
| Rilascio web da main | Compatibilità ripristinata nel codice con snapshot numerico reale; il rilascio richiede CI e accettazione runtime del commit esatto. |
| A — Preparazione tecnica | Implementazione completata, gate Linux e frontend verdi; Windows conserva l'intermittenza documentata. Deploy, target, backup e schema verificati; consenso al pilot e accettazione degli eventi reali restano necessari. |
| B — Raccolta prospettica | Non attivata da questo lavoro. |
| C — Validazione statistica | Non conclusa: campione futuro indipendente adeguato, copertura/esclusioni, Brier/Log Loss/calibrazione e incertezza, distinguendo rigoroso/tecnico. Nessuna prova di maggiore affidabilità o profitto. |

## File della consegna

| Responsabilità | File principali |
|---|---|
| Cattura/persistenza | PredictionService.ts, ModelAProspectiveInputs.ts, ModelAProspectiveRecorder.ts, ModelAProspectiveSpool.ts |
| Collector | ModelAResearchCalendarStore.ts, modelAResearchCalendar.ts, ModelAProspectiveCollection.ts, ModelAProspectiveBudget.ts, scripts/model-a-prospective-collect.js, schema/upgrade manuale e workflow prospettico |
| Risultati | ModelAProspectiveResultRefresh.ts, scripts/model-a-prospective-results-recover.js, paired-results.sql, technical-paired-results.sql |
| Valutatore | model-a-prospective-evaluate.js, model-a-prospective-statistics.js, query canoniche e test dedicati |
| Monitor | ModelAProspectiveMonitoring.ts, model-a-prospective-inspect.js, check-model-a-prospective.js, helper alerts/result-monitoring |
| Pubblicazione | calibration-warm.yml, ci.yml, check-operational-workflow-gates.js |
| Prove/configurazione | Test model-a-prospective/workflow/calibrazione, fixture view isolata, deviazioni sorgente autorizzate, benchmark, diagnostico nightly/store/view, check-model-a-spool.js, scripts/verify-model-a-linux.ps1, Compose/env example separati |
| Guide | Handoff/protocollo/A, README, GitHub Actions/Hostless e README fixture golden |

Nessuna nuova dipendenza, formula, peso o sorgente C; nessun Docker operativo modificato. Il solo schema prospettico remoto è stato aggiunto dopo consenso specifico; dati storici e parametri preservati. Gli osservatori PredictionService cambiano hash e identità APP-A-*: registrare nuova versione anche a numeri invariati. Non equivalgono a modifica predittiva o promozione C.
