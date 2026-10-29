# Nightly Pre-Match Virtual Betting: stato e pubblicazione

Il mandato del 29 ottobre 2026 sostituisce il requisito T−15. Il confronto
prospettico consiste in due portafogli virtuali A/C, elaborati dalla nightly
GitHub Actions. Non richiede un worker sempre acceso o una modalità Shadow
parallela. Non effettua scommesse con denaro reale.

**Stato: codice verificato e pubblicato in PR; nuove registrazioni remote e
cutover Turso non attivati.** La produzione continua a usare il database
originale. Questo documento sostituisce le precedenti istruzioni di attivazione
T−15; i report scientifici e gli snapshot operativi datati restano storici.

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
fallback `false`. Nessuna variabile remota è stata abilitata in questa fase.
Il flag del backend dichiara lo stato atteso per la dashboard: il processo web
non avvia la nightly, neppure quando la configurazione viene dichiarata attiva.
La vecchia `/api/automation/place-valid-bets` resta `410`. `/api/bets/place`
appartiene alle operazioni manuali legacy e non viene usata dalla nuova A/C.

## B. Worker e monitoraggio

Backend Hostless attuale: `122fd36` LIVE. Il tentativo successivo `60a6baa`,
deployment `6ae355cd7b2d5d826aa4c4c4`, risulta fallito per attesa eccessiva
in coda. Le impostazioni sono ora accessibili: repository
`Ivandragon003/scommeseSportive`, branch `main`, Docker con directory e contesto
`/backend`, auto-deploy disattivato. La nuova implementazione non è distribuita.
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
- Worker embedded precedente preservato; nessun servizio o database eliminato,
  nessun ulteriore deployment worker richiesto.

Il [watchdog GitHub](../../.github/workflows/research-watchdog.yml) sostituisce
il controllo heartbeat con esito/assenza della nightly, tramite API GitHub
e permesso `actions: read`. Gli allarmi sono opt-in. L'ispezione del DB è
opzionale e richiede `TURSO_WATCHDOG_READONLY_TOKEN`: nessun fallback al token RW.
Controlla run, partite, registrazioni, skip, quota, liquidazioni e contabilità.
Il riepilogo della giornata precedente è preparato dalla nightly con timestamp
reale e `publishAfter` alle 09:00 Roma, visibile da quell'ora anche attraverso
i GET. Non è una consegna email o push. Un flag spento non produce un nuovo
riepilogo. Canale esterno e mancata esecuzione remota restano da collaudare.

## C. Database personale e cutover

Sorgente mantenuta:
`scomessesportive-ivandragon003.aws-eu-west-1.turso.io`.
Il pannello personale identifica Daniele De Blasio, organizzazione
`selloneciompi`, piano Starter Free: 0/500M letture, 0/10M scritture,
0/5 GB storage, 0/3 GB sync, prossima fattura $0 e nessun metodo di pagamento,
al controllo precedente all'importazione. La CLI ufficiale conferma Starter,
overage disattivati e gruppo `default` Healthy in `aws-eu-west-1`. Sono dati
ufficiali del nuovo account, non consumi trasferiti dal collaboratore.

Nuovo backup coerente del 29 ottobre, iniziato alle 15:17:22 UTC (16:17 Roma):

- Dump 459.806.723 byte, SHA-256
  `9b2018ac753ac518bd263908024bddb31efcd317edf41ae7c95c1ca9a86a7b5a`.
- Ripristino leggibile, 52 tabelle contate, `integrity_check=ok`, zero violazioni FK.
- Copia per upload SQLite di 525.799.424 byte, WAL/checkpoint su copia distinta.
- Archivio privato ignorato da Git:
  `backend/artifacts/backups/personal-migration-20261029/`.
- Verifica quote della sorgente non dichiarata: il manifest conserva la
  precedente deroga esplicita dell'utente, senza attestare un controllo mai fatto.

Il primo tentativo UI restituiva `group not found`; il gruppo è stato poi
verificato con la CLI ufficiale. La copia iniziale `footpredictor`, SQLite,
è stata importata nello stesso gruppo europeo. Host della destinazione:
`footpredictor-selloneciompi.aws-eu-west-1.turso.io`.

Il confronto integrale del 29 ottobre, 16:49:31 UTC, è riuscito:

- Sorgente esportata completamente alle 15:18:10 UTC; destinazione esportata
  con snapshot nativo CLI e WAL alle 16:46:36 UTC.
- 125 oggetti di schema, 52 tabelle applicative e `sqlite_sequence` identici:
  conteggi e checksum di tutte le righe coincidono, 314.089 righe applicative.
- Entrambi i ripristini: integrità `ok`, zero violazioni FK; file originali
  e ripristini immutati durante il confronto.
- Report privato: `migration-snapshot-parity.json` nella directory backup.
- `snapshotParity=true`, **`liveParityVerified=false`**: le scritture successive
  della produzione richiedono ancora una sincronizzazione finale coordinata.

Il pannello mostra la copia Active, ma i contatori storage/letture ancora a zero
non sono misure aggiornate: l'export reale contiene circa 501,5 MiB. Non sono
stati cambiati URL o secret applicativi di Hostless o GitHub. Le nuove migrazioni
020/021 non sono state applicate in remoto. Il
[verifier offline](../../backend/scripts/verify-turso-migration.js) controlla due
dump ripristinati, schema/indici/vincoli, integrità, conteggi e checksum di tutte
le righe, senza credenziali o rete. La sua parità riguarda gli snapshot, non
scritture live successive. [Procedura completa](turso-personal-migration-2026-10-29.md).

### Piano da approvare prima del passaggio definitivo

1. Dopo l'approvazione, unire la PR verificata e pubblicare il codice con
   registrazioni e monitoraggio spenti. Il push su `main` può avviare il warmup
   sul database attuale: attenderne la conclusione prima del blocco scritture.
2. Distribuire prima il backend e poi il frontend, verificando API, sessioni,
   dashboard e saldi sul database originale. Se Hostless resta in coda, fermarsi
   prima del cutover, preservando la versione funzionante.
3. Inventariare backend, nightly, training, warmup, watchdog e script locali;
   registrare i riferimenti dei secret senza valori. Verificare che Hostless
   possa applicare anche la configurazione del database: nessuno switch parziale.
4. Sospendere temporaneamente tutti gli scrittori e l'accesso alle operazioni mutanti;
   controllare i job in corso e acquisire il dump finale coerente.
5. Sincronizzare la destinazione e verificarla rispetto al dump finale. Se
   occorre ricrearla, l'autorizzazione deve nominare esclusivamente la copia
   personale `footpredictor` in `selloneciompi`, attualmente non usata dalle app.
   Conservare il suo backup verificato; l'originale del collaboratore non viene
   cancellato o sovrascritto. Senza questo consenso, niente ricreazione.
6. Aggiornare URL/token coordinati, verificare un solo database effettivo,
   applicare solo le migrazioni additive collaudate e preparare la calibrazione
   della stessa implementazione che verrà distribuita.
7. Riattivare manutenzione e verificare backend, sessioni, dashboard e saldi;
   soltanto dopo il consenso abilitare la nightly A/C e il monitor GitHub.
   All'inizio saranno possibili soltanto osservazioni/astensioni, finché i
   residui indipendenti non superano i controlli invariati. L'eventuale successiva
   puntata resta virtuale e subordinata a tutti i gate.
8. Osservare una nightly reale e successive liquidazioni, senza forzare puntate.

Rollback: spegnere il nuovo flag di registrazione mantenendo storico e
liquidazioni. Prima di ripristinare connessioni precedenti riconciliare ogni
scrittura successiva al cutover; non copiare sopra la produzione un vecchio DB
e non riattivare l'endpoint automatico legacy.

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

- Backend Linux Node 20, rete disabilitata: **872 test, 871 passati, un opzionale
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
  idempotente. È una prova locale e non un'applicazione remota.
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

## G. Pubblicazione e verifiche remote pendenti

Preparazione su branch `codex/nightly-ac-personal-turso`, evitando un push su
`main` che avvierebbe il warmup con le credenziali di produzione precedenti.
Il branch è pubblicato nella [PR #1, in bozza](https://github.com/Ivandragon003/scommeseSportive/pull/1).
Commit funzionali: `22a54e8b` (I/O database), `e4c7f6d8` (nightly e coorte),
`a4af9018` (dashboard), `eae7c4b7` (verifica migrazione). La documentazione di
rilascio è inclusa. I check remoti della PR sono il riferimento per la CI della
revisione pubblicata; le verifiche locali sopra non li sostituiscono.
La [CI 40919808475](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40919808475)
ha completato Backend e Frontend con successo sulla revisione `d4f16d25`, che
contiene tutto il codice funzionale; gli aggiornamenti successivi a questo
report sono documentali. Nessuna attivazione segue automaticamente quei check.
Scansioni Gitleaks delle patch pubblicate superate. Non sono state
attivate le nuove registrazioni, cambiati secret di produzione o eseguito un
cutover. Nessuna risorsa a pagamento, carta o cambio di piano autorizzato.

`main` resta `0c8b2c7`. Nightly Sync è Active, soltanto manutenzione:
ultimo run remoto verificato `40857398332`, riuscito il 29 ottobre alle
10:25:06 UTC, revisione `e046bc4`. Al controllo non risultavano workflow in
esecuzione. Il nuovo percorso e il nuovo watchdog non sono ancora pubblicati
nel branch di default; la PR non ne costituisce l'attivazione.

Restano necessari: sincronizzazione finale della copia personale, cutover
coordinato autorizzato, deploy Hostless riuscito e verificato, notifiche esterne
se autorizzate e una vera nightly
prospettica con risultati e liquidazioni. Il PC non sarà necessario al flusso
cloud dopo questi gate; la preparazione locale non ne dimostra l'attivazione.
