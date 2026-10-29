# Nightly Pre-Match Virtual Betting: stato e pubblicazione

Il mandato del 29 ottobre 2026 sostituisce il requisito T−15. Il confronto
prospettico consiste in due portafogli virtuali A/C, elaborati dalla nightly
GitHub Actions. Non richiede un worker sempre acceso o una modalità Shadow
parallela. Non effettua scommesse con denaro reale.

**Stato: cutover al Turso personale completato; backend e dashboard verificati,
Nightly A/C abilitata e run manuale `40944747548` SUCCESS alle 20:04:35 UTC.**
La baseline canonica autorizzata è il dump delle 16:17 Roma; gli aggiornamenti
successivi della sorgente bloccata non sono attestati. Questo documento sostituisce le precedenti istruzioni di attivazione
T−15; i report scientifici e gli snapshot operativi datati restano storici.

Il 30 ottobre alle 00:43 Roma è stata applicata sul Turso personale la
sola migrazione additiva 022: indice per la pulizia dei batch lineup.
Il piano remoto usa l'indice; dati e hash finanziari sono invariati.
La [verifica delle letture](turso-cpu-audit-2026-10-29.md#letture-turso-indice-del-batch-lineup-verifica-del-30-ottobre)
documenta 112,23M / 500M letture prima del fix e distingue il beneficio
dimostrato dal consumo mensile ordinario ancora da misurare.

## A. Nightly e quote

Il [workflow esistente](../../.github/workflows/nightly-sync.yml) mantiene
import Understat, supplemento football-data.co.uk, normalizzazione,
calibrazione, manutenzione e liquidazioni. Il [runner](../../scripts/ci/nightly-sync.sh)
esegue il comando finito `node scripts/research-nightly.js` soltanto dopo
i controlli dati; non chiama la vecchia registrazione HTTP.

- Programmazione: `0 1 * * *` e `0 2 * * *` UTC, con gate del trigger attivo
  per le 03:00 Europe/Rome e gestione dell'ora legale. GitHub può ritardare il job.
- Finestra ordinaria: dall'effettivo avvio delle decisioni alla successiva
  soglia delle 03:00 Roma. Durata personalizzabile fra una e 48 ore.
- Il retry conserva identità, inizio, fine e policy del run originale; la CLI
  usa `GITHUB_RUN_ID` quando disponibile. Non sposta la finestra dopo un errore.
- Kickoff iniziati, rinvii, risultati già disponibili e dati temporalmente
  inammissibili non possono generare nuove puntate. Le assenze reali sono
  conteggiate senza ricostruire puntate retroattive; decisioni già completate
  e skip intenzionali non diventano falsi "missed" al retry.
- Un solo snapshot autentico per A/C, con bookmaker, fonte, acquisizione,
  aggiornamento e distanza dal kickoff. Freschezza rispetto alla decisione
  notturna; default 300 secondi, non un controllo a T−15.
- Mercati richiesti insieme: `h2h,spreads,totals`, regione `eu`. Quote assenti,
  vecchie, sintetiche o prive di provenienza sono escluse. Eurobet non viene
  simulato quando il provider restituisce altri operatori.

La nuova [proiezione](../../backend/src/services/odds-provider/OddsDemandSimulation.ts)
raggruppa una richiesta per lega/finestra, senza raddoppiare i crediti per A/C,
e salta leghe senza incontri. Nel controfattuale di cinque leghe tutti i giorni
di un mese di 31 giorni servono 465 crediti senza retry, 513 con allowance del
10% arrotondata. Sono stime, non consumo o copertura misurati.
Il manager mantiene limite 500, riserva ordinaria 50, cache, deduplicazione,
prenotazione atomica e contabilità comune. Le decisioni essenziali possono usare
la riserva; le richieste informative no. Il limite totale non aumenta e le
opportunità eccedenti vengono saltate. La quota disponibile effettiva prevale
sulle proiezioni. Le stime T−15 precedenti restano confronti storici distinti.

Ultima osservazione disponibile nel dump: The Odds API, scope `primary`,
29 ottobre alle **14:02:50.247 UTC / 15:02:50.247 Roma**, 295 crediti usati,
205 residui, costo ultimo 3. Non è una quota live attuale né una verifica del
contratto commerciale: 500 resta il budget configurato. Le cinque acquisizioni
QA Top 5 richiedevano `h2h/spreads/totals`, regione `eu`, e costavano 15 crediti
complessivi. Restituivano 25 bookmaker, fra cui Codere (IT), Pinnacle, Betfair,
Unibet e Winamax; Eurobet non compariva. Erano osservazioni pre-match di collaudo,
non esecuzioni nightly o T−15. Alcune schede La Liga/Bundesliga superavano già
cinque minuti all'acquisizione: devono essere escluse. Il timestamp HTTP non
garantisce la freschezza di ogni singola quota. Nessuna nuova chiamata al
provider è stata necessaria durante questo mandato.

### Configurazione prima dell'attivazione

| Variabile | Default preparato | Significato |
| --- | --- | --- |
| `RESEARCH_NIGHTLY_ENABLED` | `false` | Opt-in esplicito del nuovo percorso |
| `RESEARCH_NIGHTLY_HOUR` / `MINUTE` | `3` / `0` | Soglia locale Europe/Rome |
| `RESEARCH_NIGHTLY_WINDOW_HOURS` | vuoto | Successiva soglia; opzionale 1–48 ore |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | `300` | Età massima alla decisione |
| `RESEARCH_NIGHTLY_MIN_EV` | `0.04` | EV centrale minimo configurabile |
| `RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV` | `0.01` | EV prudenziale minimo configurabile |
| `RESEARCH_NIGHTLY_TIMEOUT_SECONDS` | `1200` | Limite del passo shell |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false` | Percorso operativo ritirato |

Il workflow legge la variabile repository `RESEARCH_NIGHTLY_ENABLED`, con
fallback `false`. Sul repository il flag è ora `true`; il primo run controllato
è `40944747548`, creato alle 19:57:46 UTC sulla revisione `4dff28f4`,
SUCCESS con job concluso alle 20:04:35 UTC. Dopo audit RO PASS sono attive
anche le attese programmate delle 03:00, con opt-in separato dal flag delle
puntate. `RESEARCH_NIGHTLY_MONITOR_ENABLED=true` e
`RESEARCH_NIGHTLY_DB_MONITOR_ENABLED=true` sono confermati. Contabilità, quota,
errori e stalli recenti oltre quattro ore sono controllati indipendentemente
dall'aspettativa programmata. Il watchdog con attese attive `40946558140`
è SUCCESS nei controlli GitHub e DB RO.
Il flag del backend dichiara lo stato atteso per la dashboard: il processo web
non avvia la nightly, neppure quando la configurazione viene dichiarata attiva.
La vecchia `/api/automation/place-valid-bets` resta `410`. `/api/bets/place`
appartiene alle operazioni manuali legacy e non viene usata dalla nuova A/C.

## B. Worker e monitoraggio

Backend Hostless attuale: `63d7cb96` LIVE, deployment
`6ae39db2025871fe6d073d62`, collegato al Turso personale. Frontend `afda73be`
LIVE, deployment `6ae388d4880feac1b600f02b`. Le impostazioni verificate sono: repository
`Ivandragon003/scommeseSportive`, branch `main`, Docker con directory e contesto
`/backend`, auto-deploy disattivato. Health HTTP 200, sessione autenticata,
portafogli A/C e confronto a 30 giorni verificati nella produzione aggiornata;
POST della vecchia registrazione automatica HTTP 410.
La schermata Scaling assegna attualmente **0,1 vCPU, 256 MB e una istanza**,
con massimo una istanza. Non sono state cambiate queste risorse. Il test locale
a 0,25 CPU non rappresenta l'allocazione effettiva Hostless.

- Rimosso il servizio Compose `research-worker`. Restano backend e frontend.
- La CLI `research-worker.js` ora termina indicando `worker_retired`, senza
  DB, modelli, heartbeat o polling, anche con un vecchio flag ambiente `true`.
  L'harness esplicito resta per le fixture storiche isolate; non è un servizio.
- Hostless `footpredictor-watchdog`: pausa confermata nel pannello.
- Worker standalone: richiesta di pausa accettata con HTTP `201`/`success`,
  ma la lettura successiva mostra ancora `Sleeping`, `scaledDown=false`.
  Non si dichiara una pausa persistita o capacità liberata. Non è operativo,
  auto-deploy è disattivato e il comando configurato non abilita puntate.
- Worker embedded precedente preservato: il pannello riporta `Not deployed`
  con etichetta di stato `Deploying`; l'editor fallisce perché il suo endpoint
  delle variabili restituisce 404. Non è una prova di processo operativo.
  Nessun servizio o database eliminato, nessun ulteriore deployment worker richiesto.

La pausa controllata ha bloccato le scritture note. Hostless rifiuta il cambio
ambiente mentre l'app è in pausa (`Resource is paused`); Resume richiede
`Project billing permission`, assente al ruolo Editor. Il proprietario ha
riattivato il servizio; solo dopo è stato salvato e distribuito il nuovo
collegamento. CPU/RAM e piano non sono stati modificati dall'agente.

Il [watchdog GitHub](../../.github/workflows/research-watchdog.yml) sostituisce
il controllo heartbeat con esito/assenza della nightly, tramite API GitHub
e permesso `actions: read`. Gli allarmi sono opt-in. L'ispezione del DB è
opzionale e richiede `TURSO_WATCHDOG_READONLY_TOKEN`: nessun fallback al token RW.
Controlla run, partite, registrazioni, skip, quota, liquidazioni e contabilità.
Il riepilogo della giornata precedente è preparato dalla nightly con timestamp
reale e `publishAfter` alle 09:00 Roma, visibile da quell'ora anche attraverso
i GET. Il manuale serale ha creato `daily:2026-10-28` alle 20:04:28.689 UTC,
con `publishAfter` già trascorso (29 ottobre, 09:00 Roma): è visibile nell'app.
Non è una consegna email o push. Un flag spento non produce un nuovo
riepilogo. Il monitor `4dff28f4` è pubblicato: CI `40944506327` SUCCESS,
dieci test mirati e revisione DST superati. Il nuovo smoke GitHub e DB RO
`40945351072` è riuscito. Dopo l'audit finanziario RO PASS sono stati abilitati
anche gli allarmi delle 03:00: monitor GitHub, controllo DB periodico e attese
programmate sono ora attivi. Il watchdog `40946558140` con `expect_enabled=true`
è SUCCESS, tutti i passi GitHub e DB RO completati in 26 secondi, job
`123703354298`. Rilevazione degli stalli recenti oltre quattro ore, contabilità,
quota ed errori restano indipendenti dall'aspettativa programmata. La consegna
di un allarme per un guasto reale e il canale esterno non sono dimostrati.

## C. Database personale e cutover

Il database operativo è ora **footpredictor**, SQLite nell'account personale
**selloneciompi**, gruppo default, regione AWS Ireland. Host:
`footpredictor-selloneciompi.aws-eu-west-1.turso.io`.
Backend Hostless, GitHub Actions e configurazione operatore locale puntano a
questa destinazione. Credenziali distinte e limitate al solo database:
backend RW, manutenzione GitHub RW, monitor/probe RO; scadenza 5 marzo 2030.
Valori custoditi nei secret store e nei file privati protetti, mai in Git.

La sorgente precedente
`scomessesportive-ivandragon003.aws-eu-west-1.turso.io` ha restituito
`BLOCKED` anche a SELECT 1 e HTTP 403 all'export ufficiale. Il motivo
quota/fatturazione non è stato confermato. Dopo aver ricevuto questa evidenza
e la spiegazione del punto di ripristino, l'utente ha autorizzato l'adozione
della copia esistente come nuova fonte canonica: snapshot acquisito il
29 ottobre **15:17–15:18 UTC / 16:17–16:18 Europe/Rome**. Non si dichiara
parità con eventuali modifiche successive della sorgente bloccata.

La copia iniziale comprendeva 52 tabelle applicative, 125 oggetti schema e
314.089 righe; confronto integrale con il dump sorgente, integrità e FK PASS.
Il dump SQL di 459.806.723 byte ha SHA-256
`9b2018ac753ac518bd263908024bddb31efcd317edf41ae7c95c1ca9a86a7b5a`.
Backups e credenziali rimangono privatamente sotto
`backend/artifacts/backups/personal-migration-20261029/`, ignorato da Git.

La copia personale è stata adottata **senza eliminarla o ricrearla**:

- Migrazioni additive 020/021 applicate con il runner reale: registro 20→22,
  cinque tabelle nuove vuote, tre indici; totale 57 tabelle / 133 oggetti.
- Export nativo finale completato alle 18:58:45 UTC e ripristino verificato.
  Confronto integrale PASS alle 19:00:59 UTC: dati e 125 oggetti originari
  invariati, salvo le sole due append previste al registro migrazioni.
- Integrità ok, zero violazioni FK; archivi e restore preservati. Il vecchio
  controller di cancellazione della copia inutilizzata è ritirato: non va
  riutilizzato sul database ora canonico.
- Baseline RO delle 19:29 UTC: A/C 1.000 EUR ciascuno e zero impegnati;
  ledger, budget e sessioni budget identici al backup accettato. Conservate
  258 giocate legacy, 197.314 previsioni, 8.834 partite e 10.915 snapshot quote.
- Preparazione cache GitHub 40937894463 riuscita sul nuovo database; le
  modifiche alle cache sono manutenzione consentita, non reset degli storici.
- GitHub URL/RW/RO aggiornati alle 19:03 UTC. Hostless ha poi salvato e
  distribuito URL/token con protezione write-only, lasciando le altre
  credenziali e le risorse esistenti; login e dashboard reali verificati.

Il piano personale è Starter/free e gli overages risultano disabilitati.
Lettura ufficiale delle 19:33:57 UTC: storage 526 MB/5 GB, letture 0,1M/500M,
scritture meno di 0,1M/10M, sync 1,6 GB/3 GB (52%), un database su 100.
Il terzo export è ora incluso nei contatori; nessun altro export è
stato avviato senza necessità. La procedura e i riferimenti alle prove sono
nella [guida Turso](turso-personal-migration-2026-10-29.md).

### Rollback e dismissione della sorgente

Per fermare nuove decisioni spegnere il flag Nightly, conservando le giocate
e le liquidazioni. Un rollback del codice mantiene il database personale e
non deve riattivare la route automatica legacy. Non ripristinare sopra i nuovi
dati il dump delle 16:17; prima occorre riconciliare ogni scrittura successiva.

L'utente ha autorizzato la dismissione del vecchio database, che non è più una
fonte operativa. **Non è stato eliminato**: l'accesso management disponibile
riguarda il solo account personale. L'eventuale eliminazione deve essere
eseguita dal proprietario della sorgente dopo conferma del nuovo collegamento;
non va simulata cancellando tabelle tramite il vecchio token SQL.

## D. Ottimizzazioni e CPU

Il [report ripetibile](turso-cpu-audit-2026-10-29.md) usa il dump locale:

| Misura | Prima | Dopo |
| --- | --- | --- |
| JSON delle quote storiche | 21,00 MB | 7,10 MB |
| Selezione/parsing Node, mediana | 126,17 ms | 45,90 ms |
| CPU della stessa elaborazione | 141 ms | 62 ms |
| UPDATE su replay di 8.834 partite identiche | 8.834 | 0 |

Le 4.061 righe quote e i 297 risultati finali sono equivalenti. Non sono state
ridotte le righe percorse o il numero delle query quote; nessun risparmio di
letture fatturate Turso è dichiarato. La guardia no-op preserva COALESCE, zeri,
batch e contenuti: mediana upsert 153,61→156,70 ms, senza beneficio CPU attestato.
Nessun nuovo indice o modifica matematica.

Il benchmark cache esistente misura 4.944 ms/45 fit a freddo contro 9 ms/zero
fit con cache persistente e nuovo servizio. Questo identifica un carico da
controllare, non la causa dimostrata degli alert Hostless. Il fingerprint usa
l'intero `dist`: warmup e release devono coincidere. Non sono aumentate CPU/RAM
e il throttling remoto non viene dichiarato risolto senza misure prima/dopo.

La panoramica ora legge soli metadati SQL: valori trasferiti dal database
9.103.745→5.483 byte sul backup verificato, senza cambiare il DTO. Gli
artefatti/report completi della Nightly vengono riusati per coorte; mercati,
lease e ammissione restano controllati a ogni decisione. Una misura browser
dopo il rilascio I/O ha osservato overview 2.826 ms e confronto 315 ms; non è
un benchmark statistico confrontabile direttamente con i vecchi log server,
né una prova che tutti gli alert CPU siano risolti.

## E. Modelli, portafogli e confronto

Lo snapshot aggiornato conserva A `A-80cb25df5552621e` e
C `C-906371b0b3a1e2c8`, 258 giocate legacy e zero nuove giocate research.
Il ledger ricostruisce `shadow_A` e `shadow_C` a 100.000 centesimi disponibili
ciascuno, zero impegnato. Gli ID rimangono per compatibilità: non sono una
modalità parallela, non sono capitali da sommare e non vengono resettati.

L'[inferenza Linux sull'artefatto C reale](nightly-model-runtime-2026-10-29.md)
coincide con CatBoost nativo su 6.146 confronti, errore massimo `5,55e-17`.
Il runtime usa il JSON in Node, senza Python: nel container locale a
0,25 CPU / 256 MiB, RSS massimo 80,62 MiB e inferenza p95 0,316 ms. Questa prova
non certifica la nuova release su Hostless o il consumo del backend completo.

Il registro iniziale non contiene residui indipendenti ammissibili: A/C devono
astenersi finché l'evidenza è insufficiente. La migrazione additiva 021 e
l'assemblatore prospettico conservano quote, probabilità, EV e configurazione
anche per ABSTAIN, prima del kickoff. La partizione per partita è fissata prima
dell'esito: 80/20 nominale CALIBRATION/FUTURE_TEST, con la seconda esclusa dai
residui. Solo dopo un risultato ufficiale si aggiunge il payout osservato, con
timestamp effettivo, senza giocate o movimenti dei portafogli. Le correzioni
ufficiali producono quarantene datate e preservano le letture storiche `asOf`.
Il lookup richiede la stessa versione/configurazione; non riutilizza il test
finale storico o i dati già usati per adattare il calibratore. Soglia minima
50 e limite Hoeffding invariati: 50 osservazioni non garantiscono una puntata.

Stake 1%, esposizione 5%, massimo una puntata per partita/modello. L'ordinamento
prudenziale è deterministico quando le opportunità superano il capitale
allocabile. Commit atomico, lease e vincoli persistenti proteggono i retry.
Settlement conserva handicap, mezzi esiti e rimborsi; nessun saldo negativo.

EXPERIMENTAL descrive la validazione statistica e non blocca da solo una
simulazione tecnicamente valida. Restano obbligatori probabilità coerenti,
quote autentiche, selezione/linea/settlement supportati, timestamp e capitale.
Non sono promossi mercati o modello C, che resta Challenger. Backtest storici,
qualità probabilistica e rendimento virtuale prospettico rimangono distinti.

La dashboard usa aggregati completi del periodo da `/api/research/comparison`:
7/30/60/90 giorni, intera simulazione o date personalizzate. Mostra patrimonio,
profitto, ROI, stake, esiti, drawdown, curve, differenze e dettaglio quote.
Le liste di dettaglio hanno limiti espliciti; il totale non dipende dalla loro
paginazione. Il leader economico del periodo non è una prova di superiorità
statistica.

## F. Gate di verifica

- Backend Linux Node 20, rete disabilitata, incluse le ottimizzazioni I/O: **886 test, 885 passati, un opzionale
  CatBoost saltato, zero fallimenti o cancellazioni**, nell'immagine ricostruita.
- Il controllo completo ha verificato anche il runner reale delle migrazioni:
  corretta l'incompatibilità di un commento SQL della 021 con il suo parser.
  Corretto inoltre il rinnovo lease che poteva terminare prematuramente il job;
  i test interessati non sono stati saltati o indeboliti.
- Revisione indipendente: corretti anche falsi missed al retry e finestra custom
  mobile. Quindici test nightly e 17 store verificano i casi, inclusa concorrenza.
- Frontend: **189/189**, 29 suite; lint, typecheck e build superati, incluso il
  contratto reale della proiezione quote nightly.
- Python: **13/13**. Backend lint e typecheck completi superati.
- Migrazione offline: **13/13**, con int64/REAL/BLOB/Unicode, duplicati e una
  fixture da 140.003 righe; formati GET/dump e snapshot nativo CLI verificati.
  La parità integrale della copia iniziale è attestata separatamente sopra.
- Migrazioni 020/021 sul dump reale: runner `DatabaseService` dell'immagine
  finale, due processi senza rete. Tutti i dati e i 125 oggetti preesistenti
  preservati, salvo le due append previste nel registro migrazioni (20→22).
  Cinque nuove tabelle vuote e tre indici; integrità `ok`, FK 0, secondo avvio
  idempotente. La stessa procedura è stata poi applicata al target personale;
  export nativo, restore e confronto integrale hanno verificato lo stesso
  risultato, senza distruggere o ricreare il database.
- Proiezione quote: **21/21** compresi test storici invariati. Nuovo controllo
  di configurazione workflow e shell: **4/4** dopo il collegamento del flag repo.
- Il precedente limite nativo Windows durante test paralleli resta distinto:
  non è stato nascosto né dichiarato risolto dal gate Linux.
- Compose isolato: immagini backend/frontend costruite dai Dockerfile,
  database locale senza credenziali reali, health HTTP 200 e API confronto
  raggiungibili. Browser: portafogli distinti da 1.000 EUR, filtri periodo e
  date personalizzate, automazione disabilitata, quota provider sconosciuta e
  zero gruppi nightly visualizzato correttamente. Nessuna fixture in produzione.
- Avvio Compose e inferenza sull'artefatto C reale riconfermati nell'immagine
  finale dopo l'integrazione della coorte; health HTTP 200.
- Nessun nuovo APK o collaudo su dispositivo Android eseguito in questa fase.
- Revisione indipendente della nuova coorte: 34/34 test e nessun P1/P2 residuo.
  Il gate completo finale è passato; riferimenti della CI remota nella sezione G.
- Ottimizzazioni I/O: revisione indipendente 49/49; probe RO: 7/7 test
  Windows/Linux, ulteriore revisione indipendente 7/7. Patch pubblicate senza
  credenziali rilevate da Gitleaks.
- GitHub `40936914212`: inferenza JSON Node C reale dal target personale,
  versione `C-906371b0b3a1e2c8`, 100 misure dopo warmup, p95 0,532 ms,
  RSS massimo 156,98 MiB sul runner GitHub. Input sintetici solo in RAM,
  una SELECT, zero scritture/provider; probabilità finite e masse normalizzate.
  Non è una prova di qualità predittiva, di inferenza Python su Hostless o di
  un ciclo completo con partita reale.

## G. Pubblicazione e verifiche remote

[PR #1](https://github.com/Ivandragon003/scommeseSportive/pull/1) unita in
`afda73be`. Revisione backend distribuita `63d7cb96`: include il fix I/O `2834ed0c` e il
probe manuale RO. Il monitor aggiornato è pubblicato in `4dff28f4`, revisione
usata anche dal run nightly concluso con successo; non è una nuova release del backend
Hostless o un cambiamento del modello.

- [CI 40935996423](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40935996423): Backend e Frontend riusciti su 63d7cb96.
- [Probe C 40936914212](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40936914212): artefatto reale del target, inferenza sintetica Node, successo.
- [Warmup 40937894463](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40937894463): successo sul target personale.
- [Watchdog RO 40940231368](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40940231368): successo, contabilità stabile, aspettative di mancata Nightly disabilitate durante il ripristino.
- [CI monitor 40944506327](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40944506327): SUCCESS sulla revisione `4dff28f4`.
- [Nuovo watchdog RO 40945351072](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40945351072): SUCCESS sul codice monitor aggiornato; contabilità e quota controllate senza dipendere dall'aspettativa delle 03:00.
- [Watchdog con attese attive 40946558140](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40946558140): SUCCESS, controlli GitHub e DB RO completati in 26 secondi.
- [Nightly 40944747548](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40944747548): SUCCESS, creata alle 19:57:46 UTC su `4dff28f4`; job `123697063762` concluso alle 20:04:35 UTC. È stata l'unica esecuzione operativa nel gruppo `nightly-sync`.

Il riepilogo A/C privato riporta avvio alle 20:04:20.587 UTC, fine alle
20:04:28.263 UTC e finestra fino al 30 ottobre alle 02:00 UTC / 03:00 Roma:

| Campo del riepilogo | Valore osservato |
| --- | --- |
| `analyzedMatches` / `registeredBets` / `skippedMatches` | 0 / 0 / 0 |
| `missedMatches` | 2 partite distinte già iniziate, correttamente escluse (audit RO 20:10:52 UTC) |
| `errors` / `apiErrors` | 0 / 0 |
| Settlement: `checked` / `settled` / `unresolved` | 0 / 0 / 0 |
| `quota` | `null`: nessuna nuova osservazione quota dichiarata |
| Motivo `missed_nightly_interval` | 1 |
| Evidenza prospettica: `checked` / `settled` / `unresolved` / `frozen` | 0 / 0 / 0 / 0 |

L'audit RO speciale delle 20:10:52 UTC identifica le due partite:
`understat_31643`, Frosinone–Lecce, kickoff 17:30 UTC, e `understat_31642`,
Fiorentina–Atalanta, kickoff 19:45 UTC. L'intervallo segnalato è dalle 02:00 UTC
alle 20:04:20 UTC; entrambe erano già iniziate. Per queste due partite non sono stati creati job né
decisioni di modello. `reasonCounts.missed_nightly_interval=1` conta una
segnalazione di intervallo, non una partita.

Nessun evento era eleggibile nella finestra restante e non sono state create
puntate retroattive. Il successo del job non prova un ciclo completo con
quote, decisione, risultato e liquidazione. Log e artifact sono conservati
privatamente; la loro scansione Gitleaks ha restituito zero segnalazioni.

Il precedente dispatch `40940944902`, delle 19:32 UTC, resta un evento orfano
con stato metadata `queued`, zero job e fuori dal gruppo di concorrenza,
anche dopo il successo del nuovo run. Le richieste
di annullamento normale/forzato hanno risposto HTTP 409 (non ancora in coda);
la UI mostra annullamento fallito. Una sola ripetizione dello stesso workflow
e dello stesso gruppo ha avviato `40944747548`: il vecchio evento non viene
presentato come il job operativo o come un run concluso.

Audit RO reale delle 20:07 UTC PASS: quattro fingerprint finanziari invariati,
A/C 100.000 centesimi ciascuno, zero impegnati e zero puntate. Sono preservati
258 record legacy, 197.314 previsioni, 8.834 partite e 10.915 snapshot quote.
Sono osservate anche 41 previsioni preesistenti liquidate (32 LOSS, 9 WIN): non
sono nuove giocate A/C né nuove puntate legacy. Il confronto dei 41 ID con il
backup locale ha verificato soltanto transizioni da pending a esito finale,
senza movimenti di bankroll. I 258 record di
puntata legacy mantengono i fingerprint finanziari invariati.
Il run persistito è `COMPLETED`. La dashboard autenticata mostra Nightly
riuscita alle 21:04 Roma e prossima esecuzione il 30 ottobre alle 03:00 Roma.

Nightly Sync è riabilitata, variabile `RESEARCH_NIGHTLY_ENABLED=true`.
Training settimanale e diagnostica quote manuale riabilitati; pubblicazione
nel registro modelli ancora disabilitata. Monitor GitHub, controllo DB
periodico RO e attese delle 03:00 sono attivi. Il watchdog `40946558140`
è SUCCESS con aspettativa abilitata: tutti i passi GitHub e DB RO completati.
Nessun servizio a pagamento, carta o aumento CPU/RAM è stato attivato.
La fatturazione completa Hostless non è accessibile al ruolo Editor.

L'infrastruttura ora può eseguire il flusso senza PC o smartphone accesi;
la prima nightly è riuscita senza eventi eleggibili. Un ciclo prospettico
con quote, decisione, risultato ufficiale, liquidazione e aggiornamento
portafogli resta da osservare. Nessuna puntata
è forzata per superare il collaudo. Nessuna consegna esterna email/push e nessun
test su dispositivo Android sono attestati.
