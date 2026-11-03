# Esperimento offline TimesFM 2.5 per C

Questo percorso non viene importato dal backend operativo. Non accede al database,
non registra candidati e non modifica A, C, scheduler o dipendenze produttive.
Le dipendenze sono esclusivamente di ricerca. Il checkpoint Google 2.5 e il
pacchetto TimesFM sono Apache-2.0; non viene usata la versione 3.0.

Il [protocollo congelato](protocol.json) precede le nuove inferenze e i risultati.
Si riprendono dataset e finestre del benchmark sulle tre stagioni, già consultato:
questa è una valutazione retrospettiva di sviluppo, non una conferma indipendente.
Il controllo è la ricetta C906 riaddestrata per semestre; C906 autentico non
esisteva nel periodo e non viene retrodatato.

## Riproduzione completa

Dalla radice del repository, PowerShell, Python 3.12 e Node 20+:

```powershell
uv venv --python 3.12 backend/artifacts/research/timesfm-replay-env
uv pip install --python backend/artifacts/research/timesfm-replay-env/Scripts/python.exe -r backend/ml/experiments/timesfm_xg/requirements-lock.txt --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
python backend/scripts/restore-challenger-season-inputs.py --out backend/artifacts/research/timesfm-replay-inputs
npm --prefix backend ci
npm --prefix backend run build
backend/artifacts/research/timesfm-replay-env/Scripts/python.exe -m unittest discover -s backend/ml/experiments/timesfm_xg -p "test_*.py"
backend/artifacts/research/timesfm-replay-env/Scripts/python.exe backend/ml/experiments/timesfm_xg/features.py --dataset backend/artifacts/research/timesfm-replay-inputs/nightly-extended-canonical.json --matches backend/artifacts/research/timesfm-replay-inputs/matches.json --out backend/artifacts/research/timesfm-replay-features --cache backend/artifacts/research/timesfm-checkpoint-cache
backend/artifacts/research/timesfm-replay-env/Scripts/python.exe backend/ml/experiments/timesfm_xg/benchmark.py train --dataset backend/artifacts/research/timesfm-replay-inputs/nightly-extended-canonical.json --plan backend/artifacts/research/timesfm-replay-inputs/season-plan.json --features backend/artifacts/research/timesfm-replay-features/features.json --out backend/artifacts/research/timesfm-replay-results
node --test backend/test/operational-a-regression.test.js
```

Tutte le destinazioni di output devono essere nuove. Il download anonimo del
checkpoint pubblico usa la revisione fissata nel protocollo; non richiede token,
abbonamenti o API a pagamento. La build deve terminare prima del benchmark:
non ricompilare o pulire `dist` mentre la calibrazione lo sta leggendo.
Su Linux usare `bin/python` al posto di `Scripts/python.exe`.
Il lock fotografa l'ambiente Windows CPU misurato; la parità numerica tra sistemi
diversi va verificata, non assunta. Le probabilità C di riferimento devono
coincidere con quelle pubblicate entro `1e-12` su tutti i 4.892 target.

## Ricalcolo rapido delle metriche pubblicate

Non richiede Torch, TimesFM, rete o backend compilato; richiede NumPy e CatBoost
per importare le funzioni comuni del trainer. Nel codice non viene addestrato
alcun modello in questa modalità:

```powershell
python backend/ml/experiments/timesfm_xg/benchmark.py analyze --predictions docs/performance/evidence/timesfm-c-2026-11-03/predictions.jsonl.gz --out backend/artifacts/research/timesfm-metrics-replay
```

Il JSON prodotto conserva metriche aggregate e per lega, stagione e fold,
intervalli appaiati, intervalli assoluti e sensibilità a quattro settimane.
Il bootstrap ricalcola ECE su ogni campione. Gli intervalli sono condizionati
ai modelli già stimati: non includono la variabilità di nuovi fit o del pretraining.
I file pubblicati e i controlli conclusivi sono descritti nel
[report](../../../../docs/performance/timesfm-c-2026-11-03.md).
