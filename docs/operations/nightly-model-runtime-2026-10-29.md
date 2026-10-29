# Runtime dei modelli nightly — verifica locale Linux del 29 ottobre 2026

## Esito e confini

Il modello C registrato è stato caricato ed eseguito realmente in Linux, senza
training e senza provider esterni. L'inferenza numerica Node coincide con
CatBoost nativo 1.2.8 su 6.146 confronti: errore assoluto massimo
`5.551115123125783e-17`.

Questa è una verifica tecnica locale. Non dimostra redditività, copertura delle
quote, funzionamento completo della nightly o disponibilità della nuova release
su Hostless. Il deployment remoto e l'attivazione delle registrazioni rimangono
soggetti ai rispettivi gate.

## Dipendenze effettive

Il percorso è `ResearchRuntime.prepareNightly` → `predictHybrid` →
`predictCatBoostJson`, in `backend/src/research/CatBoostModel.ts`. Il runtime
legge gli alberi numerici esportati in JSON ed esegue l'inferenza in Node.js;
non avvia Python. Sono ammessi gli split numerici `FloatFeature`; caratteristiche
categoriche, testo e embedding non supportati vengono rifiutati.

Python e `catboost==1.2.8`, già presenti nei requisiti ML del progetto, servono
al training separato e alla verifica di parità. La loro assenza nel workflow
nightly non costituisce una dipendenza mancante. Non sono stati aggiunti pip,
training, promozioni o dipendenze al workflow. Rimane invariato il flag
`vars.RESEARCH_NIGHTLY_ENABLED`, con fallback `false`.

## Artefatto e integrità

L'artefatto è stato letto soltanto dal dump locale
`backend/artifacts/backups/personal-migration-20261029/source-2026-10-29T15-17-22-469Z/restore.db`.
SQLite è stato aperto con `mode=ro&immutable=1` e `PRAGMA query_only=ON`; il file
è stato montato in Docker in sola lettura.

| Proprietà | Valore verificato |
| --- | --- |
| Versione C | `C-906371b0b3a1e2c8` |
| Hash artefatto nel registro | `3f18e05ee228d1c6fdbe92865b3b19635cdf68f3ecbd50ff53d83914b52993b3` |
| Baseline A | `A-80cb25df5552621e`, uguale al runtime verificato |
| Protocollo | `joint-goal-coherent-v2`, hash pipeline corrispondente |
| Tipo C | `calibrated_ensemble` |
| Feature numeriche | 40 |
| Alberi | 120 home + 120 away |
| Profili di calibrazione | A e C presenti |
| Stato economico | `productionValidated=false`; nessuna promozione |

SHA-256 del dump prima e dopo la verifica, identico:
`883d673eec9c864582e495c8f8dc1eaa24d0e1c0f9befcc092847ce7344390d7`.

Non sono stati letti secret, aperti database remoti o modificati i container
dell'applicazione già avviati. I soli nuovi file sono risultati privati del
collaudo nella directory backup ignorata da Git.

## Prova di parità e misure

Il processo Python ha caricato i due modelli JSON esistenti con `load_model`,
senza chiamare `fit`. Ha valutato 3.073 vettori deterministici: un vettore zero
e tre valori per ciascuna delle 1.024 frontiere numeriche distinte, includendo
la frontiera e i valori float32 immediatamente precedenti e successivi.
Sono sonde tecniche, non partite o risultati economici sintetici.

Lo script esistente `backend/scripts/research-ml-smoke.js` ha confrontato gli
output nativi con quelli Node, eseguito il percorso ibrido completo su una
baseline simulata esplicitamente e verificato gli errori per feature non finite,
schema incompatibile, modelli mancanti e modello temporalmente non disponibile.
Ha poi misurato 1.000 inferenze dopo riscaldamento e un lotto di 20.

| Misura | Verifica ML, 2 CPU / 1 GiB | Immagine runtime, 0,25 CPU / 256 MiB |
| --- | ---: | ---: |
| Node | 20.20.2, Linux x64 | 20.20.2, Linux x64 |
| Python nel runtime verificato | disponibile solo per confronto nativo | assente, verificato prima del comando |
| Caricamento input/artefatto Node | 137,36 ms | 392,48 ms |
| Inferenza Node p50 | 0,111 ms | 0,107 ms |
| Inferenza Node p95 | 0,245 ms | 0,316 ms |
| Inferenza Node massima | 0,675 ms | 91,135 ms |
| Lotto di 20 inferenze | 2,48 ms | 2,80 ms |
| CPU totale processo Node | 433,32 ms | 494,16 ms |
| Tempo totale processo Node | 464,21 ms | 2.196,28 ms |
| RSS massimo processo Node | 86,83 MiB | 80,62 MiB |
| Uscita del comando | 0 | 0 |

Il confronto Python nativo ha usato CatBoost 1.2.8, circa 1.136,75 ms CPU,
1.541,89 ms totali e 162,70 MiB RSS massimo. Le misure Node comprendono il
caricamento e il confronto di parità, oltre alle inferenze; non sono il consumo
del backend completo, del calcolo A, delle query o dell'intera nightly.

Il massimo di 91 ms con quota CPU ridotta rimane visibile: questo esperimento
non certifica la risoluzione del throttling Hostless e non autorizza cambi di
piano o risorse. I limiti della seconda colonna sono limiti del container locale,
non una dichiarazione sulle risorse disponibili gratuitamente sull'account.

## Limite decisionale rilevato nel registro attuale

La compatibilità dell'inferenza non equivale all'ammissione di puntate virtuali.
Nel dump verificato, `calibrationSamples` è assente sia dall'artefatto sia dal
report C registrato; non è presente un benchmark A distinto. I profili di
calibrazione A/C esistono, ma non sostituiscono i campioni indipendenti richiesti
dal controllo prudenziale di `explainResearchDecision`.

Con questo registro le opportunità che superano il primo filtro EV vengono
escluse dal controllo minimo di 50 campioni ammissibili per mercato e fascia,
con `insufficient_validation_calibration`, anche se le quote sono fresche e
l'inferenza riesce. `ResearchLifecycle.ts` rimuove intenzionalmente i
campioni precedenti durante la finalizzazione coerente: non vanno riutilizzati
automaticamente come evidenza indipendente. Non sono stati ricostruiti campioni,
riutilizzato il test finale, ridotte soglie o modificate le probabilità.

Questo requisito va soddisfatto con evidenze temporalmente e statisticamente
ammissibili prima di dichiarare che la configurazione reale può generare BET;
l'astensione resta il comportamento sicuro e previsto finché mancano.

## Accumulo prospettico implementato dopo l'audit

È stato aggiunto `ResearchProspectiveEvidence.ts`, integrato nel percorso
nightly e nello store mediante la migrazione additiva `021_research_prospective.sql`.
L'assenza dei campioni iniziali rimane reale; ora esiste il percorso per
raccogliere evidenza nuova senza riutilizzare i dati storici vietati.

Prima del calcio d'inizio, la stessa transazione che registra input e decisioni
congela osservazioni anche quando il modello si astiene. Ogni osservazione
conserva quota e bookmaker reali, probabilità ed EV già calcolati, input e
versione del modello, hash dell'artefatto e della configurazione, mercato,
fascia probabilistica e timestamp. Non crea puntate o movimenti del ledger.
Le protezioni di lease, kickoff e idempotenza valgono anche per queste righe;
un errore annulla insieme input, osservazioni e decisioni.
Sono ammesse soltanto quote `prematch`: prezzi `opening`, `closing`, T−15 o
senza protocollo esplicito non possono alimentare questo registro.

Per ciascuna famiglia viene scelta al massimo una quota per partita, mercato
e fascia. L'ordinamento è fissato prima dell'esito: EV centrale decrescente e
spareggi deterministici su selezione e provenienza. Non viene selezionata a
posteriori l'osservazione che avrebbe vinto. La stessa formula del Decision
Engine calcola probabilità ed EV, senza cambiare i modelli.

Il protocollo `prospective-residual-v1` assegna la partita a una partizione
tramite SHA-256 della sua identità, uguale per A, C e tutti i mercati:
80% nominale `CALIBRATION`, 20% nominale `FUTURE_TEST`. La proporzione effettiva
su un campione piccolo può differire. La partizione è immutabile e quella di
test futuro non entra mai nei residui prudenziali. Rimangono esclusi gli ID del
test finale storico protetto e le osservazioni precedenti al confine temporale
già fissato nel progetto.

Quando il risultato ufficiale è realmente disponibile, il settlement usa
soltanto la quota e le probabilità congelate: non riesegue il modello né
ricostruisce una decisione. Registra append-only il payout e l'ora effettiva di
osservazione del risultato; non retrodata quest'ultima a kickoff + due ore.
Risultati duplicati non riscrivono la disponibilità originaria. La conversione
supporta gli stessi rimborsi e quarter-line del settlement esistente.

Se un risultato ufficiale già osservato viene successivamente contraddetto
dai gol o dall'orario ufficiale corrente, viene aggiunta una quarantena
permanente con il timestamp effettivo della rilevazione. La lettura dei residui
esclude quel campione da quel momento; una lettura storica precedente conserva
la conoscenza disponibile allora. L'evidenza originale, il primo payout e la
sua disponibilità non vengono riscritti. La quarantena non corregge portafogli
né introduce una nuova etichetta di risultato utilizzabile per il training.

La nightly legge soltanto le osservazioni dedicate `CALIBRATION` già risolte,
con stessa famiglia, versione e hash di configurazione, disponibili entro
l'istante della nuova previsione. Non legge i residui dall'ultimo benchmark o
dall'artefatto del fit. I protocolli storici/T−15 e i benchmark restano invariati.
Il minimo di 50 partite per mercato/fascia, la deduplicazione per partita e il
limite prudenziale di Hoeffding restano invariati: raggiungere 50 osservazioni
non garantisce una puntata. Un cambio di versione o profilo richiede evidenza
compatibile con la nuova identità.
Durante una coorte nightly il runtime riusa il primo insieme di residui per
famiglia/versione/configurazione e registra il relativo cutoff nella decisione:
due incontri richiedono due letture, una per modello, anziché quattro. Una nuova
coorte o configurazione effettua una lettura nuova. Questo evita una scansione
ripetuta dell'evidenza a ogni incontro e non incorpora esiti osservati più tardi
durante la stessa coorte.

La raccolta è ancora soltanto implementata e collaudata localmente. La
migrazione 021 e l'abilitazione remota della raccolta/registrazione richiedono
i rispettivi controlli e l'autorizzazione separata prevista; nessuna riga
prospettica è stata aggiunta al database di produzione durante questo lavoro.

Verifiche mirate aggiunte: selezione deterministica, astensione iniziale,
congelamento prima dell'esito, risultato osservato al clock effettivo,
riutilizzo sul nuovo incontro senza replay del precedente, isolamento per
configurazione e partizione, append-only, retry, lease e rollback al kickoff.
Il test integrato conferma che il vecchio artefatto con campioni favorevoli
non può aggirare il registro indipendente e che una sola partita risolta
lascia invariato il blocco prudenziale, senza puntate o modifiche dei saldi.
Ultimo gate mirato Linux Node 20, senza rete, con 2 CPU e 1 GiB:
34/34 test superati, nessuna cancellazione o skip, uscita 0. Comprende le
regressioni su prezzi non prematch, correzione ufficiale e lettura `asOf`
antecedente alla quarantena. TypeScript e lint mirato superati. Il gate completo
di integrazione resta separato da questi controlli mirati.

## Probe manuale GitHub sul registro personale

È disponibile `backend/scripts/probe-research-ml-runtime.js`, richiamato dal
workflow esclusivamente manuale `research-runtime-verification.yml`. Il probe
non viene eseguito dalla normale nightly e non dipende dalla presenza di
partite o quote nella sua finestra. Questo evita di scambiare una nightly
riuscita con zero partite per una verifica dell'inferenza C remota.

La connessione usa direttamente `@libsql/client`, senza bootstrap applicativo,
`DatabaseService` o metodi `ResearchStore`. È accettato soltanto l'host
`footpredictor-selloneciompi.aws-eu-west-1.turso.io`; URL con credenziali
incorporate, query o percorsi inattesi vengono rifiutati prima della connessione.
Il workflow fornisce soltanto `TURSO_DATABASE_URL` e il secret dedicato
`TURSO_WATCHDOG_READONLY_TOKEN` nello step del probe. Quest'ultimo deve essere
stato emesso con permessi di sola lettura per il target. Non esiste fallback
al token RW e non viene tentata alcuna scrittura per verificare i permessi.

Una sola SELECT legge l'artefatto C: precedenza al champion registrato, altrimenti
ultimo candidato ordinato per creazione e versione, come nel runtime. Il probe
verifica hash del contenuto, versione, schema delle feature, baseline, protocollo
e hash della pipeline, compatibilità e disponibilità temporale. Un artefatto
diagnostico, futuro o incompatibile fa fallire il job, senza scegliere
silenziosamente un modello diverso.

Il modello viene eseguito con feature numeriche e baseline Poisson sintetiche,
create soltanto in RAM e riferite all'ora effettiva del probe. Nessuna riga di
partite, previsioni, quote, osservazioni o portafogli viene letta o creata.
L'output contiene solo identificativi/hash, controlli di probabilità finite e
massa, p95 di 100 inferenze, memoria e durata, insieme a
`syntheticInput=true`, `databaseWrites=0` e `providerRequests=0`. Non contiene
artefatti, feature, credenziali, URI della connessione o stack degli errori.
Anche gli errori del client vengono ridotti a codici fissi e il client viene
chiuso su successo e fallimento.

Il workflow usa Node 20, `npm ci`, build e timeout di cinque minuti, con soli
permessi GitHub `contents: read`. Non installa Python, non allena o promuove
modelli, non avvia nightly o scheduler e non carica artifact GitHub. Non aggiunge
letture periodiche del modello al watchdog.

Dopo pubblicazione e configurazione dei secret del target, il comando manuale è:

```powershell
gh workflow run research-runtime-verification.yml --ref main
```

Il comando è documentato, non è stato eseguito durante l'implementazione del
probe. Finché non esiste un run GitHub concluso con successo e il relativo
report, l'inferenza remota rimane non verificata da questo strumento.

Un eventuale successo proverà la lettura del modello reale e la sua inferenza
JSON Node nel runner GitHub. Non ripete la parità Python/CatBoost nativa dei
6.146 confronti già eseguiti localmente e non certifica dati reali, calibrazione
con quote, gate prudenziale, registrazioni, liquidazioni o ciclo prospettico
completo: `fixtureCycleVerified=false` e `nativeParityExecuted=false` rendono
espliciti questi confini. Il traffico di questa SELECT non viene attribuito
alla voce Turso Embedded Sync senza una misura ufficiale distinta.

Verifica locale del probe: 7/7 test passati su Windows e Linux Node 20 senza
rete. Il client fake rifiuta SQL non SELECT; una fixture SQLite soltanto in RAM
verifica realmente la precedenza SQL champion/candidato e lo spareggio di
versione. Sono coperti host errato, token RO mancante anche in presenza di RW,
artefatti non validi, chiusura del client e redazione di errori contenenti URI,
token e stack. Lint mirato superato. Nessun accesso remoto o dato operativo è
stato usato in questi test.

## Riproduzione nella stessa postazione

### Letture del registro durante una coorte nightly

Il runtime conserva ora un solo contesto di modelli e report per coorte
nightly: champion C, lista dei candidati C e ultimo report delle precise
versioni A/C sono letti una volta e riutilizzati fra le partite della coorte.
La chiave effettiva è `job.runId`, condivisa dai job della stessa esecuzione;
`beginNightlyCohort` permette anche il reset esplicito di un nuovo tentativo.
Il reset invalida insieme contesto e residui. Anche l'assenza di un report
viene conservata come parte di quel contesto, senza interrogare ripetutamente
il registro per ogni partita.

Questo congela la selezione del modello e la configurazione del report durante
la coorte. Una rotazione del registro viene osservata nella coorte successiva;
la versione e l'hash di configurazione effettivamente usati restano registrati
nelle decisioni. I mercati e gli stati di sicurezza vengono invece riletti per
ogni partita: una sospensione resta efficace, così come i controlli atomici di
lease, kickoff e ammissione nello store. Il percorso storico/T−15 mantiene le
letture precedenti per partita.

Un errore nella lettura di modello/report elimina la promise fallita dalla
cache e consente un nuovo tentativo. Il fallback già esistente al champion,
quando fallisce la lista opzionale dei candidati, rimane disponibile ma non
conserva un contesto degradato per tutta la coorte.

La riduzione verificata è nel numero di letture: due partite della stessa
coorte effettuano una sola `getModels('C')` e una sola lettura del report C;
due coorti effettuano due letture. I payload osservati nel registro sono circa
4,70 MB per il modello e 4,40 MB per il report C: il volume logico di questi
due payload passa da circa 9,1 MB per partita a circa 9,1 MB per coorte in quella configurazione,
escludendo altri report/champion e l'overhead del trasporto. Questa è una stima
dai payload, non una misura dei consumi ufficiali Turso o una garanzia sul
rispetto del limite mensile dell'account. Il normale traffico di query HTTP
libSQL non viene attribuito automaticamente alla voce Turso «Embedded Sync»:
quella categoria è stata verificata per gli export nativi, non per queste query.

`research-nightly-model-context.test.js` verifica i contatori, il reset tra
coorti, i retry dopo errori, il fallback, la sospensione dei mercati, l'identità
delle decisioni con registro invariato e il mancato cambiamento del T−15.

### Prova nativa e runtime senza Python

I file privati del collaudo sono in
`backend/artifacts/backups/personal-migration-20261029/catboost-inference-verification/`:
`verify_native.py`, `artifact.json`, `parity.json`, `native-report.json` e
`node-report.json`. Non sono distribuiti nel repository; non contengono
credenziali, ma modelli e input del confronto rimangono privati.

Da PowerShell nella radice del repository, il confronto nativo già eseguito è
ripetibile con questi file locali e le immagini indicate:

```powershell
$verification = Join-Path (Get-Location) 'backend/artifacts/backups/personal-migration-20261029/catboost-inference-verification'
$database = Join-Path (Get-Location) 'backend/artifacts/backups/personal-migration-20261029/source-2026-10-29T15-17-22-469Z/restore.db'
$distribution = Join-Path (Get-Location) 'backend/dist'
$smoke = Join-Path (Get-Location) 'backend/scripts/research-ml-smoke.js'
docker run --rm --network none --cpus 2 --memory 1g --mount "type=bind,source=$database,target=/input/restore.db,readonly" --mount "type=bind,source=$verification,target=/verification" --mount "type=bind,source=$distribution,target=/app/dist,readonly" --mount "type=bind,source=$smoke,target=/app/scripts/research-ml-smoke.js,readonly" footpredictor-hostless-ml:local sh -c '/opt/ml/bin/python /verification/verify_native.py > /verification/native-report.json && node scripts/research-ml-smoke.js --artifact /verification/artifact.json --parity /verification/parity.json > /verification/node-report.json'
```

Per il runtime senza Python, nello stesso ambiente PowerShell:

```powershell
docker run --rm --network none --cpus 0.25 --memory 256m --mount "type=bind,source=$verification,target=/verification,readonly" footpredictor-nightly-backend:acceptance sh -c 'if command -v python3 >/dev/null || test -x /opt/ml/bin/python || test -x /opt/ml/python; then echo unexpected_python_runtime; exit 1; fi; node scripts/research-ml-smoke.js --artifact /verification/artifact.json --parity /verification/parity.json'
```

Entrambi i comandi usano nuovi container temporanei, nessuna rete e nessun
secret. La preparazione delle immagini è separata dal collaudo: non occorre
installare pacchetti o addestrare modelli durante queste prove.

Il test del workflow/percorso shell eseguito dopo l'audit è
`node --test --test-reporter=spec test/nightly-maintenance.test.js` da `backend`:
4/4 passati, nessun salto, uscita 0. Nessun workflow remoto è stato eseguito o
modificato per aggiungere una dipendenza Python non necessaria.
