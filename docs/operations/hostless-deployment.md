# Deploy web su Hostless

Hostless serve frontend React e backend Express; Turso conserva i dati
condivisi. Import e automazione A/C sono un job finito su GitHub Actions,
come descritto nella [guida Nightly](../github-actions-nightly-sync.md).
Non richiedono PC o smartphone accesi. Questa è una procedura di rilascio,
non una certificazione dello stato attuale dell'account o dei servizi.

## Configurazione da controllare

| Componente | Configurazione prevista dal repository |
| --- | --- |
| Backend | Build Docker con contesto `backend/`, [Dockerfile](../../backend/Dockerfile), target runtime e comando `node dist/index.js` |
| Frontend | Root `frontend/`, install `npm ci`, build `npm run build`, output `build/` |
| API | Porta `PORT` oppure 3001; healthcheck `/api/health` |
| Persistenza | `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` server-side; filesystem container effimero |
| Nightly | `NIGHTLY_ORCHESTRATOR=github_actions`; niente scheduler interno duplicato |
| Worker T−15 | Ritirato; non configurare `research-worker.js` come processo persistente |

Il Dockerfile usa Node 20, utente non root e healthcheck interno ogni
15 secondi. L'inferenza C legge gli alberi JSON in Node: Python/CatBoost
serve al training e alla verifica separata, non all'immagine runtime web.
Non aggiungere smoke ripetuti o training al comando d'avvio del servizio.

Controllare nel pannello Hostless repository/branch/commit, root e contesto
di build, comando, auto-deploy, risorse, worker e cron esistenti prima del
rilascio. Non dedurre piano, limiti gratuiti, fatturazione, continuità o
capacità residua dai limiti Docker o da una vecchia misura CPU.
Restare sui servizi esistenti e sul piano gratuito effettivamente disponibile;
un aumento di risorse o servizio a pagamento richiede una decisione esplicita.

## Deploy controllato senza bootstrap dello schema

Il comando web ordinario costruisce `DatabaseService` e, per compatibilità, esegue inizializzazione e migrazioni. Recorder e scheduler spenti non impediscono queste scritture. Prima di un deploy che deve conservare lo schema esistente impostare sul solo backend web `WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED=false`, senza cambiare URL/token. Il flag viene letto prima della costruzione del DB; valori non validi bloccano l'avvio. Assente o true conserva il comportamento precedente. Non cambia il collector, che già usa skipSchemaBootstrap.

Mantenere `MODEL_A_PROSPECTIVE_ENABLED=false`, `MODEL_A_PROSPECTIVE_COLLECTION_ENABLED=false`, orchestratore GitHub e scheduler web/lineup spenti. Controllare nel pannello comando iniziale e post-build: nessuna migrazione o warmup aggiuntivo. Salvare configurazione e distribuire manualmente il commit con CI verde; attendere Deployed LIVE, controllare log e impostazioni effettive nel processo. `/api/health` è una risposta HTTP di salute, non certifica da sola lo schema o l'identità del DB. Verificare separatamente con client raw e sole SELECT. Nessun deploy autorizza bootstrap o raccolta.

Il bypass impedisce le scritture di avvio, non rende l'app read-only: richieste utente e processi già autorizzati conservano i propri effetti, inclusa la cache di calibrazione. Non aprire previsioni per fare uno smoke tecnico privo di scritture. Non disabilitare protezioni o cambiare token per aggirare un controllo. Un rollback a una versione precedente all’opzione ignora questo flag e riattiva il bootstrap: per conservare il vincolo senza migrazioni usare soltanto versioni che supportano il bypass o un fix successivo verificato.

Per la transizione paper, la sola migrazione additiva 028 lascia intatti
schema e dati precedenti. Il backend vecchio può restare attivo durante
questa preparazione, ma non deve leggere nuove decisioni paper: attivarle
solo dopo il backend aggiornato. Il nuovo backend con bootstrap spento e
DB pre-028 conserva la manutenzione legacy quando paper non è mai stato
inizializzato; l'API paper risponde esplicitamente 503 e la Nightly paper
resta bloccata. Uno schema parziale o già attivato non viene ignorato.
Applicare esplicitamente la sola migrazione autorizzata dopo backup e
verifica del target; il bootstrap ordinario eseguirebbe anche altre
migrazioni e procedure pendenti. Verificare due tabelle, cinque trigger,
indici e foreign key, quindi backend, frontend e infine Nightly.
Un rollback al vecchio backend dopo l'attivazione non è trasparente:
non riconosce i nuovi bet e può interpretarne male le decisioni. Conservare
un percorso compatibile per letture e liquidazioni finché esistono pending.

## Compatibilità del modello registrato prima del rilascio

Prima di distribuire main confrontare anche il manifest della baseline compilata con quello richiesto dal modello C registrato; build, health e CI non dimostrano questa compatibilità. Per il C congelato registrato la baseline richiesta è A-80cb25df5552621e. Main conserva il nucleo numerico research effettivo della release 6ed36d4 in uno snapshot immutabile, con pipeline e dipendenze isolate dai modelli operativi correnti di A. Non correggere la dichiarazione dell’artefatto o disabilitare la guardia per ottenere un esito positivo.

Il ramo `ops/model-a-web-compat` è stato usato per il ripristino sicuro e va conservato finché associato a un deploy attivo. Per tornare a main verificare SHA-256 dello snapshot in build, CI e prova read-only con il vero artefatto C: baseline, hash pipeline, input e inferenza devono coincidere con la release ripristinata. Attendere LIVE e ripetere identità, health e flag false nel container. Solo dopo può essere eliminato il ramo temporaneo già incorporato. Nessuna nuova versione C, migrazione o accensione è implicita; mantenere `WEB_DATABASE_SCHEMA_BOOTSTRAP_ENABLED=false`. Vedere l’handoff per prove e limiti.

## Persistenza per il recorder prospettico A

La raccolta separata può usare due modalità esplicite. Nessuna è stata
attivata o provisionata dal solo aggiornamento del repository.

| Processo | Persistenza prevista |
| --- | --- |
| [Workflow prospettico GitHub](../../.github/workflows/model-a-prospective.yml) | `MODEL_A_PROSPECTIVE_STORAGE=database`: una previsione è confermata dopo la scrittura verificata nel DB, senza spool del runner |
| [Profilo Compose opzionale](../../docker-compose.model-a-research.yml) | `MODEL_A_PROSPECTIVE_STORAGE=file`, spool `/app/data/model-a-prospective-spool` sul volume nominato `model-a-research-data` |
| Web e Nightly A/C esistenti | Abilitare la raccolta separata non abilita automaticamente il recorder su questi processi |

Il workflow esegue un ciclo ogni 30 minuti solo con l'opt-in repository;
l'avvio manuale richiede anche consenso esplicito. Schema, protocollo,
manifest e target devono essere verificati prima dell'attivazione: il
collector non applica migrazioni. Procedura e variabili sono nella
[guida GitHub](../github-actions-nightly-sync.md#raccolta-prospettica-a-separata-spenta-di-default).
Non sono richiesti un nuovo servizio Hostless o un volume remoto per la
modalità database del runner. Un errore di rete/scrittura non diventa
un evento acquisito; il ledger conserva le consegne non confermate senza
rigenerare automaticamente la previsione.

Il calendario research football-data.org è un opt-in separato, con
`MODEL_A_RESEARCH_CALENDAR_ENABLED=false` per default sia nel workflow sia nel
profilo Compose. Serve soltanto al collector per fixture, stato e kickoff;
Understat conserva xG, storico ed esiti. Non aggiorna `matches`/`teams` e non
cambia il calendario della Nightly A/C o del web.

Prima di abilitarlo occorrono account Free autorizzato e condizioni accettate,
il secret privato `FOOTBALL_DATA_ORG_API_KEY`, mapping ID revisionato in
`MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON`, conteggi attesi in
`MODEL_A_RESEARCH_CALENDAR_EXPECTED_TEAM_COUNTS` ed età massima in
`MODEL_A_RESEARCH_CALENDAR_MAX_AGE_SECONDS`. Questa chiave è distinta da
API-Football; `API_FOOTBALL_ENABLED` resta `false`. Non basta aggiungerla alle
variabili del backend Hostless: va configurato il processo collector scelto.
Registrazione e accesso reale del provider non sono certificati dal codice.

Fonte, hash del mapping e policy entrano nel manifest di un nuovo protocollo
con una sola stagione. Le due tabelle append-only `model_a_calendar_attempts`
e `model_a_calendar_fixtures` richiedono lo schema manuale autorizzato; nessuna
migrazione o attivazione deriva dalla configurazione. Feed incompleto,
ambiguo, fallito o scaduto esclude la lega senza fallback silenzioso; le altre
possono proseguire con run `partial` ed exit code `1`. Acquisizione locale e
revisione provider non sono pubblicazione: `publicationAt` rimane null e la
provenienza resta `technical_only`. Procedura e variabili nella
[guida del calendario research](../github-actions-nightly-sync.md#calendario-alternativo-del-solo-collector).

La modalità database del runner è la scelta consigliata finché il DB Turso esistente, le sue quote
effettive e la copertura osservata del runner soddisfano lo studio: evita
un volume a pagamento aggiuntivo. Il cron GitHub può ritardare o perdere job
in coda; nei repository pubblici si disabilita dopo 60 giorni senza attività.
I [limiti ufficiali dello schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
richiedono controllo dei run e della copertura. Se serve un processo continuo,
il collector esistente può già eseguire il loop su un processo autorizzato,
con `MODEL_A_COLLECTION_INTERVAL_SECONDS` positivo (minimo 60). Non occorre
riattivare T−15 o cambiare il comando del backend web; disponibilità del
processo, costi e monitoraggio restano da verificare prima dell'avvio.

Il profilo Compose riusa l'immagine backend, non espone HTTP e lascia web e
stack ordinario separati. Ha root in sola lettura, `/tmp` temporaneo e mount
dedicato `/app/data`. Raccolta, recorder, refresh esiti e monitoraggio sono
spenti di default nell'[esempio ambiente](../../.env.model-a-prospective.example).
Il flag di monitoraggio non avvia un monitor separato nel servizio Compose.
Per verificare la configurazione senza avviare processi o creare volumi,
usare un file ambiente privato, non versionato:

```powershell
docker compose --env-file .env.model-a-prospective.private -f docker-compose.model-a-research.yml --profile model-a-research config --quiet
```

Una configurazione valida non prova permessi, hard link, fsync, backup/restore,
capacità o sopravvivenza del volume alla sostituzione del container. Queste
prove richiedono l'avvio autorizzato sull'ambiente scelto. Il Compose
ordinario continua a non montare uno spool persistente sul backend web.
Un volume del web non diventa lo spool del runner GitHub.

Il [preflight spool](../../backend/scripts/check-model-a-spool.js) accetta
una directory assoluta già esistente. Per default legge soltanto i metadati:

```powershell
node backend/scripts/check-model-a-spool.js --directory "C:\percorso\spool"
```

L'opzione aggiuntiva `--probe`, da usare solo sul percorso di prova
autorizzato, crea e rimuove esclusivamente un figlio temporaneo privato
`.model-a-probe-*` dentro la directory indicata. Verifica scrittura,
contenuto, hard link e sincronizzazione della directory dove supportata;
non modifica i file spool esistenti. Su Windows permessi privati e fsync
della directory restano non attestati dal probe. Il risultato non prova
persistenza del mount, backup/restore, resistenza a perdita di alimentazione,
capacità o disponibilità del database.

Per Hostless consultare [filesystem](https://docs.hostless.cloud/app/filesystem)
e [costi dei volumi](https://docs.hostless.cloud/billing/costbreakdown), poi
verificare mount, persistenza e condizioni economiche effettive nel pannello.
Nessun volume o costo aggiuntivo è stato provisionato. Non assumere che un
percorso configurato sia persistente o gratuito. Nel pannello accessibile la
configurazione del backend non dichiara un mount dello spool e mantiene
recorder e collector esplicitamente spenti; l'inventario Storage/Volumes mostra No volumes yet.
Non c'è una prova di persistenza per la modalità file. L'ispezione del pannello
è possibile dal browser integrato, con login separato da Chrome.

Il monitor GitHub è facoltativo e spento di default; usa sole `SELECT` e
pubblica diagnostica aggregata e riepilogo nel job. Gli artifact durano
14 giorni e non sono backup degli eventi, né provano sopravvivenza prima
dell'upload. Il job A nel watchdog orario separato può rilevare il collector mai partito; resta il limite di un’interruzione complessiva di GitHub Actions. Vedere il
[passaggio Fase 4](../models/MODEL-A-FASE-4-HANDOFF.md) per i limiti ancora aperti.
I budget predefiniti sono `MODEL_A_COLLECTION_PREDICT_BUDGET_MS=30000` e
`MODEL_A_COLLECTION_CONFIRMATION_BUDGET_MS=45000`; misure e soglie del run
sono persistite in `performance_json`. Il superamento viene segnalato senza
troncare il calcolo; prestazioni non misurate o non verificabili non vanno
considerate una prova del rispetto del budget. Il recupero storico degli
esiti ha un [piano separato e consenso esplicito](../github-actions-nightly-sync.md#recupero-degli-esiti-prospettici-fuori-dallorizzonte-ordinario).

## Effetti operativi del push su main

La CI conserva lint, typecheck, build e test su push/PR di `main`, senza
ricevere credenziali del DB. Il workflow
[calibration-warm.yml](../../.github/workflows/calibration-warm.yml) è ora solo
manuale: richiede `authorize_database_writes=true` e la variable repository
`OPERATIONAL_CALIBRATION_ENABLED=true`. L'input ha default `false`.
Quando esplicitamente autorizzato, lo
[script](../../backend/scripts/warm-calibration.js) applica lo schema cache
`014_runtime_calibration_cache.sql` e salva profili; il push non lo esegue.
Il warmup della Nightly è un'operazione separata già prevista dal suo ciclo.

Anche la raccolta prospettica non ha trigger push/PR. Il prossimo cron può
però partire se `MODEL_A_PROSPECTIVE_COLLECTION_ENABLED` è già `true` nel
repository: controllare i valori remoti prima di integrare un nuovo workflow.
Il [checker dei contratti sorgente](../../backend/scripts/check-operational-workflow-gates.js)
verifica questa separazione senza accedere al DB:

```powershell
node backend/scripts/check-operational-workflow-gates.js
```

Il controllo non legge le impostazioni Hostless. Verificare separatamente
branch collegato, auto-deploy e hook del provider prima di pubblicare su un
branch che potrebbe essere distribuito: l'assenza di un hook nei workflow
non dimostra che l'auto-deploy sia spento. Sono stati letti nel pannello
i gate dei quattro servizi esistenti, con auto-deploy spento e review app/site spente.
Il backend segue temporaneamente il ramo operativo di compatibilità C; frontend,
worker standalone e cron restano associati a main.
Sono impostazioni modificabili: ripetere il controllo prima del push.
La pubblicazione del codice non
costituisce autorizzazione a eseguire deploy, migrazioni, provisioning di
volumi o attivazioni; gli automatismi esterni vanno esclusi prima del push.
Anche l'inventario webhook GitHub resta non verificato: l'accesso con ruolo
write ha ricevuto HTTP 404 e richiesta dello scope `admin:repo_hook`.
Questo errore di autorizzazione non dimostra assenza di hook; anche la pagina
GitHub Settings/Webhooks restituisce 404 con l'account write disponibile.
Il proprietario deve controllare Webhooks e Integrations/GitHub Apps: per ogni
integrazione attiva verificare eventi push/create/delete/workflow_run,
branch, destinazione e azione eseguita. Non esportare URL contenenti secret.
Un hook Hostless con auto-deploy spento non dimostra l'assenza di altri hook.

Il deploy live e la salute vanno controllati separatamente dalla pubblicazione:
aprire Deployments, verificare Deployed LIVE e il commit; leggere Logs e
confrontare il dettaglio Alerts con first/last observed e timeline. Un incidente
ancora firing ma senza osservazioni recenti non prova un crash attuale;
acknowledged non significa risolto. Non chiuderlo manualmente per rendere verde
il pannello. Il probe configurato nel pannello è TCP: una risposta positiva
di /api/health aggiunge una prova HTTP puntuale, non di DB, provider o scheduler.

La pulizia dei branch richiede una verifica separata: confronto con `main`,
assenza di commit esclusivi da conservare, PR, worktree e utilizzatori esterni.
Un branch già incorporato è un candidato alla rimozione dopo questi controlli,
non una prova che nessun collaboratore o servizio lo usi. Non cancellare
backup con storia divergente o branch ancora attivi per uniformare l'elenco.

## Verifiche da completare prima della raccolta

| Verifica | Procedura e criterio |
| --- | --- |
| Identità del DB | Il pannello conserva TURSO_DATABASE_URL e TURSO_AUTH_TOKEN come write-only: il proprietario confronta privatamente il DB canonico di Hostless con i secret Actions e la configurazione autorizzata. Non dedurre identità dalla presenza dei nomi delle variabili. |
| Schema | Verificare sul target le tabelle Fase 4, incluse model_a_calendar_attempts e model_a_calendar_fixtures per il calendario alternativo, e runtime_calibration_profiles. Dopo conferma del target, backup/restore verificato e consenso, applicare lo schema prospettico manuale e valutare separatamente la cache runtime esistente; nessun bootstrap ordinario usato come preflight. |
| Scritture accessorie | Il collector non esegue calibration:warm né migrazioni. Il vero PredictionService può però salvare runtime_calibration_profiles a cache miss; il recorder avvia anche l'associazione agli esiti già nel DB. L'autorizzazione all'accensione deve comprendere questi effetti, oltre a forecast, ledger, run e osservazioni. |
| Durabilità Turso | Sul target di prova autorizzato attendere completion e rilettura coerente del forecast/claim, poi provare riavvio e indisponibilità/ripristino rete. Un receipt pending o HTTP veloce non è una conferma. Non fare fault injection sul DB operativo per una verifica locale. |
| Scheduler | Runner finito database, scope/hash futuri e flag inizialmente false; nessun nuovo servizio Hostless necessario. Prima dell'accensione verificare il calendario importato oppure, con opt-in alternativo, mapping, completezza e freschezza delle evidenze research; una Nightly riuscita non certifica il nuovo provider. |
| Monitor e recupero | Eseguire il monitor SELECT-only sullo scope autorizzato, verificare backlog/claim non confermati e controllare anche l'assenza di run. Provare segnali/drain/riavvio su target di prova; conservare le mancate senza rigenerazione postuma. |

La sequenza completa, compresa la disattivazione, resta nel
[passaggio Fase 4](../models/MODEL-A-FASE-4-HANDOFF.md#procedura-di-attivazione-controllata).

Il controllo preliminare di schema può usare la seguente sola lettura nel
client del DB canonico verificato, senza avviare l'applicazione:

```sql
SELECT tbl_name, type, name
FROM sqlite_master
WHERE tbl_name IN (
  'model_a_prospective_forecasts', 'model_a_prospective_results',
  'model_a_collection_protocols', 'model_a_collection_ledger',
  'model_a_collection_runs', 'model_a_prospective_result_observations',
  'model_a_prospective_result_refresh_state', 'model_a_calendar_attempts',
  'model_a_calendar_fixtures', 'runtime_calibration_profiles'
)
ORDER BY tbl_name, type, name;
```

Risultato vuoto significa oggetti assenti su quel DB, non autorizzazione a
crearli. Se presenti, verificare anche colonne/PK/indici/trigger con il monitor
read-only sullo scope preregistrato; il solo nome non certifica compatibilità.
Il riesame sul DB locale configurato ha confermato gli oggetti assenti senza
scritture: mantenere la migrazione in sospeso finché identità, backup/restore e
consenso non sono acquisiti. Non usare il bootstrap ordinario come preflight.

## Ambiente, accesso e URL

Usare il pannello nativo del provider per i secret già autorizzati. Le
variabili `REACT_APP_*` sono pubbliche nella build: non contengono password,
token Turso o chiavi quote. Il riferimento locale è [.env.example](../../.env.example).

- Backend: `NODE_ENV=production`, `SHARED_ADMIN_AUTH_ENABLED=true`,
  `SHARED_ADMIN_PASSWORD_HASH` valido, `SHARED_DATA_USER_ID` coerente con i
  dati esistenti. La produzione rifiuta l'avvio senza hash richiesto.
- `CORS_ORIGIN` deve ammettere l'origine frontend effettiva e
  `https://localhost` per Android. Verificare HTTPS, proxy e cookie di sessione.
- Turso deve essere lo stesso canonico per web, Nightly, calibrazione,
  training e manutenzione; il watchdog usa un token dedicato RO sul medesimo DB.
- Quote: chiave backend/runner e `ODDS_API_ACCOUNT_SCOPE` coerenti fra processi.
  Budget pianificato e quote residue misurate sono informazioni diverse.
- Tenere bootstrap e scheduler web disabilitati quando GitHub è l'orchestratore;
  `RESEARCH_T15_SCHEDULER_ENABLED=false`. I flag A/C sul web dichiarano stato,
  ma il job è avviato soltanto dal workflow.

Il [client API](../../frontend/src/utils/api.ts) usa `REACT_APP_API_URL` se
presente, altrimenti `/api` nel browser e
`https://scommese-sportive-backend.hostless.app/api` su Android.
Per il frontend Hostless separato impostare in fase di build l'URL HTTPS
corretto del backend; non assumere che `/api` sia inoltrato automaticamente.
Il valore incorporato nell'APK cambia solo con una nuova build autorizzata.

Per generare un hash condiviso usare `npm run auth:hash` da `backend`, con
password fornita via standard input, senza password negli argomenti o nella
cronologia. Conservare hash e password nei canali privati appropriati;
non inserirli nella documentazione, nel frontend o nell'APK.

## Sequenza di rilascio e verifica

1. Verificare checkout, commit da distribuire, diff, compatibilità delle
   migrazioni additive e [backup](turso-backup.md) quando il DB è coinvolto.
   Eseguire i controlli di codice pertinenti prima del rilascio.
2. Distribuire il backend dal commit previsto. Attendere l'esito finale del
   provider: Queued, Building o una CI verde non significano LIVE.
3. Controllare `/api/health`, login/sessione e le API necessarie al frontend
   (in particolare `/api/wallets` dopo modifiche ai portafogli). Verificare
   l'identità del DB senza esporre credenziali e mantenere invariati i saldi.
4. Distribuire il frontend dopo il backend compatibile, con l'URL API corretto.
   Controllare nel browser sessione, Partite, Giocate, Budget e Archivio,
   dispositivi stretti e messaggi di indisponibilità quote.
5. Verificare separatamente Nightly/watchdog quando il rilascio li riguarda.
   Evitare fetch quote o registrazioni manuali soltanto per provare il deploy:
   aprire Giocate nel dettaglio può richiedere quote reali e consumare crediti.

Il backend previsto dal client espone l'healthcheck a
[questo indirizzo](https://scommese-sportive-backend.hostless.app/api/health).
L'URL identifica il target configurato; non attesta che risponda ora.
Un aggiornamento web non aggiorna gli asset React già inclusi nell'APK:
vedere [procedura Android](../android-private-apk.md).

## Worker legacy, CPU e rollback

La CLI [research-worker.js](../../backend/scripts/research-worker.js) stampa
`worker_retired` e termina normalmente. Un worker incorporato rimasto con
quel comando può fallire il proprio ciclo di vita mentre il web è LIVE.
Verificare separatamente deployment web e inventario worker; non riattivare
T−15 e non sostituire il comando con la Nightly finita per simulare un demone.
La rimozione di configurazioni cloud obsolete richiede verifica dell'esatto
oggetto e del resto della configurazione; non eliminare altri servizi o dati.

Un avviso CPU, un campione aggregato e un deploy in coda descrivono fenomeni
diversi. Correlare orario, processo, log e metriche prima di attribuire una
causa al modello o dichiarare risolto il problema. Una cache di calibrazione
non riusabile può richiedere calcolo completo su richiesta; un hash di codice
diverso non prova riuso del warmup.

Per fermare nuove registrazioni recommendation spegnere il relativo flag
GitHub, mantenendo il ciclo di manutenzione e liquidazione. Per rollback di
codice usare una versione compatibile con schema e payload esistenti,
coordinando frontend, backend e workflow sul DB canonico. Un backup locale
non autorizza un restore remoto; non ripristinare collegamenti a vecchi DB
o cancellare ledger e storico.
