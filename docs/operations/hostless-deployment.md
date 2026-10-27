# FootPredictor su Hostless: procedura manuale

Procedura preparata il 27 ottobre 2026. La vecchia nightly remota è stata
temporaneamente sospesa; nessun nuovo deploy Hostless è stato eseguito.
Per prove e blocchi correnti leggere il [report operativo](production-status-2026-10-27.md).
Non abilitare il worker prima dei controlli qui descritti.
Il [report locale](hostless-readiness-2026-10-27.md) contiene risultati e limiti.

## Scelta del processo

Usare **A: worker persistente separato**. Hostless documenta worker standalone
oppure embedded in una app: l'embedded riusa immagine e ambiente del backend,
ma esegue un processo distinto con risorse e repliche proprie. È il primo
candidato per l'app esistente; standalone resta possibile se l'account lo consente.
Non servono code, un altro database, un volume o Oracle. Turso conserva modelli
JSON, portafogli, job, lease, heartbeat e cache quote; il filesystem del container
può essere temporaneo. Tenere una replica, pur con protezioni contro duplicati.
[Riferimento ufficiale worker](https://docs.hostless.cloud/app/workers).

**B: scheduler nel processo web** è scartata per questa consegna: il suo ciclo
di vita e il carico HTTP interferirebbero con T−15. L'entrypoint web non avvia
ResearchRuntime nemmeno se conserva un vecchio flag true. Non si riattiva B
automaticamente se il piano non permette A: si rivalutano prima le risorse.

Non è stato aggiunto un `hostless.yaml` attivo: il file applica automaticamente
anche scaling e worker al deploy, mentre root di build, piano e risorse delle
app esistenti non sono ancora noti. Usare le impostazioni manuali sottostanti
senza sovrascrivere quelle del frontend. Un eventuale file IaC va derivato solo
dalla configurazione dell'account verificata.
[Riferimento ufficiale YAML](https://docs.hostless.cloud/app/hostlessfile).

## Checklist del proprietario prima di pubblicare

- Verificare piano legacy/PAYG, ciclo corrente, risorse già allocate in tutti i
  progetti, numero di worker, disponibilità embedded, eventuali restrizioni di
  fatturazione, spending limit e gratuito effettivo. Non aggiungere carte o crediti.
- Annotare app backend e Site frontend, repository/branch/revisione, root e
  contesto di build, porte, healthcheck, repliche e impostazioni auto-deploy.
  Conservare la revisione precedente e una copia privata della configurazione.
- Controllare che web, worker e Actions usino lo **stesso Turso esistente**.
  Non copiare token in terminale, log o documenti. Verificare backup/recovery.
- Controllare versione C e configurazioni probabilistiche nel registry,
  compatibilità JSON e prove di validazione richieste dai mercati. La prova
  Linux di inferenza non promuove un candidato e non approva mercati.
- Verificare chiave quote già autorizzata, stesso `ODDS_API_ACCOUNT_SCOPE`
  per tutti i processi e budget reale dell'account. Vietate rotazione automatica
  delle chiavi, quote inventate e promozioni basate su fixture.
- Il mandato di produzione autorizza pubblicazione Git, migrazioni additive,
  deploy, test remoti e attivazione controllata dopo i gate. Non richiedere
  nuovamente conferma per questi passaggi. Restano esclusi costi aggiuntivi,
  migrazioni distruttive e operazioni prive di accesso autorizzato.
- Eseguire il [backup con ripristino isolato](turso-backup.md) dopo verifica
  delle quote account. Non interpretare il solo preflight come backup.

## Impostazioni Hostless

Backend: build Docker con **contesto `backend/` e Dockerfile `Dockerfile` dentro
quel contesto**, senza usare la root come contesto di COPY. L'etichetta del path
nel pannello può essere relativa al repository: verificarla prima del build.
Target finale `runtime`. Start `node dist/index.js`. Ascolta su `PORT`, fornita
da Hostless, su tutte le interfacce. Health HTTP `/api/health`, intervallo 15 s.
Non usare training come post-build. Non lanciare migrazioni sperimentali a mano
da una macchina locale collegata alla produzione. L'avvio di DatabaseService
applica le migrazioni additive: il primo avvio remoto è quindi anche una
**scrittura di schema** e richiede la relativa autorizzazione.

Worker embedded: stessa immagine, comando `node scripts/research-worker.js`
(oppure `npm run research:worker`), una replica. Prima creare/eseguire con
`RESEARCH_T15_SCHEDULER_ENABLED=false`. Controllare log di disabilitazione e
assenza di job, richieste e puntate nuove. Il processo disabilitato non è prova
di heartbeat operativo. Non configurare un cron: 15 secondi richiedono processo
persistente. Non usare endpoint HTTP o browser come trigger.

Punto di partenza da verificare nell'account: web 0,25 vCPU/256 MiB, worker
0,25 vCPU/512 MiB. I test sullo storico locale sono passati anche con 256 MiB
per il processo misurato, ma 512 lascia margine al ciclo completo. Il totale
proposto è 0,5 vCPU/768 MiB, prima di eventuali altre risorse dell'account.
L'healthcheck HTTP dell'immagine riguarda solo il web: nel worker Compose è
disabilitato; su Hostless non configurare una sonda HTTP su un processo senza
porta. Il watchdog diretto Turso controlla avanzamento, heartbeat e liquidazioni.

Frontend Hostless Site: conservare l'app già esistente, directory `frontend`,
build `npm ci && npm run build`, output `build`; impostare in fase di build
`REACT_APP_API_URL=https://<backend-esistente>/api`. Nessun secret nel frontend.
Conservare il fallback SPA a `index.html`, verificare login, cookie e CORS dal
dominio Site. Il Docker frontend locale usa invece nginx con upstream
`backend:3001`: quel DNS di Compose non va assunto disponibile fra due app
Hostless. Per il Site si usa l'URL HTTPS pubblico già configurato.

| Variabile | Configurazione |
| --- | --- |
| `NODE_ENV` | `production` |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | credenziali esistenti, stesso DB web/worker/Actions |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false` durante preparazione; `true` solo al collaudo autorizzato |
| `AUTO_BET_ENABLED` | `false`; la route legacy resta comunque ritirata |
| `NIGHTLY_ORCHESTRATOR` | `github_actions` |
| `AUTO_SYNC_ON_BOOT` | `false` |
| `UNDERSTAT_SCHEDULER_ENABLED`, `ODDS_SNAPSHOT_SCHEDULER_ENABLED` | `false` |
| `LEARNING_REVIEW_SCHEDULER_ENABLED`, `LINEUP_REFRESH_SCHEDULER_ENABLED` | `false` |
| `PLAYER_DATA_ENABLED`, `PLAYER_AVAILABILITY_ENABLED` | conservare pausa `false` |
| `ODDS_API_KEY` / alias esistente | secret già configurato; non sostituirlo |
| `ODDS_API_T15_KEY` | opzionale, soltanto chiave già autorizzata per lo stesso account |
| `ODDS_API_ACCOUNT_SCOPE` | stesso valore stabile per tutte le chiavi/processi dell'account |
| `ODDS_API_MONTHLY_CREDITS`, `ODDS_API_RESERVE_CREDITS` | `500`, `50` |
| `ODDS_INFORMATIONAL_NETWORK_ENABLED`, `ODDS_EXTRA_EVENT_NETWORK_ENABLED` | `false` |
| `SHARED_ADMIN_PASSWORD_HASH`, `SHARED_DATA_USER_ID`, variabili sessione | conservare configurazione privata esistente |
| `CORS_ORIGIN` | dominio HTTPS del Site esistente |
| `TZ` | `UTC` worker; timestamp persistiti con timezone |

Python/CatBoost **non sono dipendenze di inferenza del runtime web/worker**:
C usa il JSON CatBoost numerico in Node. Il training settimanale separato usa
Python 3.12 e `backend/ml/requirements.txt`. Non trasferire i modelli in un
nuovo filesystem persistente: si caricano dal registry condiviso. I test non
dimostrano che quel registry remoto contenga già un C operativo approvato.

## Disattivazione della vecchia registrazione notturna

1. Mantenere il nuovo worker disabilitato. Annotare saldi e conteggi dello storico.
2. Pubblicare, solo dopo autorizzazione, lo script e il workflow maintenance-only
   locali: nessuna chiamata `automation/place-valid-bets`, nessun dry-run di
   pianificazione sostitutivo. Impostare anche il vecchio flag a false.
3. Conservare schedule, import Understat/supplemento, calibrazione e `/bets/sync`:
   quest'ultimo liquida sia legacy sia portafogli A/C. Non disabilitare l'intero workflow.
4. Distribuire il backend con route legacy `410`. Verificare da ambiente
   autenticato che risponda `410` senza differenza nei conteggi.
5. Eseguire una nightly manuale e controllare log/DB: dati aggiornati e puntate
   aperte liquidabili, **zero nuove puntate future**, anche con vecchie env.
6. Solo dopo questa verifica procedere al worker. Non lasciare una finestra con
   vecchia registrazione e nuovo scheduler entrambi attivi.

Dettagli e test di regressione: [nightly](../github-actions-nightly-sync.md).

## Attivazione graduale e collaudo remoto

1. Preparare configurazione e artefatti con worker spento, controllare la revisione
   autorizzata e conservare configurazione precedente e recovery del database.
2. Eseguire il deploy web autorizzato: il suo primo avvio applica già le migrazioni
   additive al DB esistente. Poi verificare health, login, API, Site e registry,
   compatibilità dello storico e due portafogli. Non interpretare il deploy web
   come una prova precedente o indipendente dalla scrittura dello schema.
3. Configurare il [watchdog esterno](research-watchdog.md) con accesso DB in sola
   lettura. Il workflow è manuale per default: attivare una frequenza esterna
   soltanto dopo autorizzazione. La verifica diretta Turso funziona anche con
   backend spento; il health HTTP da solo non certifica T−15.
4. Prima testare restart, due istanze, variazione kickoff, quote scadute e
   liquidazione in un ambiente di collaudo autorizzato. Non inserire fixture nel
   database condiviso di produzione. Se non è disponibile un ambiente sicuro,
   limitare inizialmente il collaudo remoto a lettura/worker spento e mantenere
   bloccata l'attivazione finché il rischio non è risolto.
5. Dopo via libera, impostare il flag true e una replica; osservare heartbeat,
   lease e tick ogni 15 s, ritardo <=60 s, quote <=300 s e stesso snapshot A/C.
   La finestra persa deve diventare MISSED, mai una puntata retroattiva.
6. Controllare prima coorte reale di giocate **virtuali**, provenienza e timestamp,
   credito provider misurato, due portafogli e deduplicazione al riavvio.
   Nessuna promozione automatica di mercati in base al test sintetico.
7. Controllare la prima liquidazione reale e l'idempotenza; confrontare ledger e
   saldi, monitoring, latenze Turso, memoria e CPU sotto limite account.

Il periodo di osservazione va esteso a coorti contemporanee e almeno un ciclo
di nightly e liquidazione. GitHub Actions non garantisce avvio puntuale di un
watchdog programmato: non è un controllo subminuto né un sostituto del worker.

## Rollback

1. Disabilitare `RESEARCH_T15_SCHEDULER_ENABLED` e fermare/scalare a zero il worker.
   Attendere il drain/lease scaduta e verificare assenza di nuove registrazioni.
2. Conservare DB, decisioni, quote, ledger e migrazioni additive. Niente DROP,
   cancellazione di job o recupero retroattivo delle finestre saltate.
3. Lasciare attivi manutenzione, import e liquidazioni. Tenere ritirata la route
   legacy: se si ripristina una vecchia immagine, controllare prima che non
   riattivi quella route e bloccarne l'accesso durante la transizione.
4. Ripristinare la release web/Site precedente dal pannello solo se necessario,
   conservando `AUTO_BET_ENABLED=false` e tutte le disattivazioni scheduler.
5. Verificare health/login, saldi, liquidazione idempotente e watchdog che segnala
   lo stop atteso. Riparare in locale e ripetere il gate prima di riabilitare.

[Deploy e rollback ufficiali](https://docs.hostless.cloud/app/deployments).
