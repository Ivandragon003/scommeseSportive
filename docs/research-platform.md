# Ricerca e validazione del modello C

Questa guida descrive strumenti e protocollo del repository. L'algoritmo è nel
[modello C](models/MODEL-C.md); gli esperimenti falliti sono nel
[catalogo](FORMULARIO-scelte-scartate.md). La baseline research è una
ricostruzione cronologica basata sui componenti correnti di A, non una replica
dell’intero A operativo. Training, valutazione, registrazione e adozione sono
operazioni diverse.

## Confini dei comandi

| Strumento | Effetto |
|---|---|
| `research.js export` | SELECT sul database configurato; esporta senza bootstrap applicativo |
| `research-challenger-development.js dataset/evaluate` | File locali; nessun provider, database o adozione |
| `ml/train.py` | Fit CatBoost e output locali; non registra modelli |
| `ml/prepare_current_challenger.py` | Un solo rifit locale della ricetta corrente, su input e ultimo fold congelato verificati; nessuna registrazione |
| `research-lifecycle.js finalize-coherent` | Nuovi artefatti locali con calibrazione coerente |
| `research-experiments.js` | Registro diagnostico su SQLite locale esplicito; rifiuta URL remoti |
| `research-lifecycle.js register/register-candidate/review-challenger/rollback-health` | Accede al database e può modificare registro o deployment C |
| `research.js register-market` | Registra benchmark e stato del mercato sul database |
| `enable-challenger-team-markets.js` | Piano in sola lettura; applicazione esplicita e separata per registrare i mercati C mancanti come sperimentali |

Le scritture non sono passaggi impliciti di un benchmark locale. Il workflow
[research-training.yml](../.github/workflows/research-training.yml) contiene passi
separati, subordinati a `RESEARCH_REGISTRY_WRITES_ENABLED`. La configurazione non
dimostra che l'ultimo training o l'adozione siano riusciti.

## Copertura squadra C e registro di ricerca

La composizione `c-team-markets-v1` riguarda la release corrente con selettore
canonico e mantiene distinta la configurazione gol C dallo specialista A per
le statistiche. Per le nuove policy della release corrente i mercati supportati
sono definiti dal codice, con `marketEligibilityVersion=code-supported-markets-v1`.
Il registro qualitativo non determina più l'operatività C corrente e l'interfaccia
mostra il modello e le misure disponibili, senza badge di certificazione.
Quote reali, campioni e calibrazione restano necessari; le categorie bloccate
rimangono tali. Vedi [Modello C](models/MODEL-C.md).

I comandi seguenti restano per compatibilità degli studi e delle policy precedenti;
non servono ad abilitare i mercati delle nuove policy C correnti e non promuovono
automaticamente la release.

Compilare il backend, configurare nell'ambiente privato l'URL canonico e il
solo `TURSO_WATCHDOG_READONLY_TOKEN`, quindi eseguire da `backend`:

```powershell
node scripts/enable-challenger-team-markets.js
```

Il piano mostra versione, hash modello e schema, stati correnti, mercati mancanti
e hash del piano. Non avvia l'applicazione né scrive sul database. Per applicare
serve una **autorizzazione distinta**, dopo aver verificato il piano e creato un
[backup completo con restore verificato](operations/turso-backup.md). Con il
token di scrittura nell'ambiente privato, il comando esplicito è:

```powershell
node scripts/enable-challenger-team-markets.js --apply --expected-plan-hash <hash-del-piano> --backup-manifest <percorso-manifest.json>
```

Il comando verifica host, hash di dump e restore, schema, modello e snapshot del
registro; ricalcola il piano in transazione e si arresta se è cambiato. Inserisce
solo i mercati mancanti come `EXPERIMENTAL` e aggiunge gli eventi corrispondenti;
non sovrascrive stati esistenti né riattiva `SUSPENDED`. Nessun backup o comando
di applicazione è implicito nel piano o nella presenza dello script.

## Dati ammessi e cronologia

- Escludere dai target i 745 ID della
  [policy holdout](../backend/src/research/original-holdout-policy.json), già
  consultati. Non diventano indipendenti cambiando il nome del run.
- Applicare la [quarantena C](../backend/src/research/challenger-data-quarantine.json)
  a target e storia prima della ricostruzione della baseline C. I 22 ID della
  policy attuale non vanno corretti automaticamente o reinseriti.
- Le nuove feature C escludono i protetti anche dalla propria storia. La
  baseline può usare risultati protetti come passato quando disponibili secondo
  il proprio contratto cronologico.
- La disponibilità storica è almeno kickoff + due ore, posticipata da
  `availableAt` quando presente. È un proxy, non una ricevuta di pubblicazione
  delle statistiche né una garanzia contro revisioni del provider.
- Il builder controllato ricostruisce il forecast al confine Nightly nominale
  03:07 Europe/Rome prima del kickoff, inclusa l'ora legale. Non rietichetta un
  vecchio dataset T−15. Run realmente registrati conservano il proprio timestamp.

Training, selezione, calibrazione e test sono separati. Le etichette devono
essere disponibili prima della fase successiva. Il piano congelato mantiene
finestre e appartenenza; i test dei fold sono disgiunti. Un risultato test può
entrare nel training di un fold successivo dopo la disponibilità, ma lo studio
complessivo rimane sullo stesso storico già osservato.

## Preparare un confronto locale

Servono backend compilato e, per il training, Python con
[requirements.txt](../backend/ml/requirements.txt), incluso CatBoost 1.2.8.
Usare destinazioni nuove: non tutti gli strumenti impediscono sovrascritture.
Non ricompilare o pulire `dist` mentre dataset o valutatore leggono gli hash.

```powershell
npm --prefix backend ci
npm --prefix backend run build
python -m pip install -r backend/ml/requirements.txt
```

Da un export congelato e un cutoff esplicito, usando il builder del workflow:

```powershell
node backend/scripts/build-challenger-dataset-parallel.js --matches <matches.json> --asof <cutoff-UTC> --out <nuovo-dataset.json> --workers 2
python backend/ml/train.py --input <nuovo-dataset.json> --output <nuova-cartella-training> --experiment controlled-challenger --iterations 120 --depth 3 --folds 3
node backend/scripts/research-lifecycle.js finalize-coherent --artifact <training/artifact.json> --report <training/report.json> --out <nuova-cartella-coerente> --mode isotonic_1x2
```

Sostituire i segnaposto con percorsi propri. Il percorso legacy `research.js
dataset` costruisce input research T−15 e non sostituisce il builder Nightly.
I bracci controllati sono dichiarati nel trainer; scelta e risultati di sviluppo
non costituiscono adozione.

Il percorso ripetibile della release corrente usa invece una sola ricetta
fissa e l'ultimo fold del piano già congelato, senza selezionare iperparametri:

```powershell
python backend/ml/prepare_current_challenger.py --input <nuovo-dataset.json> --split-plan <season-plan.json> --output <nuova-cartella-training>
node backend/scripts/research-lifecycle.js finalize-coherent --artifact <training/artifact.json> --report <training/report.json> --out <nuova-cartella-coerente> --mode isotonic_1x2
node --test backend/test/current-baseline-core.test.js backend/test/current-challenger-release.test.js
```

Il manifest del dataset deve coincidere integralmente con la build corrente;
la qualità e le esclusioni vengono ricontrollate. Timestamp e provenienza
entrano nella nuova identità: un rifit non deve sovrascrivere o rietichettare
l'artefatto distribuito. I test della release verificano il file canonico in
`backend/current-models`, non registrano il nuovo output. Registrazione,
adozione, deploy e validazione prospettica restano passaggi separati.

Un nuovo esperimento deve cambiare soltanto il fattore dichiarato, mantenendo
ricetta, condizioni, campione e calibrazione comparabili. Cambiare insieme
feature, modello, peso e temperatura non isola l'effetto della feature.
`--include-c906-recipe`, disponibile con piano congelato, è un rifit diagnostico:
non retrodata C906, non partecipa alla selezione e non è registrabile per l'adozione.

## Verificare gli archivi operativi prima di un backtest

L'[audit degli archivi A/C](../backend/experiments/c-team-markets/README.md)
esporta soltanto evidenze calcistiche da un backup locale verificato, aperto in
sola lettura. Controlla identità delle release, tempi delle previsioni, quote
reali complete e coerenti, disponibilità delle statistiche e liquidazione.
Non addestra modelli e non scrive sul database o sul registro.

Questo strumento misura la possibilità di riprodurre gli archivi, non esegue un
backtest completo del modello corrente su tutte le partite storiche. Una
previsione di una vecchia versione non diventa della versione corrente cambiando
identificativo. La sola cache delle quote non ricostruisce gli input storici di
A e C. Il packet A conserva solo le prime opportunità ordinate: non dimostra
la completezza delle opportunità statistiche per ogni scheda bookmaker.

Le eventuali coppie di giocate riproducibili sono diagnostiche: non includono
l'intera coorte e le astensioni. Non producono un ROI comparativo delle strategie.
Con nessuna coppia valida il risultato è dati insufficienti, non rendimento zero.
Per un confronto economico servono una coorte fissata prima della selezione,
input cronologici ricostruibili per entrambi i modelli, tutte le astensioni e
le stesse quote realmente disponibili all'istante scelto.

Le quote normalizzate come tiri senza una prova indipendente del mercato
originario del provider sono escluse. Una linea elevata di `totals` o
`alternate_totals` non dimostra che il prezzo riguardi i tiri. L'audit non
corregge il mapping operativo né convalida automaticamente gli archivi legacy.

## Metriche e decisione

Confrontare sulle stesse partite Log Loss, Brier, ECE e accuracy, per lega e
periodo. Specificare ECE e scala del Brier; non mescolare ECE top-label e
classwise. Usare differenze e intervalli appaiati con blocchi temporali,
dichiarando seed, numerosità, confronti multipli e variabilità non inclusa.
La mancata significatività non prova equivalenza.

La misura deve attraversare calibrazione e blending applicabili al percorso
valutato. Senza quote reali disponibili al forecast non simulare blending Nightly
né dichiarare ROI, CLV o drawdown validati. Quote closing successive e prezzi
completati dal modello non sono disponibili nel passato. Astensioni e partite
senza puntata restano nel confronto probabilistico; non usare soltanto sconfitte
o giocate consigliate.

Il registro congela candidato, riferimento, configurazione e policy. Il giudizio
prospettico usa i primi 500 `FUTURE_TEST` preregistrati, almeno quattro leghe,
quattro mesi e quattro periodi, con intervalli, calibrazione e stabilità previsti
dal codice. `CALIBRATION` è separata. La valutazione è unica: un NO-GO non
autorizza ritentativi sullo stesso campione fino a ottenere un esito favorevole.
Contratto: [ChallengerAdoption.ts](../backend/src/research/ChallengerAdoption.ts).

## Asset di prova conservati

Queste directory sono dati di riproduzione, non guide operative alternative o
una misura corrente delle prestazioni del sito:

- [Bundle C a tre stagioni](performance/evidence/c-three-season-backtest-2026-10-31/README.md):
  dataset, finestre e probabilità salvate del replay.
- [Audit dei dati C](performance/evidence/c-data-audit-2026-10-31/README.md):
  sorgenti dati, dossier qualità e prove delle esclusioni.
- [Retest delle scelte scartate](performance/retest-discarded-2026-10-03/README.md):
  risultati e metadati del catalogo delle decisioni.

I nomi datati identificano dati storici. I percorsi nei JSON descrivono la
provenienza dello studio. I pesi e il codice eseguibile storici sono rimossi:
le predizioni salvate e le loro metriche restano consultabili, ma non è possibile
rigenerare quelle previsioni senza i pesi eliminati.

Ripristino e ricalcolo senza provider, credenziali o scritture sul database:

```powershell
python backend/scripts/restore-challenger-season-inputs.py --out backend/artifacts/research/replay-c
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-three-season-backtest-2026-10-31/predictions --out backend/artifacts/research/replay-c-metrics --expected-records 6573 --expected-cohort 4892 --expected-reconstructed 0 --gzip
```

Il ripristino estrae sette file di dati, non i pesi dei modelli. Gli output devono
essere nuovi. Rileggere le fonti via HTTP è un'acquisizione
diversa dal riprodurre l'archivio: non prova la prima disponibilità storica.
## Controlli tecnici

Il [README ML](../backend/ml/README.md) indica i test. Le fixture
[A operativo](../backend/test/fixtures/operational-a/README.md) proteggono sorgenti
e output A. Conservare schema libSQL, payload e identità; non aggiornare policy,
golden o calibrazioni per rendere ammissibile un candidato.

### Modifiche al nucleo condiviso A/C

Il calcolo di base passa da `SharedForecastCalculator`: la previsione A, la sua
calibrazione storica, il backtest e `ForecastCore` usano gli stessi stadi. Il
manifest della baseline include questo servizio e le sue dipendenze matematiche.
La condivisione del codice non autorizza a usare pesi CatBoost incompatibili.

Prima del refactor conservare sorgente, build, manifest e artefatto precedenti.
Ricostruire le due baseline sullo stesso file di partite, con cutoff, policy di
qualità, holdout e piano temporale identici. Confrontare tutte le righe e gli
input consumati: identità, tempi, feature, intensità, probabilità e matrici,
anche nei periodi di training e calibrazione. I test del calcolatore coprono
anche contesto, dipendenza dei punteggi, partner assente e ordine degli stadi.
La parità A grezza non dimostra parità dell'intera selezione con stato e quote.

Se gli input C cambiano o manca il dataset originale per provarne l'identità,
`prepare_current_challenger.py` esegue un nuovo fit con ricetta e partizioni
fisse; `finalize-coherent` produce separatamente la nuova calibrazione e
identità. Conservare i file di input, i loro hash, il manifest completo, il piano
e gli output di training. Non modificare in posto un vecchio artefatto.
Un test storico già consultato resta diagnostico e non può produrre un GO
prospettico, ROI senza quote reali o adozione automatica.

La registrazione del nuovo pacchetto e il suo deploy richiedono le operazioni
esplicite previste, con backup verificato. Il registro di adozione conserva
precedenza sul fallback; gli eventi e le evidenze precedenti non vengono
riscritti. Dopo il deploy controllare anche la cache di calibrazione A: il suo
hash comprende il codice compilato e può cambiare pur con output numerici
identici. Usare preflight e preparazione cache separata descritti nelle guide
operative, senza disabilitare la verifica di compatibilità.

## Confrontare i kernel correnti con A80

Gli strumenti in `backend/experiments/c-current-baseline/` confrontano la
ricostruzione storica con i componenti matematici correnti, mantenendo dati,
orari e protocollo di fit e verificando i riferimenti contro il dataset.
Richiedono una sorgente storica esterna esplicita tramite `--reference-source`:
non esiste una copia eseguibile storica inclusa, un default o un ripristino
automatico da Git. Sono esperimenti locali: non usano credenziali, provider,
database o registro di adozione.

Questo confronto riguarda un'approssimazione dello stadio grezzo. Non è una
replica storica completa di `PredictionService`: parametri, stato, calibrazione,
rose e quote realmente disponibili al forecast devono essere ricostruiti
separatamente. La matrice congiunta della baseline è anch'essa una ricostruzione,
non la prova di equivalenza di tutti i mercati dell'app.

`kernel-replay.js` richiede `--reference-source`, `--matches`, `--dataset` e un nuovo `--out`.
`--competition` permette di suddividere il lavoro per campionato; `--limit`
produce esplicitamente una prova parziale. Non ricompilare `dist` durante il
replay. Il successivo `score-replay.js` richiede tutti i frammenti in
`--replays` separati da virgole, lo stesso `--reference-source`, il `--dataset` canonico, il `--comparison`
di riferimento, la cartella `--artifacts` dei modelli per fold e una nuova
cartella `--out`.

Il riuso delle repliche CatBoost e delle rispettive calibrazioni è consentito
solo dopo aver dimostrato l'identità numerica di tutti gli input da esse
consumati, anche nei periodi di training e calibrazione. Un cambiamento richiede
un nuovo fit isolato per fold: il valutatore non lo sostituisce con un cambio
di etichetta della baseline. Le repliche storiche non sono l'artefatto C906
operativo retrodatato e non costituiscono una candidatura o una conferma
indipendente. Senza quote ammissibili il confronto non misura ROI o CLV.

Controlli mirati, dopo la build centrale:

```powershell
node --test backend/experiments/c-current-baseline/kernel-replay.test.js backend/experiments/c-current-baseline/score-replay.test.js
```
