# Strumenti ML del modello C

Trainer CatBoost, diagnostica e test offline. Il backend operativo legge modelli
numerici JSON in TypeScript: non richiede Python o CatBoost nativo.

Riferimenti canonici:

- [Modello C](../../docs/models/MODEL-C.md): input, inferenza e registro.
- [Research](../../docs/research-platform.md): partizioni temporali, comandi, calibrazione,
  metriche, dati di riproduzione e confini delle scritture.
- [Scelte scartate](../../docs/FORMULARIO-scelte-scartate.md): esperimenti falliti
  e applicabilità al modello corrente.

## Ambiente e controlli

Dalla radice del repository:

```powershell
python -m pip install -r backend/ml/requirements.txt
python -m unittest discover -s backend/ml/tests -p "test_*.py"
npm --prefix backend run build
node --test backend/test/research-catboost.test.js backend/test/research-forecast.test.js backend/test/research-coherent-pipeline.test.js backend/test/operational-a-regression.test.js
```

## Release corrente

La release [C-271c9573ba485956](../current-models/challenger.json) usa la baseline
`A-9227e65a047783bd`, 40 feature, due regressori Poisson con 120 alberi di
profondità 5 e 10 iterazioni Newton, peso ML 0,75 e temperatura 0,8.
I valori delle foglie sono proiettati per eliminare l'effetto diretto dei due
contatori di storico, usando soltanto i supporti delle 5.293 righe di training.
La calibrazione C è ristimata sulle 358 gare dedicate con lo stesso metodo.
Il runtime legge i valori già trasformati dal JSON canonico.

La proiezione è una scelta operativa esplicita dell'utente; il backtest su
8.541 gare non dimostra superiorità futura: migliorano le metriche primarie
in 3/5 leghe e 4/5 finestre, peggiora ECE aggregata e gli intervalli comprendono
zero. [Meccanismo e limiti](../../docs/models/MODEL-C.md).
La presenza del file non prova registrazione o uso remoto.

Il trainer richiede CatBoost 1.2.8; i requisiti includono il database dei fusi
orari necessario su Windows. `npm test` backend comprende già la build. Un test
nativo saltato perché Python non è configurato non equivale a training verificato.
Il target Docker `ml-verification` usa
[requirements-linux-verification.txt](requirements-linux-verification.txt):
verifica parità Python/TypeScript senza attivare modelli o modificare portafogli.

Tenere gli output sotto `backend/artifacts/` o in una destinazione esplicita,
separati da sorgenti e dati produttivi. Il training non registra modelli.

## Strumenti e riproduzione

| Strumento | Responsabilità |
|---|---|
| `train.py` | Fit controllati CatBoost e artefatti locali |
| `prepare_current_challenger.py` | Ricetta di base fissa sull'ultimo fold congelato; da sola non riproduce la proiezione |
| `../experiments/c-tree-sample-projection/prepare.py` | Proiezione dei valori originali usando i supporti del training |
| `../experiments/c-tree-sample-projection/evaluate.cjs` | Ristima del profilo coerente e diagnostica appaiata |
| `../experiments/c-tree-sample-projection/verify.py` | Verifica indipendente di supporti, valori, calibrazione e metriche |
| `prepare_refreshed_challenger.py` | Rifit a ricetta fissa con finestre di training e calibrazione aggiornate |
| `prepare_seed_ensemble_challenger.py` | Aggregazione di seed e pesi prefissati, con gate di sviluppo |

Piani, prerequisiti e comandi sono in
[Research](../../docs/research-platform.md#preparazione-della-ricetta-e-della-release).
Le prove degli altri esperimenti sono nel
[catalogo](../../docs/FORMULARIO-scelte-scartate.md#varianti-c-non-adottate).
Le evidenze immutabili mantengono identità e restrizioni originarie; non vengono
riscritte per rappresentare l'attivazione operativa. Per riprodurre un artefatto
servono anche dataset, modelli e input locali con gli hash del piano: i soli
riepiloghi non bastano.

## Refit per una nuova baseline condivisa

Conservare la precedente sorgente/build e congelare un file di partite con hash,
cutoff e piano temporale espliciti. Ricostruire prima i dataset di entrambe le
build sugli stessi input e confrontare tutte le righe, incluse le partizioni di
training e calibrazione. Non riusare vecchi pesi cambiando `baselineVersion`.

Nella build verificata della nuova baseline, dalla radice del repository:

```powershell
node backend/scripts/build-challenger-dataset-parallel.js --matches INPUT_MATCHES.json --asof CUTOFF_ISO --out backend/artifacts/dataset-new.json --workers 2
python backend/ml/prepare_current_challenger.py --input backend/artifacts/dataset-new.json --split-plan SPLIT_PLAN.json --output backend/artifacts/refit-new
node backend/scripts/research-lifecycle.js finalize-coherent --artifact backend/artifacts/refit-new/artifact.json --report backend/artifacts/refit-new/report.json --out backend/artifacts/coherent-new --mode isotonic_1x2
```

I percorsi di output devono essere nuovi. Il trainer richiede CatBoost 1.2.8,
manifest coincidente con la build, policy di qualità e zero righe del holdout
protetto. Usa l'ultimo fold congelato, ricetta fissa, selezione riservata e
calibrazione separata; non cerca nuovi parametri sul test. Conservare dataset,
piano, report e artefatti con i rispettivi hash. Verificare anche l'inferenza JSON
TypeScript rispetto a CatBoost nativo prima del rilascio. Diagnostica storica,
registrazione del pacchetto e adozione scientifica sono operazioni distinte.
