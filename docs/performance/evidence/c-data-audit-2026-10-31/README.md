# Evidenze riproducibili dell'audit C

Il [report](../../c-data-benchmark-audit-2026-10-31.md) distingue correttezza aritmetica, conflitti del calendario e limiti della disponibilità storica. Questi file non certificano un miglioramento o un ROI.

## Ricalcolo senza database, rete o librerie ML

`before/` conserva le 6.587 righe originali, con 1.975 test per ciascuna delle sei varianti. `after/` conserva 6.573 righe ricostruite, con 1.969 test per variante. Ogni bundle contiene manifest, predizioni JSONL compresse e audit. SHA256 e lunghezza coprono il contenuto JSONL decompresso; gzip è deterministico. Il ricalcolo è Python standard library.

```powershell
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-data-audit-2026-10-31/before --out backend/artifacts/research/audit-replay-before --gzip
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-data-audit-2026-10-31/after --expected-records 6573 --expected-cohort 1969 --out backend/artifacts/research/audit-replay-after --gzip
python backend/scripts/compare-challenger-audit-bundles.py --before docs/performance/evidence/c-data-audit-2026-10-31/before --after docs/performance/evidence/c-data-audit-2026-10-31/after --out backend/artifacts/research/audit-replay-common.json
```

La modalità rigorosa mantiene i controlli di identità dei sei campioni e i ruoli C906. Non usare `--generic` per aggirare una coorte inattesa. Tutti gli output devono essere nuovi.

## Ricostruzione e nuovo training

Ambiente del confronto eseguito: Python 3.12, CatBoost 1.2.8, NumPy 2.4.2, Node 24; la CI usa Node 20. Compilare **prima** del replay: non eliminare o ricompilare `backend/dist` durante dataset/evaluate, che leggono gli hash delle implementazioni congelate.

I gzip contengono JSON fattuali/artefatti, non credenziali: archivio partite congelato, riferimento squadre e C906 esatto. Il registro C906 è ridotto ai campi necessari per verificare modello, hash, configurazione e disponibilità. `frozen-split-plan.json` conserva tutti i confini originali delle quattro finestre dei tre fold.

```powershell
npm --prefix backend run build
python -c "import gzip,pathlib; p=pathlib.Path('docs/performance/evidence/c-data-audit-2026-10-31'); o=pathlib.Path('backend/artifacts/research/audit-reproduction'); o.mkdir(parents=True,exist_ok=False); [(o/name).write_bytes(gzip.decompress((p/src).read_bytes())) for src,name in [('matches-frozen.json.gz','matches.json'),('actual-c906-artifact.json.gz','actual-c906-artifact.json'),('teams-reference.json.gz','teams.json')]]"
node backend/scripts/build-challenger-dataset-parallel.js --matches backend/artifacts/research/audit-reproduction/matches.json --asof 2026-10-30T23:49:05.257Z --out backend/artifacts/research/audit-reproduction/nightly-extended-canonical.json --workers 5
python backend/ml/train.py --input backend/artifacts/research/audit-reproduction/nightly-extended-canonical.json --output backend/artifacts/research/audit-reproduction/training-canonical --experiment controlled-challenger --iterations 120 --depth 3 --folds 3 --split-plan docs/performance/evidence/c-data-audit-2026-10-31/frozen-split-plan.json
node backend/scripts/prepare-challenger-comparison.js --training backend/artifacts/research/audit-reproduction/training-canonical --dataset backend/artifacts/research/audit-reproduction/nightly-extended-canonical.json --incumbent backend/artifacts/research/audit-reproduction/actual-c906-artifact.json --incumbent-registry docs/performance/evidence/c-data-audit-2026-10-31/actual-c906-registry.json --out backend/artifacts/research/audit-reproduction/comparison-canonical-inputs
node backend/scripts/research-challenger-development.js evaluate --dataset backend/artifacts/research/audit-reproduction/nightly-extended-canonical.json --plan backend/artifacts/research/audit-reproduction/comparison-canonical-inputs/plan.json --variants backend/artifacts/research/audit-reproduction/comparison-canonical-inputs/variants.json --out backend/artifacts/research/audit-reproduction/comparison-canonical.json --markdown backend/artifacts/research/audit-reproduction/comparison-canonical.md
python backend/scripts/audit-challenger-temporal.py --input-dir backend/artifacts/research/audit-reproduction --split-plan docs/performance/evidence/c-data-audit-2026-10-31/frozen-split-plan.json --out backend/artifacts/research/audit-reproduction/temporal-audit.json
python backend/scripts/audit-challenger-metrics.py --report backend/artifacts/research/audit-reproduction/comparison-canonical.json --expected-records 6573 --expected-cohort 1969 --out backend/artifacts/research/audit-reproduction/metric-audit --gzip
```

Il fit registrato nell'audit ha usato il report originale completo come piano; quello versionato è una sua estrazione delle finestre. Il suo file hash è quindi diverso, dichiaratamente. Il trainer usa gli stessi confini, non i vecchi conteggi; i nuovi conteggi vengono ricalcolati. Date di creazione, GUID CatBoost, comandi/percorso e hash di metadati possono cambiare. Il criterio da confrontare è l'identità dei target, degli istanti, delle probabilità e delle metriche con tolleranza dichiarata; non promettiamo artefatti binari identici.

La ricostruzione completa richiede CPU e non usa provider. L'auditor delle fonti richiede invece HTTP per rileggere Understat e CSV; le catture originali complete sono conservate localmente in `backend/artifacts/research/c-data-audit-20261031/sources/`, con i relativi hash. Le pagine HTML complete non sono ripubblicate. Una rilettura futura può differire: è una nuova acquisizione, non la prova della prima disponibilità storica.

Per rileggere le fonti su tutti i 25 blocchi, dopo la decompressione sopra:

```powershell
python backend/scripts/audit-challenger-sources.py --matches backend/artifacts/research/audit-reproduction/matches.json --benchmark docs/performance/evidence/c-data-audit-2026-10-31/before/bundle.json --teams backend/artifacts/research/audit-reproduction/teams.json --max-pairs 25 --detail-sample-per-league 5 --out backend/artifacts/research/audit-reproduction/sources
```

`source-evidence.json` conserva i riscontri e i dossier ufficiali del controllo eseguito. `persisted-primary-derived.json.gz` consente inoltre di ripetere il controllo dei 59.880 campi contro i derivati del payload primario conservato, senza credenziali. La provenienza rimane quella del payload persistito; non viene spacciata per una seconda verifica HTTP.

```powershell
python -c "import gzip,pathlib; p=pathlib.Path('docs/performance/evidence/c-data-audit-2026-10-31/persisted-primary-derived.json.gz'); pathlib.Path('backend/artifacts/research/audit-reproduction/derived.json').write_bytes(gzip.decompress(p.read_bytes()))"
node backend/scripts/audit-challenger-persisted-details.js --matches backend/artifacts/research/audit-reproduction/matches.json --derived backend/artifacts/research/audit-reproduction/derived.json --out backend/artifacts/research/audit-reproduction/persisted-replay.json
```
