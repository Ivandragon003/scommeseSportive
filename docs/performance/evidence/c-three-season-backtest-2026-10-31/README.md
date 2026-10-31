# Input e comandi riproducibili del backtest C su tre stagioni

Eseguire dalla radice del repository. Usare nomi nuovi per tutti gli output. Ripristino, pianificazione, audit ed evaluate rifiutano destinazioni esistenti; il trainer può invece sovrascrivere file nella cartella indicata. I comandi non caricano `.env`, non contattano provider e non aprono il database produttivo. Python 3.11+ basta per il ricalcolo; Node e backend compilato servono per il replay. Il riaddestramento richiede le dipendenze di `backend/ml/requirements.txt`, incluso CatBoost 1.2.8.

## 1. Ricalcolo indipendente delle metriche già pubblicate

```powershell
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-three-season-backtest-2026-10-31/predictions --out backend/artifacts/research/three-seasons-metrics-recheck --expected-records 6573 --expected-cohort 4892 --expected-reconstructed 0 --gzip
python backend/scripts/compare-challenger-audit-bundles.py --before docs/performance/evidence/c-data-audit-2026-10-31/after --after docs/performance/evidence/c-three-season-backtest-2026-10-31/predictions --out backend/artifacts/research/three-seasons-common-recheck.json --common-only
python backend/scripts/summarize-challenger-seasons.py --before docs/performance/evidence/c-data-audit-2026-10-31/after --after docs/performance/evidence/c-three-season-backtest-2026-10-31/predictions --out backend/artifacts/research/three-seasons-summary-recheck.json
```

Attesi: audit PASS; 6.573 record; sette procedure su 4.892 identici target; intersezione di 1.959 incontri; 10 ID solo nel vecchio test e 2.933 solo nel nuovo; baseline raw no-ML identica. Il conteggio zero C906 ricostruito è esplicito perché questo periodo termina prima del 2026/27 e mantiene le esclusioni originali. Non usare `--generic` per aggirare i controlli.

## 2. Ripristino byte per byte e replay degli artefatti

```powershell
python backend/scripts/restore-challenger-season-inputs.py --out backend/artifacts/research/three-seasons-replay
npm --prefix backend run build
node backend/scripts/research-challenger-development.js evaluate --dataset backend/artifacts/research/three-seasons-replay/nightly-extended-canonical.json --plan backend/artifacts/research/three-seasons-replay/comparison-plan.json --variants backend/artifacts/research/three-seasons-replay/comparison-canonical-inputs/variants.json --out backend/artifacts/research/three-seasons-replay/comparison.json --markdown backend/artifacts/research/three-seasons-replay/comparison.md
python backend/scripts/audit-challenger-metrics.py --report backend/artifacts/research/three-seasons-replay/comparison.json --out backend/artifacts/research/three-seasons-replay/audit --expected-records 6573 --expected-cohort 4892 --expected-reconstructed 0 --gzip
```

Il ripristino controlla [bundle-files.json](bundle-files.json), hash compressi e decodificati, e tutti i 42 membri dei sei archivi `evaluation-fold-*.tar.gz`. Rifiuta percorsi inattesi, link, duplicati e destinazioni esistenti. C906 e l'archivio originale provengono dai gzip già pubblicati nella cartella sorella `c-data-audit-2026-10-31`; non sono modelli sintetizzati. Un `restore-manifest.json` registra i 48 payload ripristinati, compresi i 42 controlli per fold e il C906 autentico.

SHA256 del JSONL decodificato di tutte le previsioni atteso:
`559a079f613e12bbf5fdd05c21b1abea17ed94019cfadbcefd77ac6de7a7c216`.
Il report intero cambia per percorsi e comandi di provenienza; la verifica confronta le singole previsioni. Non avviare build o pulizia di `dist` mentre il valutatore è in esecuzione: legge gli hash delle implementazioni.

## 3. Nuovo training sul medesimo dataset congelato

Dopo il ripristino precedente, usando altri nomi di output:

```powershell
python backend/scripts/plan-challenger-seasons.py --dataset backend/artifacts/research/three-seasons-replay/nightly-extended-canonical.json --matches backend/artifacts/research/three-seasons-replay/matches.json --out backend/artifacts/research/three-seasons-replay/plan-regenerated.json
python backend/ml/train.py --input backend/artifacts/research/three-seasons-replay/nightly-extended-canonical.json --output backend/artifacts/research/three-seasons-replay/training-retrained --experiment controlled-challenger --iterations 120 --depth 3 --folds 6 --split-plan backend/artifacts/research/three-seasons-replay/season-plan.json --include-c906-recipe
node backend/scripts/prepare-challenger-comparison.js --training backend/artifacts/research/three-seasons-replay/training-retrained --dataset backend/artifacts/research/three-seasons-replay/nightly-extended-canonical.json --incumbent backend/artifacts/research/three-seasons-replay/comparison-canonical-inputs/incumbent.json --incumbent-registry docs/performance/evidence/c-data-audit-2026-10-31/actual-c906-registry.json --out backend/artifacts/research/three-seasons-replay/retrained-inputs
node backend/scripts/research-challenger-development.js evaluate --dataset backend/artifacts/research/three-seasons-replay/nightly-extended-canonical.json --plan backend/artifacts/research/three-seasons-replay/comparison-plan.json --variants backend/artifacts/research/three-seasons-replay/retrained-inputs/variants.json --out backend/artifacts/research/three-seasons-replay/retrained-comparison.json --markdown backend/artifacts/research/three-seasons-replay/retrained-comparison.md
python backend/scripts/audit-challenger-metrics.py --report backend/artifacts/research/three-seasons-replay/retrained-comparison.json --out backend/artifacts/research/three-seasons-replay/retrained-audit --expected-records 6573 --expected-cohort 4892 --expected-reconstructed 0 --gzip
```

Il piano rigenerato deve avere SHA256 `b44a3a2e893b973ee726b42dfa588536ee90db5ecee41dbc5b591dd8a4ac1c6d`. Il dataset deve avere SHA256 `b9de693888d5ba5f982bd4cd7d38515ec547c306aacd1371f38a7edd021b64e2`. Il suo gzip e quello del piano conservano i byte anche con checkout Git CRLF.

Il file `trainer-source.py.gz` conserva anche gli esatti byte del trainer usato, con hash decodificato in `execution-verification.json`, inclusi i terminatori Windows.

Il training rieseguito produce nuove date di creazione e può avere identità diverse se cambiano byte o terminatori del trainer. I modelli JSON contengono inoltre metadati CatBoost di esecuzione: non si richiede l'uguaglianza byte per byte di nuovi artefatti. Confrontare probabilità e metriche a tolleranza dichiarata, oltre a feature, iperparametri e membership delle finestre. Il replay degli artefatti congelati del punto 2 verifica invece le stesse identiche previsioni.

[training-metadata.json](training-metadata.json) è una proiezione dichiarata del report originale: contiene tutti i sei fold, i sette controlli e i loro parametri, escludendo le matrici duplicate delle 4.892 righe. Hash e numero del report originale sono conservati; il file non è presentato come quel report integrale.

## 4. Test del codice

```powershell
python -m unittest discover -s backend/ml/tests -p 'test_*.py'
npm --prefix backend run typecheck
npm --prefix backend run lint
node --test backend/test/operational-a-regression.test.js backend/test/challenger-adoption.test.js backend/test/research-lifecycle.test.js backend/test/challenger-comparison-preparation.test.js backend/test/challenger-development.test.js backend/test/challenger-runtime-integration.test.js backend/test/challenger-selection.test.js backend/test/challenger-data-contract.test.js backend/test/challenger-data-quality.test.js backend/test/calibration-deployment.test.js
```

Usare il backend compilato nel punto 2 prima dei test Node. [execution-verification.json](execution-verification.json) distingue esecuzione iniziale, ricalcolo Python, replay dei file pubblicati e CI GitHub. [Report](../../c-three-season-backtest-2026-10-31.md) per metodo e limiti. I due bootstrap, Node e Python, usano generatori distinti: i loro intervalli non sono identità binarie né prove indipendenti della bontà di C.
