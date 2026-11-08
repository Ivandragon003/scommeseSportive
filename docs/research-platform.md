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
| `ml/prepare_refreshed_challenger.py` | Un solo rifit locale a ricetta fissa con piano temporale esplicito, training più recente e calibrazione disgiunta; nessuna ricerca di parametri, registrazione o adozione |
| `ml/prepare_seed_ensemble_challenger.py` | Cinque repliche con seed e pesi fissati nel piano, un solo ensemble delle log-intensità, gate di sviluppo prima di ulteriori diagnostiche; nessuna adozione |
| `research-lifecycle.js finalize-coherent` | Nuovi artefatti locali con calibrazione coerente |
| `research-experiments.js` | Registro diagnostico su SQLite locale esplicito; rifiuta URL remoti |
| `research-lifecycle.js register/register-candidate/review-challenger/rollback-health` | Accede al database e può modificare registro o stato C; la review scientifica conserva il proprio gate |
| `prepare-current-challenger-release.js` | Clona la candidata esatta con metadata di scelta operativa esplicita; non allena e non scrive sul database |
| `replace-current-challenger.js` | Piano senza scritture oppure applicazione esplicita con backup, hash e controllo concorrenza; registra e attiva la sola release corrente |
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

## Preparazione della ricetta e della release

La ricetta di base usa 40 feature, due regressori Poisson, 120 alberi per lato,
profondità 5, learning rate 0,05, seed 20261027, 10 iterazioni Newton, peso ML
0,75 e temperatura 0,8. La release `C-271c9573ba485956` applica inoltre la
proiezione delle foglie descritta sotto e la calibrazione coerente ristimata.
`prepare_current_challenger.py` prepara il fit di base: da solo non riproduce
la release proiettata.

```powershell
python backend/ml/prepare_current_challenger.py --input <nuovo-dataset.json> --split-plan <season-plan.json> --output <nuova-cartella-training>
node backend/scripts/research-lifecycle.js finalize-coherent --artifact <training/artifact.json> --report <training/report.json> --out <nuova-cartella-coerente> --mode isotonic_1x2
node --test backend/test/current-baseline-core.test.js backend/test/current-challenger-release.test.js
```

Il manifest del dataset deve coincidere integralmente con la build corrente;
qualità ed esclusioni vengono ricontrollate. Timestamp e provenienza entrano
nella nuova identità. Conservare dataset, piano, report e artefatti con hash:
non sovrascrivere o rietichettare il file distribuito. I test della release
verificano il JSON canonico in `backend/current-models`, senza registrare nuovi
output. Registrazione, attivazione operativa e review scientifica restano
operazioni distinte.

Un esperimento cambia soltanto il fattore dichiarato, con ricetta, campione e
calibrazione comparabili. `--include-c906-recipe` è un rifit diagnostico
supportato dal trainer controllato: non retrodata un artefatto storico e non
lo rende adottabile.

### Attivazione operativa esplicita

La release `C-271c9573ba485956` deriva dalla candidata esatta
`C-f6d4ac23de48fbfa`: alberi, calibrazione e probabilità restano identici.
`prepare-current-challenger-release.js` richiede sorgente e candidata con gli
hash previsti, controlla la pipeline corrente e scrive un nuovo pacchetto con
identità deterministica e metadata `releaseAdoption`. L'artefatto mantiene
`productionValidated: false` e `independentEvidence: false`. Non è un nuovo fit
e non trasforma una diagnostica in validazione scientifica.

`replace-current-challenger.js` separa piano e applicazione. Prima di scrivere
verifica il backup JSON mirato del registro, hash del piano e stato persistente;
ricontrolla la concorrenza nella transazione. Registra l'evento `ADOPT` con
`candidate_id` nullo ed evidenza `explicit-current-challenger-replacement-v1`:
questa provenienza dichiara la scelta dell'utente senza simulare un GO
prospettico. Lo stato remoto si verifica dopo l'applicazione, non dalla presenza
del JSON nel pacchetto. Procedura nella
[guida hosting](operations/hostless-deployment.md#compatibilità-del-modello-registrato-prima-del-rilascio).

Il pacchetto contiene un solo C. I record storici restano nel database per le
relazioni con giocate ed evidenze, senza ruolo operativo o di rollback.
Tre errori tecnici indipendenti sospendono il nuovo deployment; non riattivano
una release precedente. Le candidature sottoposte a review scientifica mantengono
il gate prospettico descritto sotto.

### Proiezione delle foglie della release corrente

La trasformazione elimina dagli alberi l'effetto diretto di `home_sample` e
`away_sample`, senza rifare il training. Per ogni albero raggruppa le foglie
che differiscono soltanto nelle condizioni dei due contatori e assegna la
media dei valori originali pesata dai supporti del training. I supporti delle
5.293 righe sono verificati contro CatBoost nativo e `leaf_weights`.
I gruppi senza supporto devono avere tutti i valori originali zero; in caso
contrario la preparazione si arresta. Split, scala/bias, altre feature e media
training del contributo di ogni albero restano invariati.

Il preparatore isolato è
[`c-tree-sample-projection/prepare.py`](../backend/experiments/c-tree-sample-projection/prepare.py).
Il valutatore ricostruisce la calibrazione C con lo stesso stimatore e le stesse
358 gare della ricetta di riferimento, usando le probabilità proiettate.
Il profilo A viene mantenuto; la variante dei plateau non viene applicata.
La verifica indipendente controlla supporti, proiezione, parità nativa/TypeScript,
matrici di calibrazione, metriche e invarianza rispetto ai soli contatori.

Conservare il piano e gli input originali congelati per riprodurre l'artefatto;
una nuova build o nuovi dati richiedono un nuovo piano, non la modifica degli
hash di una prova immutabile. Usare cartelle di output inizialmente assenti:

```powershell
python backend/experiments/c-tree-sample-projection/prepare.py --plan <piano-proiezione.json> --out <nuova-preparazione>
node backend/experiments/c-tree-sample-projection/evaluate.cjs --plan <piano-proiezione.json> --prepared <nuova-preparazione> --out <nuova-valutazione>
python backend/experiments/c-tree-sample-projection/verify.py --plan <piano-proiezione.json> --run <nuova-valutazione> --out <nuova-verifica.json>
```

Questi strumenti producono file locali. Non registrano il modello, non cambiano
il deployment, non usano provider o credenziali. La verifica tecnica della
trasformazione non dimostra un beneficio predittivo. Il runtime legge il JSON
canonico già trasformato, senza Python, supporti training o fit durante le
richieste. Il [piano originale](performance/evidence/c-tree-sample-projection-2026-11-08/plan.json)
e la [verifica](performance/evidence/c-tree-sample-projection-2026-11-08/verification.json)
restano prove immutabili con le identità e le restrizioni diagnostiche originarie;
non sono una ricevuta dell'attivazione operativa corrente.

### Evidenza sulla proiezione

Il confronto cronologico applica la stessa regola a cinque coppie di ricette
riaddestrate, una per anno dal 2021 al 2025. I pesi della release corrente non
sono retrodatati. Per ogni fold, il training usa forecast e risultati disponibili
prima del primo marzo; marzo–aprile restano riservati; maggio–giugno calibrano
entrambi i bracci con label disponibili prima del primo luglio. Il test copre
la stagione successiva. I test annuali sono disgiunti; gli esiti possono entrare
nel training degli anni successivi soltanto dopo la disponibilità.

Ogni fold allena una sola coppia di regressori della ricetta fissa; il secondo
braccio ne proietta i valori con i supporti del proprio training. Metodo e gare
di calibrazione coincidono, ma ogni braccio ristima il proprio profilo.
Il dataset intermedio ha 56 variabili: entrambi i modelli selezionano per nome
le stesse 40 feature. La baseline segue il confine Nightly 03:07 Europe/Rome.
Understat è primaria; football-data.co.uk integra soltanto i mancanti e le quote
reali, con matching non ambiguo e provenienza separata. Holdout, quarantena e
ulteriori esclusioni di qualità dello studio restano applicati.

| Misura finale 1X2 | Ricetta di riferimento | Con proiezione |
|---|---:|---:|
| Log Loss | 0,976551 | 0,976116 |
| Brier multiclass | 0,581335 | 0,580939 |
| ECE top-label, 10 fasce | 0,007329 | 0,012342 |

Le 8.541 gare appaiate hanno tutte le stesse quote reali Bet365 di chiusura.
Migliorano LL e Brier in 3/5 leghe (La Liga, Ligue 1 e Premier League), 4/5
finestre e 13/25 celle lega/stagione; Bundesliga è mista e Serie A peggiora.
Gli IC95% descrittivi delle differenze comprendono zero: LL
[−0,001130; +0,000215], Brier [−0,000865; +0,000054]. Il bootstrap appaiato
usa blocchi stagione/settimana UTC, 2.000 repliche e seed 20261108, condizionato
ai modelli già stimati e senza correzione della precedente ricerca.

Sono cinque finestre, non cinque calendari completi: il 2025/26 termina il
4 aprile 2026. Disponibilità kickoff + due ore e archivi acquisiti a posteriori
sono proxy; i prezzi closing non provano la disponibilità Nightly. La regola è
stata scelta su sviluppo già consultato: gli errori medi inferiori non
dimostrano superiorità futura, beneficio stabile nelle cinque leghe o ROI/CLV.
L'adozione operativa è la scelta esplicita dell'utente e non il superamento di
un gate scientifico.

I controlli conservati verificano parità CatBoost nativa su 42.372 righe lungo
i fold, supporti, curve, probabilità e metriche. Le ripetizioni di training e
calibrazione fra anni non sono altrettante partite indipendenti. Queste prove
non sostituiscono i test dell'applicazione.

Dati di prova: [riepilogo e provenienza](performance/evidence/c-five-season-projection-2026-11-08/summary.json),
[confronti stagionali](performance/evidence/c-five-season-projection-2026-11-08/season-comparison.csv),
[confronti lega/stagione](performance/evidence/c-five-season-projection-2026-11-08/season-league-comparison.csv),
[verifica indipendente](performance/evidence/c-five-season-projection-2026-11-08/verification.json).
Per rigenerare il confronto servono gli input locali e i piani con gli hash
originali, oltre agli strumenti in `backend/experiments/c-five-season-projection-research/`:
`build_dataset_v3.cjs`, `freeze_execution.py`, `train.py`, `evaluate.cjs` e
`verify.py`. Il wrapper v3 seleziona il contratto dati corretto; i riepiloghi
versionati non sostituiscono dataset, piani e modelli.

### Altri strumenti di preparazione

- `prepare_refreshed_challenger.py` prepara un solo rifit a ricetta fissa con
  finestre più recenti definite dal piano. Training e calibrazione sono
  disgiunti; un vecchio test usato per calibrare perde il ruolo di test.
- `prepare_seed_ensemble_challenger.py` combina cinque seed e pesi fissati
  prima del fit. La media delle log-intensità è una media geometrica delle
  intensità; non è la media delle probabilità e non seleziona il seed migliore.

Entrambi richiedono piani che leghino hash degli input, riferimento, baseline,
ricetta e partizioni. Non modificano la release corrente. I filtri di sviluppo
vanno rispettati prima delle diagnostiche successive; nessun output locale
costituisce adozione. Esiti e prove degli strumenti sperimentali restano nel
[catalogo](FORMULARIO-scelte-scartate.md#varianti-c-non-adottate), senza creare
una seconda descrizione del modello operativo.

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

### Replay del selettore C con prezzi reali di chiusura

L'[esperimento locale](../backend/experiments/current-c-real-odds-backtest/README.md)
congela dati e identità in sola lettura e applica la matematica corrente di C
ai prezzi closing Bet365 presenti nei CSV verificati. Riusa inferenza,
calibrazione, blending e blocchi effettivi del selettore, con parità contro il
codice operativo e hash degli estratti. Conta tutte le opportunità dinamiche
qualificate, conserva astensioni e verifica gli esiti contro le righe CSV.

È uno scenario retrospettivo, non la riproduzione delle esecuzioni Nightly:
l'orario storico del prezzo non è noto e la creazione dell'artefatto resta
successiva alle partite. Non si inventano timestamp o provenienza `odds_api`.
Restano esclusi target protetti/quarantena e periodi precedenti alla calibrazione
del modello; i test già consultati non diventano indipendenti. I soli mercati
valutabili sono quelli con prezzi reali presenti nel CSV. Il replay non cambia
modello, soglie, registro o portafogli e non dimostra redditività reale.

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
