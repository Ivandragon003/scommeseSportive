# FootPredictor su Hostless: procedura manuale

Procedura aggiornata il 29 ottobre 2026. Backend e frontend `122fd360` sono online,
la nightly di manutenzione è collaudata e il Turso esistente è aggiornato.
**Il sistema automatico resta bloccato su Hostless:** il worker creato non viene
distribuito e il cron watchdog non viene salvato. Scheduler e registrazioni
restano disabilitati. Non considerare il deploy web una prova di T−15.
Per fatti, prove e ripresa leggere il [report operativo](production-status-2026-10-29.md)
e la [scheda del blocco Hostless](hostless-blocker-2026-10-29.md).
Il [report locale](hostless-readiness-2026-10-27.md) conserva misure e limiti storici.

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
anche scaling e worker al deploy. Root e contesto backend sono ora verificati
come `/backend`, ma capacità residua e costo del worker non sono visibili con
i permessi correnti. Usare le impostazioni manuali sottostanti
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

## Stato verificato del rilascio

Il progetto è `Ivandragon003's Project`, ID `6a838a83424e48848fce82b0`.
L'account ha ruolo `Editor` e può ora aprire le impostazioni. Backend e Site
puntano a `Ivandragon003/scommeseSportive`, branch `main`. Il backend usa Docker,
directory e contesto `/backend`, `Dockerfile`; start e post-build personalizzati
sono vuoti. Le risorse correnti sono 0,1 vCPU, 256 MiB e una replica, massimo uno.
Il Site usa `/frontend`, installazione `npm ci`, build `npm run build` e output
`./build`. L'auto-deploy di entrambi è stato disattivato e salvato per evitare
pubblicazioni premature; le altre modifiche salvate si applicano al deploy.

Il pannello non consente la lettura della fatturazione del progetto. L'utente
ha chiesto esplicitamente di procedere senza attendere la verifica delle quote
account: questo è registrato come verifica omessa, non come gratuità confermata.
Non autorizza nuovi piani, carte, overage o servizi a pagamento.

Il token Turso esistente è valido per SQL in lettura/scrittura sul database
atteso: non occorre accesso amministrativo alla piattaforma per le migrazioni
additive. Backup remoto e ripristino isolato sono completati; `015–019` hanno
preservato i dati preesistenti dopo due applicazioni sulla copia. Le migrazioni
`015–019` sono poi state applicate in produzione e il registro contiene 20
versioni. Il backend `122fd360`, deploy `6ae3213f30465a147074f461`, risponde con
health `200`, vecchia route `410` e API research anonima `401`. Il registry
contiene A e il candidato C senza promozioni; i 26 mercati restano sperimentali.
Il frontend `122fd360`, deploy `6ae322cd7b2d5d826aa0c130`, è anch'esso online:
login reale, sessione dopo reload, calendario e dashboard A/C verificati.

La richiesta worker a 512 MiB ha mostrato il requisito di aggiungere una carta
ed è stata annullata. È stato creato soltanto il worker embedded Small
`footpredictor-t15`, ID `6ae3240430465a1470752801`, 0,1 vCPU/256 MiB, una replica.
Non è operativo: UI `DEPLOYING`/`Not deployed`, stato deployment `missing`,
`ready=false`; il record esiste ma la gestione ambiente restituisce `404`
`App worker not found`. Redeploy e restart non hanno prodotto un processo
osservabile. Non è stata determinata la causa radice e non sono state create
risorse alternative o copie del worker.

Il comando iniziale conserva inferenza di collaudo, fixture E2E isolate e
`RESEARCH_T15_SCHEDULER_ENABLED=false`: un'eventuale partenza successiva non
abilita registrazioni. L'inferenza C dal registry è stata verificata separatamente
nel terminale del backend; l'E2E nel worker Hostless non è stato eseguito.
Anche il cron watchdog è bloccato: il salvataggio restituisce `400` con comando
minimo e pianificazione UTC ogni cinque minuti. La lista cron resta vuota.

`Prepare prediction calibration` è stato riattivato (`active`) dopo la verifica
delle migrazioni. Il watchdog GitHub resta manuale; manca il token dedicato di
sola lettura. Nessuna pianificazione o nuova notifica esterna è dichiarata.
Per riprendere si può riparare l'embedded tramite proprietario/assistenza
Hostless oppure usare l'alternativa ufficiale standalone nello stesso progetto.
Non occorrono entrambe. Il wizard standalone è stato esplorato senza creare
risorse: Source mostra `No repositories accessible`; Repository spiega che
autorizzare Hostless non installa la GitHub App. Serve il proprietario/admin
GitHub `Ivandragon003` per installare Hostless sul solo repository
`scommeseSportive` tramite `Manage GitHub access`, poi aggiornare l'accesso.
È stato chiesto all'utente, con risposta pendente; nessun nuovo grant eseguito.
Questo riscontro non dimostra la causa del guasto embedded. Preservare web e
database e impedire due worker operativi durante l'eventuale sostituzione.

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

Le risorse proposte inizialmente erano web 0,25 vCPU/256 MiB e worker
0,25 vCPU/512 MiB. La richiesta worker a 512 MiB ha però richiesto una carta:
non è stata attivata. Il backend conserva 0,1 vCPU/256 MiB e il worker creato
usa 0,1 vCPU/256 MiB, una replica. Prima della creazione, il ciclo E2E locale
isolato è passato con questi limiti (picco 168,76 MiB); questa prova non
sostituisce l'accettazione e l'uptime Hostless, attualmente bloccati.
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
