# FootPredictor su Hostless: procedura manuale

Procedura aggiornata il 29 ottobre 2026. Backend e frontend `122fd360` sono online,
la nightly di manutenzione è collaudata e il Turso esistente è aggiornato.
**Il sistema automatico resta bloccato su Hostless:** entrambi i deployment
standalone sono falliti per timeout di coda. Il watchdog SELECT-only è operativo
con worker spento, con 14 check reali `ok` nei Logs benché Runs resti vuoto.
Scheduler T−15 e nuove registrazioni shadow restano disabilitati; nightly di
manutenzione e cron watchdog sono attivi. Non considerare il deploy web una prova di T−15.
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

La richiesta embedded a 512 MiB ha richiesto una carta ed è stata annullata.
L'embedded Small `footpredictor-t15`, ID `6ae3240430465a1470752801`, resta
preservato e disabilitato: `missing`, `ready=false`, gestione ambiente `404`.

Il proprietario ha poi autorizzato la GitHub App: wizard `Connected as
Ivandragon003`, un repository accessibile, `scommeseSportive` e `main` verificati.
È stato creato lo standalone ufficiale `footpredictor-t15-standalone`, ID
`6ae33d3659ba816e50f640fd`, alle 13:33 CET: tier `FREE`, una replica, CPU
0,01–0,1 vCPU, RAM 128–256 MiB, `scaledDown=false`, `overdue=false`,
`autorelease=false`. Ventidue variabili necessarie copiate in modo protetto.

Il wizard aveva selezionato `ed9e58ad`: deployment `6ae33d3659ba816e50f6410b`.
Dopo il push della correzione nativa è stato richiesto esplicitamente alle
13:37 CET il deployment `6ae33df530465a14707721ec` da
`cc842005dfd994bc21f787604b107436f5544bc1`. Lista verificata alle 15:14 CET:
entrambi i deployment `ed9e58ad`/`cc842005` falliti con `Deployment waited too
long in the queue`. Risorsa `Sleeping`, nessun avvio build o collaudo dimostrato.
Nessun nuovo tentativo worker creato e nessuna causa della coda dedotta.
Il comando iniziale conserva smoke C in sola lettura, E2E con ambiente isolato
e poi attesa inattiva con scheduler `false`, senza ciclo automatico di test.

Il cron embedded aveva fallito con `400`. Il cron standalone
`footpredictor-watchdog` è ora creato tramite UI con Custom 0,1 vCPU/128 MiB,
ogni cinque minuti UTC, auto-deploy disattivato, otto variabili senza chiave
quote. Il preset Small 0,25 vCPU richiedeva una carta, con 0,2 vCPU gratuite
residue indicate: annullato; Custom accettato senza cambiare piano.
Il cron ha due deployment riusciti `cc842005`: LIVE delle 15:11
`6ae3540c7b2d5d826aa4a15c` e originale delle 13:59
`6ae3434030465a1470779a1f`. Runs resta vuoto e gli stati UI oscillano, ma
la ricerca `"ok"` nei Logs attesta 14 check reali riusciti ogni cinque minuti,
dalle 14:10:21 alle 15:15:13 CET (`13:10:21Z`–`14:15:13Z`). Il comando
SELECT-only è quindi operativo su Hostless con worker atteso spento e
`expectedEnabled=false`. I ritardi di output rispetto all'intervallo cron,
7–21 s, non misurano runtime o puntualità T−15. La lista Runs non rappresenta
le esecuzioni effettive; non va usata da sola per concludere che il cron è fermo.
Con il worker intenzionalmente spento non sono attesi allarmi di interruzione;
nessun nuovo canale gratuito connesso e nessuna consegna di notifica collaudata.

Lo script watchdog è stato provato in Docker 0,1 vCPU/128 MiB sul Turso reale:
exit 0, `ok`, worker `UNOBSERVED`, nessuna issue o arretrato liquidazioni,
zero scritture/provider. Riusa il token `rw` già disponibile, ma esegue solo
SELECT; questo non trasforma il token in sola lettura. Il workflow GitHub
resta manuale e richiede ancora `TURSO_WATCHDOG_READONLY_TOKEN`, senza fallback.
`Prepare prediction calibration` è `active`; il run di `cc842005` è riuscito.

Il warmup calibrazione `60a6baac` è riuscito. Il gate locale dall'immagine di
produzione della stessa revisione al Turso reale ha superato 40 profili per
passaggio, 80 hit validi e 100 SELECT, su cinque leghe con due nuove istanze di
PredictionService: zero fit, scritture o chiamate provider. La cache dipende
dall'intero `dist`, quindi la revisione del deploy deve corrispondere al warmup.
Non è una diagnosi dei warning CPU o un test del nuovo fix sul runtime Hostless.

Il deployment manuale backend `60a6baac` è stato richiesto alle 15:18 CET,
ID `6ae355cd7b2d5d826aa4c4c4`, ed è in coda. Al checkpoint 15:21 il web LIVE
resta `122fd360`, auto-deploy disattivato; nessun nuovo deploy frontend.
L'app autenticata e le sessioni funzionano; health `200`, route legacy POST
`410`, ricerca anonima `401`, portafogli da 1.000 euro ciascuno e zero
impegnato/puntate riconfermati in sola lettura. L'esito del nuovo deploy e
la richiesta cache-only sul nuovo runtime restano da verificare.
Il falso allarme per `odds_cache_only` ha una correzione pubblicata in
`60a6baac`, con 66/66 test mirati e revisione finale senza blocchi. CI
`40889233354` riuscita: 777 test backend, 776 passati, un opzionale saltato e
zero fallimenti; calibrazione `40889233171` riuscita. Il web LIVE
resta `122fd360`. Per questa correzione, il gate Windows
completo è fallito per crash nativo; il gate Linux QA è invece passato,
777 test, 776 superati, un opzionale CatBoost saltato e zero fallimenti.
Il limite Windows resta dichiarato; non attestare un deploy non eseguito.
[Nota tecnica](odds-cache-policy-2026-10-29.md). Il report tecnico è stato inviato
al supporto ufficiale Hostless circa alle 14:29 CET, su autorizzazione esplicita
dell'utente; Hostless ha confermato ricezione di dettagli e richieste di
preservare servizi/DB senza risorse a pagamento, ma non ha fornito diagnosi o fix.
Il timeout di coda e la discrepanza tra Runs vuoto e 14 check riusciti nei Logs
sono stati poi comunicati nello stesso caso, senza nuova diagnosi. Le prove
dell'invio restano artifact privati esclusi da Git.
L'audit quote da Linux locale verso provider/Turso è completato: cinque
richieste, 15 crediti, residuo 205, nessuna variazione delle otto tabelle
protette. Non è il collaudo del worker Hostless né della finestra T−15.
Preservare web e storico mentre l'assistenza esamina il timeout dei worker.
Il watchdog è già operativo nella modalità worker spento; prima dell'attivazione
T−15 restano collaudo del worker, rilevamento guasti e consegna notifiche.

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
   conservando `AUTO_BET_ENABLED=false`, T−15 e scheduler interni web disattivati.
5. Verificare health/login, saldi, liquidazione idempotente e watchdog che segnala
   lo stop atteso. Riparare in locale e ripetere il gate prima di riabilitare.

[Deploy e rollback ufficiali](https://docs.hostless.cloud/app/deployments).
