# FootPredictor su Hostless: web e nightly GitHub

Procedura aggiornata al 29 ottobre 2026 per **Nightly Pre-Match Virtual Betting**.
La [guida canonica](nightly-pre-match-2026-10-29.md) sostituisce il requisito
precedente di worker T−15 persistente. Si mantengono Hostless, Turso, GitHub
Actions e i servizi web esistenti. Il blocco dei deployment del vecchio worker
non è più un requisito da risolvere per le nuove puntate virtuali.

## Stato effettivo e confini

Il nuovo percorso nightly e la dashboard sono implementati localmente, con
`RESEARCH_NIGHTLY_ENABLED=false`. Non sono attestati pubblicazione, deploy o
attivazione remota di questo mandato. Il cutover Turso personale non è eseguito.
Il codice verrà preparato su branch `codex/` e PR; nessun push diretto su `main`
prima del piano di passaggio, perché il warmup esistente usa i secret correnti.

La manutenzione notturna esistente e lo storico restano conservati. La route
`/api/automation/place-valid-bets` rimane `410`; il nuovo job non chiama questa
route o `/bets/place`. Non abilitare il percorso legacy con `AUTO_BET_*`.
Le conferme per cutover definitivo e nuove registrazioni remote sono separate
e richieste dal nuovo mandato, dopo preparazione e verifiche del piano concreto.

Ultimo riscontro backend: LIVE `122fd360`; il tentativo `60a6baac`, deployment
`6ae355cd7b2d5d826aa4c4c4`, è fallito con `Deployment waited too long in the queue`.
Le impostazioni sono ora accessibili, auto-deploy OFF, repository
`Ivandragon003/scommeseSportive`, branch `main`, build Docker con contesto e
working directory `backend`. Il vecchio diniego alle impostazioni non è il
blocco attuale; non è dimostrata la causa del timeout di coda.

Il vecchio cron `footpredictor-watchdog` è `PAUSED`, verificato nel pannello.
La richiesta di pausa dello standalone è stata accettata dall'API, ma lo stato
`Sleeping`/`scaledDown=false` non dimostra la pausa completata. Non dichiarare
il servizio arrestato da questo solo riscontro. Non creare altri worker;
nessun servizio, database o storico è stato eliminato.
I [precedenti riscontri Hostless](production-status-2026-10-29.md) e la
[scheda del vecchio blocco](hostless-blocker-2026-10-29.md) restano snapshot
storici, non la nuova procedura operativa.

## Servizi da mantenere

| Componente | Ruolo nel nuovo flusso |
| --- | --- |
| Frontend Hostless Site esistente | React, dashboard e accesso privato |
| Backend Hostless esistente | Express/Node, sessioni, API e consultazione delle previsioni |
| Runner GitHub Actions | Import, calibrazione, job finito A/C e liquidazioni |
| Turso condiviso, poi personale dopo cutover | Unico archivio per tutti i processi |
| Worker T−15 e relativo watchdog | Non richiesti; dismissione controllata senza cancellare storico |

Non occorre un PC o telefono acceso per il flusso previsto. Questo descrive
l'architettura, non un ciclo remoto nuovo già osservato. Un healthcheck 200
non certifica import, quote, decisioni, liquidazioni o corretta contabilità.

Configurazione web già identificata nel progetto esistente: backend Docker,
contesto e directory `backend/`, Dockerfile `Dockerfile`, un'istanza 0,1 vCPU e
256 MiB; frontend `frontend/`, `npm ci`, `npm run build`, output `build`.
Questi sono riscontri dell'app, non una promessa di capacità gratuita residua.
Auto-deploy disabilitato per rilascio controllato. Non aumentare CPU/RAM,
aggiungere carte o cambiare piano per introdurre la nuova nightly.

## Ambiente e collegamenti

Conservare secret funzionanti nei pannelli autorizzati; non copiarli in Git,
frontend, log o chat. Le variabili React sono pubbliche nella build.

| Configurazione | Valore / verifica |
| --- | --- |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Stesso DB per web, nightly, calibrazione, training e manutenzione |
| `NIGHTLY_ORCHESTRATOR` | `github_actions`; gli scheduler interni web non duplicano il job |
| `RESEARCH_NIGHTLY_ENABLED` | `false` fino alla conferma di attivazione remota |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false`, mai concorrente con la nightly |
| `ODDS_API_KEY` | Solo backend/runner, provider reale autorizzato |
| `ODDS_API_MONTHLY_CREDITS`, `ODDS_API_RESERVE_CREDITS` | 500 e 50, pianificazione interna distinta dal residuo provider |
| `ODDS_INFORMATIONAL_NETWORK_ENABLED`, `RUN_ODDS_SYNC` | `false`, letture informative su cache |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | 300 alla decisione notturna, non al kickoff |
| `RESEARCH_NIGHTLY_MIN_EV`, `RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV` | 0,04 e 0,01, soglie sperimentali configurabili |
| Sessioni, origini CORS e HTTPS | Conservare protezioni e verificare browser/Android sul backend corretto |

Il workflow legge la variabile repository `RESEARCH_NIGHTLY_ENABLED`, con
default `false`; non è stata impostata una nuova variabile remota. Il flag
Hostless serve alla dichiarazione di stato della dashboard: il web non avvia
la nightly nemmeno quando dichiara la configurazione abilitata.

Il job A/C usa il feed essenziale anche con raccolta informativa generale
spenta. Lo Smart Odds Manager condivide snapshot e costo fra i modelli;
quote scadute, mancanti o oltre budget causano astensione. Le stime di domanda
nightly non garantiscono copertura delle cinque leghe. La
[gestione quote](smart-odds-2026-10-27.md) distingue consumo e proiezioni.

## Database personale e backup

Backup sorgente aggiornato: dump privato 459.806.723 byte, 52 tabelle,
integrità `ok`, zero violazioni FK; SHA-256 completo nel manifest privato
(inizio `9b2018ac`, finale `a7b5a`). Il dump precedente resta uno snapshot
storico e non sostituisce la sincronizzazione finale prima del passaggio.

Nell'account personale autenticato è stato osservato Starter Free: 0 USD,
capacità 5 GB, 500 milioni di letture e 10 milioni di scritture mensili, senza
carta aggiunta. Sono limiti osservati nell'account, non consumi trasferiti dal
vecchio DB o una garanzia sul consumo futuro. La CLI ufficiale è ora
autorizzata e operativa; Starter Free e overage disabilitati sono verificati
anche tramite CLI. La copia iniziale nel target
`footpredictor-selloneciompi.aws-eu-west-1.turso.io` (SQLite, gruppo default
Ireland) è importata e confrontata integralmente alle 16:49:31 UTC del
29 ottobre: 53 tabelle ispezionate, 52 applicative più `sqlite_sequence`,
schema/conteggi/hash coincidenti, integrità `ok`, FK0. Il confronto riguarda
la sorgente delle 15:18:10 UTC e l'export target delle 16:46:36 UTC:
`liveParityVerified=false`, nessun cambio dei secret di produzione o cutover.
Restano sincronizzazione finale, approvazione e deployment Hostless riuscito.

Seguire la [procedura di migrazione](turso-personal-migration-2026-10-29.md):
la copia iniziale e la sua parità sono verificate; prima del passaggio
servono sospensione controllata dei writer, sincronizzazione finale e nuova
verifica di integrità/parità sullo snapshot definitivo. Prima del
cutover presentare all'utente tutti i reader/writer e il rollback. Se Hostless
non può applicare la nuova configurazione, non collegare soltanto Actions al
nuovo DB creando due archivi divergenti. Il database originale resta intatto.
Le migrazioni additive 020 (nightly) e 021 (evidenza prospettica) vanno
verificate su copia e applicate sul DB di riferimento nella sequenza
concordata. Non sono state applicate ai database remoti.

## Rilascio e collaudo

1. Completare gate locali e scansione dei secret; preparare branch `codex/` e
   PR con configurazione e documenti coerenti. Il consenso al cutover non è
   implicito nella preparazione della PR.
2. Verificare che vecchio T−15 e vecchio percorso automatico non possano creare
   puntate. Conservare dati, versioni ML e due wallet esistenti senza reset.
3. Ripetere parità dopo la sincronizzazione finale e completare il piano di
   passaggio univoco del database; ottenere
   conferma esplicita prima del cutover definitivo, senza cambio parziale.
4. Distribuire backend e frontend con registrazioni ancora spente. Allineare
   warmup e deploy sullo stesso hash `dist`; controllare login, sessione,
   API, dashboard, legacy 410 e collegamento del client Android.
5. Verificare sul remoto quote reali, cache, budget, idempotenza, riavvio del
   job, liquidazioni e ledger; fixture soltanto in ambienti isolati.
6. Presentare l'esito e ottenere conferma separata prima di abilitare le nuove
   registrazioni nightly. Osservare un ciclo con partita reale e risultato
   ufficiale, accettando un'astensione se le condizioni non sono idonee.

Il confronto economico usa due portafogli da 1.000 euro iniziali, stake 1%,
esposizione 5%, una puntata per partita/modello. `EXPERIMENTAL` può essere
ammesso con idoneità tecnica, senza promozione statistica. C resta Challenger.
Non sono equivalenti risultati sintetici, backtest con quote storiche e puntate
notturne realmente osservate; la dashboard conserva questa distinzione.

L'[audit runtime](nightly-model-runtime-2026-10-29.md) verifica l'inferenza Linux
e il nuovo assemblatore prospettico. Il registro iniziale non ha campioni
prudenziali idonei: l'avvio ammette soltanto astensioni, senza puntate o nuovi
movimenti del ledger.
La migrazione 021 conserva osservazioni prepartita e payout append-only al
clock reale del risultato, con 80/20 nominale per hash e futuro test escluso.
Minimo 50 per mercato/fascia e Hoeffding restano invariati, senza training,
calibrazioni inventate o promozioni. L'abilitazione remota non garantisce
puntate e non autorizza a ridurre questi gate per mostrarne una.

## Monitoraggio e CPU

Il monitor GitHub controlla ultima nightly, esito, partite analizzate/saltate,
API, crediti e liquidazioni. I controlli del workflow sono indipendenti dal
vecchio worker; quelli DB richiedono credenziale dedicata di sola lettura.
Nessun falso allarme per heartbeat intenzionalmente dismesso. Riepilogo in-app
dalle 09:00 Europe/Rome, nessuna notifica per ogni puntata. Non è attestato un
nuovo canale esterno gratuito o l'invio di notifiche del nuovo flusso.

L'[audit locale Turso/CPU](turso-cpu-audit-2026-10-29.md) misura payload ridotto
e scritture identiche evitate. Non certifica minori righe fatturate, CPU web
risolta o causa dei precedenti avvisi Hostless. Non confondere throttling e
attesa in coda di deploy. Nessun aumento automatico delle risorse.

## Rollback

Disabilitare `RESEARCH_NIGHTLY_ENABLED` per fermare nuove registrazioni,
conservando import e liquidazioni delle giocate esistenti. Non riattivare
`AUTO_BET_*` o ripristinare la chiamata legacy nel vecchio workflow. Conservare
ledger, quote, versioni, artifact e giocate aperte.

Per il codice usare una release precedente compatibile con le migrazioni
additive. Per il DB serve un passaggio coordinato di tutti i processi e la
riconciliazione delle scritture successive, con l'autorizzazione prevista:
non sovrascrivere la produzione con un backup più vecchio. Nessuna cancellazione
di servizi, database o storico è parte del rollback ordinario.
