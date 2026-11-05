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
| Parametri e fit | Conservati ID/fitted_at del record caricato e hash del blob già letto, senza query aggiuntive; cache caricata a osservatore spento resta non osservata. Fit in processo: hash/conteggio degli argomenti effettivi prima dei filtri interni, massimo kickoff e date future rispetto all'osservazione. Nessuna ricostruzione del training storico o disponibilità xG. |
| Limite temporale | Fonti e training non hanno genealogia completa: `inputAvailableThrough=null`, `classification=technical_only`, `rigorousEligible=false`. Raccolta tecnica possibile, senza dichiararla idonea alla validazione temporale rigorosa. |
| File | Fsync contenuto, pubblicazione esclusiva senza sovrascrittura e fsync directory dove supportato; retry idempotenti, recupero d'avvio/periodico equo, audit e conservazione di corrotti/parziali. File rimossi dopo conferma DB. Windows espone `process_crash_only`; directory sync obbligatorio fallisce in chiuso dove non supportato. |
| Runner effimero | `MODEL_A_PROSPECTIVE_STORAGE=database`: receipt pending fino al commit, accepted solo alla conferma. Il runner attende receipt e drain. Nessuno spool effimero presentato come persistente: evento in memoria perso prima del commit non è accettato; il claim persistente permette di rilevarne la mancanza. |
| Risultati | Refresh default OFF mediante HTTP Understat esistente, senza modificare matches. Evidenze append-only final/postponed/canceled/not_final/missing/conflict/unverified/provider_error. ID/squadre/kickoff controllati; nessun punteggio inventato. Cursore persistente, lease rinnovata e liveness anche a zero candidati. |
| Rettifiche | Nuova osservazione, mai riscrittura degli originali. Default 20 candidati/ciclo e orizzonte 30 giorni dal kickoff originario. Rettifiche vecchie/rinvii oltre orizzonte richiedono classificazione o recupero esplicito. Understat è fonte statistica, non ufficiale. |
| Recupero fuori orizzonte | Nuovo CLI con piano SELECT-only, scope finito massimo 366 giorni, nessuna nuova previsione. Scritture solo con due argomenti espliciti e i flag recorder/refresh attivi; cursore e lease separati, finali pendenti limitati allo scope. |
| Associazione | Un più recente missing/provider_error/non-final/conflitto sospende prudentemente la coppia corrente conservando il vecchio esito. Scelta da preregistrare: disservizi possono cambiare temporaneamente il campione valutabile. |
| SQL | `paired-results.sql` sceglie prima la prima previsione nella finestra, poi richiede provenienza verificata, timestamp e hash validi. I produttori attuali non soddisfano quel gate. `technical-paired-results.sql` espone separatamente coppie tecniche e motivo. Entrambi richiedono origine e protocollo espliciti. |
| Monitor | Calendario, analizzate, ammissibili/mancanti, claim, conferme/pendenti, errori spool, liveness, esiti non associati, provenienza non verificabile. Schema controllato anche per PK/indici/trigger. Non misurabile=null; contatori audit includono retry, non sono il denominatore delle partite. |
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
| Nuovo collector | Ogni 30 minuti o dispatch, subordinato all'opt-in repository; dispatch richiede consenso aggiuntivo. Nessuna migrazione/bootstrap. Nessuna variabile abilitata da questo lavoro. GitHub può ritardare i run. |
| Hostless | Pannello ora accessibile anche nel browser integrato: i quattro servizi esistenti seguono main con auto-deploy spento; review app/site spente. Nessun salvataggio, deploy o riavvio eseguito. Restano separati i webhook/GitHub Apps amministrativi non accessibili e l'accettazione del target. Ripetere i gate prima del push. |

`node backend/scripts/check-operational-workflow-gates.js` controlla i contratti nel repository, non le impostazioni esterne. Vedere [Hostless](../operations/hostless-deployment.md) e [GitHub Actions](../github-actions-nightly-sync.md). Commit e risultato del push appartengono al report Git, non sono uno stato operativo permanente di questa guida.

La pianificazione GitHub esegue il workflow sul branch predefinito; il solo branch di preparazione non la attiva. Anche il dispatch iniziale richiede il file sul branch predefinito. Per scegliere quel runner occorre prima un'integrazione sicura in main, escluso l'auto-deploy esterno, oppure scegliere il processo dedicato autorizzato. Vedere le [regole GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

L'account GitHub con accesso write può ispezionare branch, PR e controlli, ma l'elenco webhook richiede privilegi ulteriori: un 404 senza scope admin non significa nessun webhook. Prima dell'integrazione controllare con il proprietario webhook e installazioni esterne, oltre all'auto-deploy/review app Hostless. Non modificare protezioni, autorizzazioni o branch predefinito per aggirare il limite.

Il backend osservato è Running e il deploy precedente è Deployed LIVE; /api/health risponde status=ok. L'incidente Service is unstable rimane firing/acknowledged, con ultima osservazione precedente al deploy live: non basta a dichiarare né instabilità attuale né risoluzione. I log recenti esaminati mostrano richieste GET / con 404; non attribuirle al probe del pannello, configurato TCP. Il successo del deploy non certifica l'import: gli ultimi log Nightly esaminati riportano fallimento Understat e dati incompleti nei 25 abbinamenti campionato/stagione. Verificare import e copertura prima di accendere il collector, senza inventare calendario o fonte alternativa.

La diagnosi diretta dei cinque endpoint correnti ha identificato HTML di manutenzione restituito con HTTP 200 al posto del calendario JSON. Corretto il riconoscimento locale: lo scraper lancia UNDERSTAT_INVALID_RESPONSE per risposte non oggetto o prive di dates array; prima potevano diventare zero partite con errore nullo. dates:[] resta valido e i gate esistenti decidono la completezza. Il diagnostico GitHub verifica ora tutte le cinque leghe e il contenuto, senza DB o credenziali. La correzione non ripristina il provider: calendario reale e copertura rimangono da confrontare dopo il ritorno dei dati. Nessuna Nightly operativa rilanciata, nessun refit o storico modificato. [Procedura di controllo](../github-actions-nightly-sync.md#indisponibilità-understat-e-controllo-del-calendario).

La lettura aggregata del DB configurato localmente trova calendari già importati e partite future in tutti i cinque campionati. Non costituisce confronto con il calendario corrente del provider, oggi non acquisibile, né certifica i nuovi kickoff. L'estrazione conserva cutoff UTC e sourceComparisonPossible=false; nessun aggiornamento viene effettuato per far coincidere i conteggi. Identità con Hostless ancora da verificare privatamente.

Anche il diagnostico pubblico eseguito sul runner Linux GitHub rileva HTTP 200/text-html e calendario non valido per tutte le cinque leghe, terminando correttamente con exit 1. Questo fallimento della disponibilità esterna va distinto dalla CI dei test: non dichiarare ripristinato l'import perché il codice passa le regressioni. Per il solo probe supplementare resta la semantica di raggiungibilità HTTP già esistente, che ammette redirect senza certificarne il contenuto CSV.

Preflight SQL read-only sul Turso configurato localmente: assenti le sette tabelle prospettiche e runtime_calibration_cache. Nessuna scrittura o migrazione. URL/token Hostless write-only impediscono di certificare che sia lo stesso target: serve confronto privato del proprietario con i secret Actions. Il backend non dichiara mount spool o variabili MODEL_A_* nella configurazione consultata. Per la proposta runner/database non serve acquistare un volume, ma servono conferma del target/schema, quote, backup e prove reali autorizzate.

L'accensione del collector usa il vero PredictionService: oltre alle tabelle Fase 4 può scrivere la cache runtime di calibrazione su cache miss e avvia l'associazione agli esiti già nel DB con recorder attivo. Il flag refresh controlla il refresh HTTP separato, non tutte le associazioni locali. La mancanza di un comando warmup non significa assenza di queste scritture accessorie esistenti; autorizzarle esplicitamente nel piano del target, senza cambiare formule o calibrazione.

Per consolidare il repository, eseguire fetch/prune e controllare SHA, commit esclusivi, PR, protezioni, worktree e utilizzatori dei branch. Dopo aver escluso effetti operativi, aggiornare main e integrare l'intero ramo verificato, includendo atomicamente il gate del warmup; non effettuare un push parziale che lo lasci automatico. Verificare di nuovo flag remoti, controlli/segreti e CI del commit esatto. Un merge locale o un push del branch non prova l'integrazione remota su main. Cancellare branch solo se interamente incorporati e senza utilizzatori o deploy associati; un backup divergente va conservato. Se gli automatismi esterni non sono verificabili, mantenere il branch pubblicato e indicare il controllo mancante: non usare force push, marker presunti o cambi di protezione.

Il lavoro Fase 4 è già stato integrato atomicamente su main su richiesta esplicita dell'utente; i branch di preparazione incorporati e confermati inutilizzati sono stati eliminati. Non ricreare il branch per ripetere il merge. Il backup divergente resta locale e conservato. Questo consolidamento non certifica i webhook amministrativi non accessibili e non autorizza deploy, schema o accensione. Le nuove verifiche si riferiscono al commit effettivo; Git e CI non attestano raccolta reale o validazione statistica.

## Verifiche della consegna

Fixture e database/spool locali, senza credenziali operative o provider reali. Artefatti ignorati sotto `artifacts/model-a-phase4/`, non backup operativo.

| Controllo | Evidenza |
|---|---|
| Build | `npm --prefix backend run build` superata. |
| Suite Windows, Node 24.17 | Ultima esecuzione: **1.477 test, 1.473 passati, un fallito, tre saltati** (due directory POSIX e SIGTERM POSIX). Processo research-nightly termina con test failed: gate Windows non verde. Log `consolidation-windows-release.log`. La precedente esecuzione aveva esposto EPERM e il controllo reporter: corretti e verificati, senza risolvere il crash nativo del driver. |
| Suite Linux, Node 20.20.2 | Copia Docker isolata: **1.486 test, 1.466 passati, zero falliti, 20 saltati**, prima degli ultimi due test/aggiustamenti alla diagnostica. CI sul codice aggiornato: **1.488 test, 1.468 passati, zero falliti, 20 saltati** (19 inspector Node ≥22.13 e uno training CatBoost). Log `consolidation-linux-final.log`/riepilogo e `consolidation-github-code-ci.log`. |
| Frontend | Dopo npm ci: **45 suite, 427 test passati**; typecheck/lint/build superati localmente e in CI. La precedente installazione locale aveva Testing Library 16 incompatibile con manifest/lock 13.4: nessuna modifica frontend o lockfile per correggere i controlli. |
| SIGTERM e volume | Segnale OS al collector Linux: una inferenza/claim, nessuna seconda partita, run interrotto e claim non confermato visibili. Volume temporaneo tra due container distinti non root con fsync/hardlink e hash: superato. Nessuna prova Hostless/power loss. |
| Regressione A/C | Golden numerici e manifest originali conservati; deviazioni testuali limitate agli osservatori autorizzati, annullate in memoria dal controllo. Casi acceso/spento, senza quote e runtime A/C inclusi nelle suite. Nessun sorgente matematico o runtime C modificato. |
| Guasti/recupero | Spool con DB temporaneamente offline, kill/restart, ID idempotenti, oltre 256 pendenti, errore directory sync, receipt DB non confermato, riavvio risultati. Non dimostrano SLA remoto. |
| Configurazione | Checker gate e `docker compose ... config --quiet` superati; nessun servizio operativo/volume Hostless avviato. |
| Gate finali | Typecheck, lint backend, lint esplicito script e controllo diff superati; scansione segreti prima del commit. Ripetere i controlli pertinenti dopo ogni modifica al codice. |
| Riesame operativo | Sui sorgenti invariati, test model-a-prospective e operational-workflow-gates: 152 test, 149 passati, zero falliti, tre skip POSIX attesi su Windows. Checker workflow superato; sole SELECT remote di schema, nessun provider o migrazione. Log operational-readiness-targeted.log e operational-target-preflight.json. |
| Risposta Understat | 28 test mirati superati, senza skip: payload malformati, mapping invariato delle cinque leghe, retry, import con fixture, limiti di risposta e completezza. Probe HTTP e parser compilato sui cinque endpoint reali rilevano manutenzione, senza import o DB. Lettura aggregata del calendario separata e read-only. Log understat-fix-targeted.log, understat-top5-readonly.jsonl, understat-compiled-live-check.jsonl e understat-calendar-preflight.json. |

Windows ha riprodotto `0xC0000005` in research-store anche isolatamente: la causa interna del driver resta non dimostrata. Una suite verde **non dimostra che l'intermittenza sia risolta**. `backend/scripts/diagnose-nightly-tests.js` conserva TAP, exit/signal e residui isolati; distingue crash nativo, errore test e cleanup senza retry impliciti. La fixture di cardinalità ora viene pulita dal padre dopo l'uscita del figlio, con asserzioni 300/600 invariate; il figlio usa un reporter indipendente senza ereditare NODE_TEST_CONTEXT. Sono verificati successo, errore e selezione vuota: non si accetta un exit zero senza il test atteso. Nessuna modifica a driver/dipendenze/formule/golden numerici. I conteggi variano quando un processo termina prima di scoprire tutti i test e fra runtime con skip differenti.

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

Stesso driver `request-benchmark.js`, fixture simulate, libSQL persistente locale, 50 richieste, concorrenza 10, tre processi/directory nuovi per variante; baseline compilata separatamente da `9c98e0ba`, senza suite o build concorrenti. Valori: mediana delle tre misure, non percentile dei 150 eventi aggregati. Misure Windows, non produzione/Turso remoto.

| Variante | p50 risposta | p95 risposta | Richieste/s | p95 ammissione persistente | Conferme/s fino al drain |
|---|---:|---:|---:|---:|---:|
| Baseline, file | 61,47 ms | 71,58 ms | 158,9 | 71,58 ms | 110,1 |
| Attuale, file | 70,24 ms | 102,79 ms | 128,3 | 102,79 ms | 92,4 |
| Attuale, database | 33,12 ms | 42,46 ms | 282,2 | 220,72 ms | 160,2 |

Intervalli p95 risposta: baseline 69,68–76,39 ms, file 94,37–109,95 ms, database 41,96–42,79 ms. Controlli spenti nelle nove prove: p50 11,22–13,41 ms, p95 19,04–21,01 ms, throughput 689,5–754,0/s. Ogni prova: 50/50 eventi confermati, zero rifiuti/errori, backlog finale zero; **450 eventi, nessuna perdita osservata**. Risposta database può essere pending: la colonna ammissione misura la conferma effettiva. Garanzie file e database diverse, non confrontare soltanto latenza di risposta.

Nessun miglioramento complessivo dello spool dimostrato: le evidenze aggiuntive hanno costo materiale. Il codice già evita di normalizzare nuovamente il JSON interno e conserva i metadati del modello in cache senza query extra. `backend/benchmarks/model-a-recorder-costs.js` e `MODEL_A_PROSPECTIVE_DIAGNOSTICS=true` separano JSON/spool/audit inclusivi di fsync; la sonda con sink simulato non attribuisce da sola il costo dell'intera PredictionService, del training o di Turso. Audit include lavoro successivo all'ammissione. Nessun fsync, hash o controllo d'integrità rimosso.

Budget configurabile: risposta predict 30s, conferma end-to-end 45s, limiti diagnostici iniziali da approvare/preregistrare sul target. Non sono timeout o promesse di latenza: un blocco indefinito produce run stale, non una misura conclusa. Soglie superate producono evidenza persistente/avviso senza alterare l'evento. Il collector separato non cambia le opportunità, ma condivide CPU/DB. Log `consolidation-bench-{baseline,file,database}-{1,2,3}.json`, `consolidation-bench-summary.json` e `consolidation-bench-medians.json`.

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

Lo schema proposto aggiunge performance_json ai run e recorder_status/recorder_reason al ledger. Su uno schema precedente noto privo di tutte e tre le colonne, ispezionare pragma_table_info e, dopo backup/autorizzazione, applicare separatamente `backend/experiments/model-a-prospective/upgrade-readiness.sql`. Il file non è idempotente e non va eseguito su schema nuovo/ignoto o con alcune colonne già presenti. È stato provato soltanto su un database in memoria derivato dallo schema precedente, preservando la previsione e i trigger. Nessuna migrazione automatica o operativa eseguita.

Per risultati oltre l'orizzonte ordinario, con credenziali già autorizzate nell'ambiente e senza dotenv:

```powershell
node backend/scripts/model-a-prospective-results-recover.js --from 2026-08-01T00:00:00Z --to 2026-08-31T23:59:59Z --limit 20
```

Sostituire lo scope di esempio con quello richiesto, conservare il piano e verificare match/kickoff. Nessun provider o scrittura nel piano. Dopo consenso specifico, entrambi i flag recorder/refresh devono essere true e il comando deve aggiungere `--execute --authorize-results-writes`. Ogni invocazione elabora una pagina: ripetere lo stesso scope fino a cycleComplete=true, senza toccare il cursore ordinario. I nuovi timestamp attestano la nuova acquisizione, non una disponibilità storica. Intervallo massimo 366 giorni, nessun endpoint futuro, eventuali `--match-id understat_ID` ripetuti. Non spostare osservazioni mancanti nel passato.

## Procedura di attivazione controllata

**Preparata, non eseguita. Pubblicare codice non autorizza schema, deploy o accensione.**

1. Nominare ambiente/DB e verificare target web/GitHub, branch seguito, auto-deploy/review app, webhook/GitHub Apps dal proprietario, secret senza esporli, runtime/orologio UTC/segnali. Confrontare privatamente il DB canonico fra Hostless e Actions. Scegliere runner database oppure volume. Stabilire responsabile controlli e budget; non modificare produzione per una verifica locale.
2. Preregistrare protocollo, stagioni effettive nel DB, Top5, intervallo futuro UTC, origine prospective_a, finestra, prima previsione ed esclusioni. Distinguere raccolta tecnica da validazione rigorosa, oggi senza forecast idonei. Verificare import calendario, non scegliere il campione dopo gli esiti.
3. Compilare codice verificato, impostare `MODEL_A_COLLECTION_PROTOCOL_ID`, `MODEL_A_COLLECTION_SEASONS` (lista separata da virgole), `MODEL_A_COLLECTION_FROM` e `MODEL_A_COLLECTION_TO` UTC espliciti futuri. Eseguire `node backend/scripts/model-a-prospective-collect.js --print-scope` senza credenziali: non legge il DB. Conservare scope e sha256 restituiti e impostare `MODEL_A_COLLECTION_MANIFEST_SHA256`. Scope diverso richiede protocollo diverso. `.env.model-a-prospective.example` è solo modello: non sovrascrivere env esistenti né committare valori reali.
4. Ottenere consenso specifico per backup/schema/configurazione e scritture accessorie PredictionService sul target. Provare prima `backend/experiments/model-a-prospective/schema.sql` su DB isolato, poi applicarlo manualmente solo dove autorizzato. Verificare separatamente runtime_calibration_cache e l'eventuale necessità di 014_runtime_calibration_cache.sql, senza invocare calibration:warm o cambiare i profili per completare il solo schema prospettico. Non usare bootstrap ordinario per ispezionare produzione. IF NOT EXISTS non corregge colonne/PK incompatibili: predisporre modifica additiva esplicita, senza drop. Nessuna migrazione automatica del collector.
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
| Provider Understat | Sì per calendario aggiornato e riconciliazione da fonte | Tornare a JSON valido in tutte le cinque leghe, poi confrontare fonte/DB e completare l'import autorizzato. La pagina HTML HTTP 200 non è una stagione vuota. |
| Genealogia temporale | No tecnica; sì validazione rigorosa | Conservare limite per evento; servono evidenze ulteriori reali, non un cambio etichetta. |
| Windows/libSQL intermittente | Non da solo per Linux provato | Diagnostico ripetibile e fallimenti visibili. Gate Linux verde; causa nativa irrisolta. |
| Carico/quote/costi | Sì prima accensione | Budget e prova autorizzata; benchmark locali non dimostrano sostenibilità remota. |
| Rettifiche vecchie/ufficialità | Limite da accettare | Classificazione fuori orizzonte/fonte ufficiale se necessaria; non inventare risultati. |
| Main/webhook | Solo pubblicazione main | Gate Hostless osservati spenti; proprietario verifica hook e integrazioni non accessibili all'account write. Confermare anche il disuso dei branch prima della pulizia. |

| Criterio | Stato |
|---|---|
| A — Preparazione tecnica | Implementazione completata, gate Linux e frontend verdi; Windows conserva l'intermittenza documentata. Accettazione dell'ambiente e decisioni operative ancora necessarie: non conclusa in senso incondizionato. |
| B — Raccolta prospettica | Non attivata da questo lavoro. |
| C — Validazione statistica | Non conclusa: campione futuro indipendente adeguato, copertura/esclusioni, Brier/Log Loss/calibrazione e incertezza, distinguendo rigoroso/tecnico. Nessuna prova di maggiore affidabilità o profitto. |

## File della consegna

| Responsabilità | File principali |
|---|---|
| Cattura/persistenza | PredictionService.ts, ModelAProspectiveInputs.ts, ModelAProspectiveRecorder.ts, ModelAProspectiveSpool.ts |
| Collector | ModelAProspectiveCollection.ts, ModelAProspectiveBudget.ts, scripts/model-a-prospective-collect.js, schema/upgrade manuale e workflow prospettico |
| Risultati | ModelAProspectiveResultRefresh.ts, scripts/model-a-prospective-results-recover.js, paired-results.sql, technical-paired-results.sql |
| Monitor | ModelAProspectiveMonitoring.ts, model-a-prospective-inspect.js, check-model-a-prospective.js, helper alerts/result-monitoring |
| Pubblicazione | calibration-warm.yml, ci.yml, check-operational-workflow-gates.js |
| Prove/configurazione | Test model-a-prospective/workflow/calibrazione, fixture view isolata, deviazioni sorgente autorizzate, benchmark, diagnostico nightly/store/view, check-model-a-spool.js, scripts/verify-model-a-linux.ps1, Compose/env example separati |
| Guide | Handoff/protocollo/A, README, GitHub Actions/Hostless e README fixture golden |

Nessuna nuova dipendenza, formula, peso o sorgente C; nessun Docker operativo o DB remoto modificato. Gli osservatori PredictionService cambiano hash e identità APP-A-*: registrare nuova versione anche a numeri invariati. Non equivalgono a modifica predittiva o promozione C.
