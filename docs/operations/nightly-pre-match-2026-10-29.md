# Nightly Pre-Match Virtual Betting: stato e pubblicazione

**Portafogli nelle pagine normali dell’app — integrazione locale in verifica.**
Il nuovo requisito porta A/C in **Giocate, Budget e Archivio**, con filtro per
modello e confronto. Sono gli stessi portafogli e le stesse cinque BET già
finanziate: nessuna copia, migrazione, nuova puntata o addebito. La lettura
`GET /api/wallets` riusa il confronto contabile esistente; aggregati completi
e dettaglio limitato a 500 righe sono distinti. Lo storico precedente di 258
giocate resta consultabile separatamente, senza attribuirlo ad A o sommarne
il capitale. Research rimane dedicato a benchmark e modelli, non alla gestione
dei saldi. Questa integrazione non è ancora attestata LIVE: lo snapshot
cloud qui sotto riguarda la UI precedente e la policy già attiva. Nightly,
modelli e infrastruttura non cambiano.

**Snapshot cloud prima dell’integrazione nelle pagine normali, 30 ottobre 2026.** Backend `eb5d838e`
LIVE, deployment `6ae4984bb53426f1e55ec75c`; frontend `3c503fa9` LIVE,
deployment `6ae49cd1e2d5898dc9ef7bb2`. Variabile GitHub `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` verificata.
Run reale `41069572500` SUCCESS: cinque partite, dieci decisioni e cinque
puntate virtuali, tre A e due C. Audit RO 71/71 PASS. A disponibile 955,80 euro,
impegnato 44,20; C disponibile 980 euro, impegnato 20; equity 1.000 euro ciascuno.
Stake A 0,42%/1,8%/2,2%, C 1%, esposizione massima 5% rispettata, senza promozione C.

Quote reali Codere IT/Betsson, fresche 51,6–79,3 secondi alla decisione. Provider
325 usati/175 residui osservati alle 14:16:55 UTC. Il suo stato DEGRADED include
l’unico errore mensile precedente nel ledger; ultima acquisizione SUCCESS
14:16:54 UTC. Lo stato non viene ripulito o dichiarato tutto verde.
Watchdog automatico `41070547360` SUCCESS (GitHub/DB `ok=true`, `issues=[]`,
Nightly SUCCESS/non scaduta). Duplicato `41071349342` SUCCESS con gate
`daily_sync_already_succeeded` e ciclo applicativo/provider saltato.
Controllo RO dopo il duplicato: invariati 5 BET, 7 movimenti, 5 job, 10 decisioni,
saldi e 325/175 crediti.
Pagina Partite autenticata verificata: Le Havre–PSG, A quota 8 Codere IT,
importo archiviato 4,20 euro, uguale alla Nightly. Risultati/liquidazioni e
primo trigger programmato restano da osservare; il ciclo sportivo non è completo.
APK Android non aggiornato, keystore originale assente; nessun piano/provider
cambiato, servizio a pagamento aggiunto o T−15 operativo.
Rollback delle nuove puntate: `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=false`,
workflow completo attivo e backend compatibile con la 023. Il POST `/api/research/settle`
precede il gate A/C; sola CLI diagnostica o retry saltato non garantiscono
liquidazioni. Non fermare il processo completo confidando in quei soli percorsi.
[Specifica e avanzamento](recommendation-execution-2026-10-30.md)


Il mandato del 29 ottobre 2026 sostituisce il requisito T−15. Il confronto
prospettico consiste in due portafogli virtuali A/C, elaborati dalla nightly
GitHub Actions. Non richiede un worker sempre acceso o una modalità Shadow
parallela. Non effettua scommesse con denaro reale.

**Snapshot del primo recupero 30 ottobre 10:12 UTC, prima della nuova policy.**
Backend `013209419ef25b949525485a92fb0448ed5d6b8b` LIVE, deployment
`6ae468ad1a67b8db20f91272`; health 200, legacy410 e sessione autenticata verificati.
Quota riconciliata alle 10:01:04 UTC, registrazione attiva dalle 10:04 UTC.
Run `41038096151` (`8bf17826`) SUCCESS 10:12:43 UTC: quattro incontri reali,
otto decisioni e inferenze, quattro snapshot condivisi con quote fresche;
zero puntate/errori/API errori, astensioni corrette. C resta Challenger.
58 osservazioni CALIBRATION congelate su quattro incontri, nessun FUTURE_TEST
né campione prudenziale completato: non è prova di redditività o superiorità.
Tre fetch consumano 9 crediti inclusi (304 usati/196 residui), senza cambiare
limite 500 e riserva 50. Wallet 1.000 euro ciascuno, zero impegnati, 258 legacy invariati.

Duplicato `41039455356` fermato prima di npm/build e DB/provider; audit RO del duplicato PASS alle 10:22:18 UTC, senza nuovi run DB
o record provider. Watchdog `41039066641` e `41039490287` SUCCESS. Frontend
`fb0e30f8` Deployed LIVE, Site Running, deployment `6ae46ff81a67b8db20fa2f2e`;
CI `41039799271` SUCCESS.
Restano da osservare puntualità del 31 ottobre 03:07 e ciclo risultato/liquidazione.
Il recupero manuale non è il ciclo sportivo completo. La
[nota del 30 ottobre](nightly-recovery-2026-10-30.md) conserva la procedura e le prove.

Verifica browser dopo il LIVE: sessione autenticata conservata, Sistema
mostra Riuscita alle 11:12 Roma, quattro partite e zero errori/API errori.
Prossimo run 31 ottobre 03:07 e testo «Orario di riferimento: 03:07 Europe/Rome»
verificati; quota 196 residui/304 usati e database raggiungibile. Le prove
restano private; questa è verifica dell'app effettiva, oltre al badge Hostless.

Il run `40944747548` SUCCESS alle 20:04:35 UTC appartiene al 29 ottobre:
è una prova storica, non l'esito del nuovo recupero.
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

- Programmazione pubblicata: 03:07 principale, 04:17 e 05:27 recuperi, con
  `timezone: Europe/Rome` nativa. GitHub può ritardare o perdere un trigger.
- Finestra ordinaria: dall'effettivo avvio delle decisioni alla successiva
  soglia delle 03:07 Roma nel nuovo assetto. Durata personalizzabile fra una e 48 ore.
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
garantisce la freschezza di ogni singola quota. Queste sono prove del 29 ottobre. Il 30 ottobre il probe gratuito ha verificato
soltanto la quota crediti, senza nuovi prezzi partita.

### Configurazione e rollout

| Variabile | Default preparato | Significato |
| --- | --- | --- |
| `RESEARCH_NIGHTLY_ENABLED` | `false` | Opt-in esplicito del nuovo percorso |
| `RESEARCH_NIGHTLY_HOUR` / `MINUTE` | Default 3/0; produzione 3/7 | Soglia Europe/Rome allineata con monitor e dashboard |
| `RESEARCH_NIGHTLY_WINDOW_HOURS` | vuoto | Successiva soglia; opzionale 1–48 ore |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | `300` | Età massima alla decisione |
| `RESEARCH_NIGHTLY_MIN_EV` | `0.04` | EV centrale minimo configurabile |
| `RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV` | `0.01` | EV prudenziale minimo configurabile |
| `RESEARCH_NIGHTLY_TIMEOUT_SECONDS` | `1200` | Limite del passo shell |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false` | Percorso operativo ritirato |

Il workflow legge `RESEARCH_NIGHTLY_ENABLED`, default `false`; il flag GitHub
è `true` dalle 10:04 UTC del 30 ottobre dopo il recupero controllato. Il nuovo guard usa
soltanto metadati GitHub prima di npm/build e richiede il successo effettivo
del passo `Run nightly sync` e del marker `Confirm enabled A/C completion`
nello stesso job e nella giornata Roma: stati verdi o cancellati
senza quel passo riuscito non consumano la giornata. Dopo un vero successo non riparte
il ciclo con scritture/provider; API incerte bloccano il gate. Concorrenza
seriale e vincoli DB restano attivi, senza garanzia di puntualità al minuto.

Il flag del backend dichiara lo stato atteso per la dashboard: il processo web
non avvia la nightly, neppure quando la configurazione viene dichiarata attiva.
La vecchia `/api/automation/place-valid-bets` resta `410`. `/api/bets/place`
appartiene alle operazioni manuali legacy e non viene usata dalla nuova A/C.

Il monitor aggiornato segue 03:07 e ammette soltanto il riconoscimento
esplicito dell'orfano `40940944902` tramite
`RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS`, se queued, zero job e di una
giornata precedente. L'orfano non è cancellato; ogni sua riattivazione torna
fatale, anche oltre 36 ore o dopo completamento. Il rollout aggiornato e la
riconciliazione della quota non sono attestati dai run storici qui sotto.

## B. Worker e monitoraggio

Backend Hostless attuale: `eb5d838e` LIVE, deployment
`6ae4984bb53426f1e55ec75c`, collegato al Turso personale. Frontend `3c503fa9`
Deployed LIVE, Site Running, deployment `6ae49cd1e2d5898dc9ef7bb2`. Le impostazioni verificate sono: repository
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
riepilogo. Il monitor `4dff28f4` era pubblicato nel 29 ottobre: CI `40944506327` SUCCESS,
dieci test mirati e revisione DST superati. Il nuovo smoke GitHub e DB RO
`40945351072` è riuscito. Dopo l'audit finanziario RO PASS sono stati abilitati
anche gli allarmi delle 03:00 nello snapshot del 29 ottobre: monitor GitHub, controllo DB periodico e attese
programmate erano attivi in quello snapshot. Il watchdog `40946558140` con `expect_enabled=true`
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

## E. Modelli, portafogli e nuova esecuzione attiva e verificata

I collaudi remoti precedenti usavano A `A-80cb25df5552621e` e C
`C-906371b0b3a1e2c8`: dieci origini ABSTAIN, portafogli A/C da 100.000 centesimi,
zero impegnato, 258 giocate legacy preservate. Sono evidenze storiche; non
attestano la nuova esecuzione del consiglio Partite.

La nuova A usa PredictionService e il pacchetto esatto della pagina,
identità `APP-A` con versione/hash di stato, distinta dalla research A80.
Il picker backend replica Low/Medium/High e ranking effettivi; la UI non
riordina i candidati. C906 e la sua baseline 80 restano immutati e Challenger.

La prova Linux precedente sull'artefatto C reale coincide con CatBoost nativo
su 6.146 confronti, errore massimo `5,55e-17`; runtime JSON Node senza Python.
Il container locale 0,25 CPU/256 MiB misurava RSS 80,62 MiB e p95 inferenza 0,316 ms.
Sono misure storiche, non la verifica della nuova policy o del backend completo;
il [report runtime](nightly-model-runtime-2026-10-29.md) ne conserva i confini.

| Regola della nuova policy | A | C |
| --- | --- | --- |
| Scelta | Consiglio canonico della pagina Partite | Candidato C supportato dal proprio engine |
| Stake | Esatta percentuale indicata dal consiglio | 1% fisso |
| Capitale iniziale, portafogli distinti | 1.000 euro | 1.000 euro |
| Esposizione massima | 5% | 5% |
| Puntate per partita/modello | Max 1 | Max 1 |

L'esecuzione virtuale non usa il veto 50/Hoeffding. `ResearchEvaluation` e
origini diagnostiche mantengono i propri controlli statistici: non vengono
cancellati né trasformati in una validazione della nuova policy. Prima si
conservano origini DIAGNOSTIC a stake zero, poi si valutano nuove esecuzioni
con policy e snapshot propri. I dieci vecchi ABSTAIN restano immutabili.
Quote reali ≤300 secondi, dati, capitale, kickoff e settlement supportato
rimangono obbligatori; nessuna puntata dopo l'inizio.

023 aggiunge soltanto `research_execution_policies`, `research_execution_jobs`,
`research_execution_inputs`, `research_execution_decisions` e il FK nullable
`research_bets.execution_decision_id`. Il ledger esistente resta l'unico
registro finanziario dei portafogli, con unicità globale anti-duplicati.
Il rehearsal locale e la ripresa dopo crash preservano 57 tabelle precedenti;
backup ufficiale personale circa 530 MB, due restore con integrità/FK0.
023 applicata sul personale alle 13:14 UTC: registro 23→24 righe (i due file 007
restano distinti), quattro tabelle allora vuote; 21 hash delle colonne originali
protette invariati, inclusi utenti 2 e sessioni 3 legittime, e sette hash
finanziari identici al backup. 258 legacy, A/C 1.000 euro e zero impegnato preservati.

Il frontend LIVE preferisce pacchetto A congelato ed euro effettivi, con
stato/timestamp della quota storica: non è un prezzo live. Non usa un nuovo
consiglio live per mascherare un ABSTAIN tecnico. Il replay conserva selezione e
quota storica; un ABSTAIN tecnico lecito senza pacchetto produce
`technical_abstention`, motivo/timestamp reali, modello/probabilità/quota
assenti e stake zero. Una BET corrotta senza pacchetto produce 503. Conteggi
completi prima dei 500 dettagli: 600 coppie restano 600, con 500 righe e
`truncated=true`; nessun fallback live.
C esclude push/quarti non supportati e cerca un'altra opportunità ammessa;
A conserva i quarti supportati da GoalSettlement. EXPERIMENTAL è ammesso con
idoneità tecnica, senza promessa di profitto, copertura totale o superiorità C.
Le politiche di stake diverse rendono il profitto un confronto di esecuzioni,
non una prova isolata della qualità dei modelli. Nessun denaro o commissione reale.

`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true`: backend eb5 e UI3c LIVE,
run reale `41069572500` SUCCESS con cinque puntate virtuali (3 A/2 C), audit 71/71
PASS. Il preview precedente aveva zero movimenti finanziari; il run attivo ha
impegnato 44,20 euro A e 20 euro C, come verificato nel ledger. Nessuna somma
dei due portafogli; equity 1.000 euro ciascuno. Risultati e settlement ancora futuri.
Rollback: spegnere il nuovo flag mantenendo settlement e viste compatibili;
non attribuire nuove BET alle origini diagnostiche a zero stake e non
sovrascrivere il DB con un vecchio backup. La
[nuova guida](recommendation-execution-2026-10-30.md) separa le prove locali
dagli esiti remoti ancora da ottenere.

## F. Gate dei rilasci precedenti (29–30 ottobre)

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

## G. Pubblicazione e verifiche remote — snapshot del 29 ottobre

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

Nello snapshot del 29 ottobre Nightly Sync era riabilitata,
`RESEARCH_NIGHTLY_ENABLED=true`; il 30 ottobre è stata riattivata alle 10:04 UTC
dopo il recupero controllato, descritto all’inizio del documento.
Training settimanale e diagnostica quote manuale riabilitati; pubblicazione
nel registro modelli ancora disabilitata. Monitor GitHub, controllo DB
periodico RO e attese delle 03:00 erano attivi nello snapshot del 29 ottobre. Il watchdog `40946558140`
è SUCCESS con aspettativa abilitata: tutti i passi GitHub e DB RO completati.
Nessun servizio a pagamento, carta o aumento CPU/RAM è stato attivato.
La fatturazione completa Hostless non è accessibile al ruolo Editor.

L'infrastruttura ora può eseguire il flusso senza PC o smartphone accesi;
la prima nightly è riuscita senza eventi eleggibili. Un ciclo prospettico
con quote, decisione, risultato ufficiale, liquidazione e aggiornamento
portafogli resta da osservare. Nessuna puntata
è forzata per superare il collaudo. Nessuna consegna esterna email/push e nessun
test su dispositivo Android sono attestati.

## H. Recupero verificato del 30 ottobre

Alle10:01:04 UTC la riconciliazione atomica COMMITTED ha riallineato il budget
da 500/0 a 295/205 usati/residui, con un solo append `QUOTA_RECONCILED`.
Durante questa correzione gli hash di richieste, risultati, cache, eventi
preesistenti e sette insiemi finanziari restano invariati. Anchor 15 e reset 1
sono conservati; non è un reset mensile o un cambio account per aggirare limiti.

[Run reale 41038096151](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41038096151)
SUCCESS 10:12:43 UTC su `8bf17826`. Runner avviato quattro secondi dopo il
dispatch: misura manuale, non puntualità del cron. Sync e marker A/C entrambi
SUCCESS 10:12:38 UTC. Fase modelli 10:11:38.809→10:12:25.923 UTC, finestra fino
al 31 ottobre 02:07 UTC / 03:07 Roma. Audit RO 10:14 UTC PASS:

- Quattro incontri reali, otto decisioni e otto inferenze A/C, quattro snapshot
  condivisi; distribuzioni diverse, finite, normalizzate e coerenti.
- Quote reali fresche anche al commit, età massima 205,314 secondi.
- 58 osservazioni congelate (29 A/29 C), tutte CALIBRATION, zero FUTURE_TEST.
  Sono quattro incontri indipendenti e zero campioni prudenziali completati.
- Zero puntate/errori/API errori; astensioni per valore sotto soglia o evidenza
  prudenziale insufficiente, senza abbassare i gate. C resta Challenger.
- A/C 1.000 euro ciascuno, zero impegnati; 258 giocate legacy e hash finanziari
  preservati. Nessuna nuova chiave, account, piano o risorsa a pagamento.

Tre fetch da tre crediti hanno consumato nove crediti inclusi: 304 usati/196
residui e anchor 24, con limite 500, riserva 50 e reset invariati.
[Duplicato 41039455356](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41039455356)
SUCCESS con installazione/build/Sync/marker SKIPPED prima di backend, DB e
provider; audit RO del duplicato PASS alle 10:22:18 UTC, senza nuovi run DB
o record provider.
[Watchdog 41039066641](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41039066641)
SUCCESS dopo il recupero. Il sistema esegue queste operazioni su GitHub,
Hostless e Turso, senza PC o telefono accesi.

Frontend `fb0e30f8` Deployed LIVE, Site Running, deployment
`6ae46ff81a67b8db20fa2f2e`. Diciassette test mirati, build/typecheck/lint e
review superati; CI `41039799271` SUCCESS. La release contiene il fix che
ricava l'orario dal DTO, coerente con 03:07; piattaforma e app autenticata
sono verificate, compreso il testo 03:07.
Restano futuri il trigger programmato 31 ottobre 03:07, risultati ufficiali e
liquidazioni: non è ancora il ciclo sportivo completo né prova di profitto.

Audit RO post-duplicato delle 10:22:18 UTC PASS: nessun run DB `41039455356`,
nessun nuovo job, richiesta, risultato o evento provider; stessi quattro input,
otto decisioni, 58 osservazioni e zero puntate. Quota 304/196 e anchor 24,
sette hash finanziari e 258 giocate legacy invariati; A/C 1.000 euro ciascuno,
zero impegnati. Anche il secondo watchdog `41039490287` è SUCCESS.

## I. Preparazione, preview e migrazione prima dell’attivazione

Codice `eb5d838e` e traduzioni UI `3c503fa9` pubblicati in main. CI
`41056818328` e `41063288958` Backend/Frontend SUCCESS. Il gate backend Linux ha
1.016 test, 1.015 passati, zero falliti e un opzionale training Python CatBoost
saltato. Il gate frontend completo locale sul main `3c503fa9` ha
30 suite/215 test passati in
30,175 secondi. Questi controlli non sono una registrazione finanziaria reale.

Preview GitHub `41056880577` SUCCESS alle 12:40 UTC su cinque fixture reali:
cinque inferenze A e cinque C, quattro consigli A e uno C, zero nuove
esecuzioni e zero puntate, finanza invariata. Il provider in quel momento
mostra 316 usati/184 residui, nove crediti da tre richieste; limite 500 e
riserva 50 conservati. È un'osservazione datata, non credito futuro garantito.

023 APPLIED alle 13:14 UTC sul personale: registro migrazioni 23→24 righe,
quattro nuove tabelle vuote. I due file 007 restano due migrazioni distinte;
il conteggio righe non si deduce dal solo nome numerico. Ventuno hash delle
colonne originarie protette e sette hash finanziari invariati; utenti 2 e
sessioni 3 legittime preservati, 258 legacy e A/C 1.000 euro con zero impegnato.
Backup ufficiale 530.429.352 byte incluso WAL, ripristini con integrità ok/FK0,
57 tabelle e 314.952 righe; rehearsal completo e crash-resume 023 riusciti.

Il backend eb5 è ora LIVE sul deployment `6ae4984bb53426f1e55ec75c`; frontend
3c LIVE sul deployment `6ae49cd1e2d5898dc9ef7bb2`. Il primo deploy frontend eb5
non è quello operativo. `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` e
`RESEARCH_NIGHTLY_ENABLED=true`: attivazione e prima registrazione reali
sono confermate nella sezione seguente. Risorse backend 0,1 vCPU/256 MiB,
una replica/max 1 e auto-deploy OFF preservati. Nessun T−15 operativo, C
Challenger e matematica dei modelli invariata.

## J. Attivazione effettiva della policy Partite — 30 ottobre

Backend `eb5d838e` LIVE sul deployment `6ae4984bb53426f1e55ec75c`; frontend
`3c503fa9` LIVE sul deployment `6ae49cd1e2d5898dc9ef7bb2`. Health200,
API privata anonima 401, legacy automatico POST 410 e sessione autentica verificati.
`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` è confermato. Nessun nuovo
modello, cambio piano/provider, servizio a pagamento o worker T−15 attivo.

[Run 41069572500](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41069572500)
SUCCESS: cinque partite, dieci decisioni effettive e cinque puntate virtuali
(3 A/2 C). Una raccomandazione A è esclusa per esposizione, una non ha consiglio;
tre C si astengono per linee push/quarti incompatibili. Nessuna soglia o
baseline è modificata per forzare una puntata: C resta Challenger.

| Portafoglio | Disponibile | Impegnato | Equity | Stake eseguiti |
| --- | ---: | ---: | ---: | --- |
| A | 955,80 € | 44,20 € | 1.000,00 € | 0,42%, 1,8%, 2,2% del proprio patrimonio |
| C | 980,00 € | 20,00 € | 1.000,00 € | 1% del proprio patrimonio |

Esposizione A 4,42%, C 2%, entrambe sotto 5%; massimo una puntata per
partita/modello. I capitali non sono sommati. Audit in sola lettura 71/71 PASS.
Quote autentiche Codere IT/Betsson, età 51,6–79,3 secondi. Provider 325 usati/175
residui osservati alle 14:16:55 UTC; stato DEGRADED include il vecchio errore
conservato nel ledger e non viene cancellato per mostrare tutto verde.

[Watchdog 41070547360](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41070547360)
automatico SUCCESS: GitHub `ok=true`/`issues=[]`, DB `ok=true`/`issues=[]`,
Nightly SUCCESS e `overdue=false`.
[Duplicato 41071349342](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41071349342)
SUCCESS con `daily_sync_already_succeeded`; installazione/build/Sync/conferma
SKIPPED prima dell'app e del provider.

Pagina Partite autenticata LIVE verificata: A Le Havre–PSG, quota 8 Codere IT
e importo registrato 4,20 euro, stesso pacchetto Nightly archiviato. Le quote
rimangono storiche, non sono presentate come un prezzo bookmaker corrente.
Risultati ufficiali e liquidazioni sono ancora futuri: il primo ciclo completo
non è concluso. Il trigger programmato resta da osservare; nessuno SLA al minuto.
APK Android non aggiornato perché manca il keystore originale; web e cloud
sono verificati, non un nuovo pacchetto installato sul dispositivo.

Per fermare nuove puntate: `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=false`;
mantenere il workflow intero e il backend compatibile 023. Lo shell chiama
`POST /api/research/settle` prima del gate `RESEARCH_NIGHTLY_ENABLED`, con
settlement delle nuove BET 023. Sola CLI diagnostica, retry saltato o gate dati
non dimostrano liquidazioni eseguite. Non riattivare legacy o sovrascrivere il DB.


## K. Portafogli nelle pagine normali: integrazione locale in verifica

Il requisito aggiornato porta A/C in Giocate, Budget e Archivio, con filtri
modello e confronto. La gestione principale usa A; C mantiene saldo e storico
indipendenti. Research conserva benchmark e modelli, senza essere una modalità
alternativa per gestire denaro virtuale.

L’implementazione locale legge `GET /api/wallets`, adattatore sopra
`ResearchComparison`: aggregati contabili completi, massimo 500 dettagli con
troncamento esplicito. Usa gli stessi ID `shadow_A`/`shadow_C`, cinque BET e
ledger già finanziati. Nessuna copia, migrazione, reinizializzazione,
registrazione o nuovo addebito; nessun POST legacy di sync/placement dalle
viste principali. Le 258 giocate precedenti restano consultabili in uno
storico distinto, senza attribuirle ad A né sommare i capitali.

Il risultato LIVE della sezione J precede questa integrazione UI. Pubblicazione
e collaudo remoto delle nuove pagine sono ancora da verificare; non costituiscono
una nuova esecuzione Nightly. Modelli, stake, liquidazione, infrastruttura e
limiti del primo ciclo sportivo rimangono quelli già descritti.
