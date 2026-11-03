# Evidenze TimesFM 2.5 / C — 3 novembre 2026

I risultati sono retrospettivi, già osservati e non ammissibili come nuova prova
indipendente. Nessuna integrazione o adozione. [Report](../../timesfm-c-2026-11-03.md).

## Contenuto

- `summary.json`: risultati di tutti i tre bracci, per lega/stagione/fold, IC
  assoluti e appaiati, bootstrap settimanale e sensibilità a quattro settimane,
  costi, versioni e hash di sorgenti e modelli.
- `predictions.jsonl.gz`: tutte le 4.892 probabilità 1X2 finali, con ID, esiti e
  orari, sui medesimi target per tutti i bracci.
- `features.json.gz`: quattro feature WMA e quattro TimesFM per tutte le 6.573
  righe, identità e disponibilità massima della storia, riferimenti ai contesti.
- `contexts.jsonl.gz`: le 25.658 sequenze realmente inferite, i relativi ID e
  valori xG/xGA e il punto previsto dal checkpoint congelato.
- `fold-*-c_*-*.json.gz`: 36 regressori CatBoost diagnostici esportati in JSON;
  non sono artefatti applicativi registrabili.
- `metadata.json`, `protocol.json`, `protocol-evidence.json`: ambiente,
  checkpoint e protocollo fissato localmente prima dell'inferenza. Questa
  registrazione locale non è una preregistrazione pubblica.
- `independent-audit.json`: verifica standard-library di tutti i contesti e
  delle metriche puntuali, separata dall'implementazione del nuovo benchmark.
- `operational-before.json`, `execution-verification.json`: snapshot locale dei
  289 file operativi e verifica di conservazione, build, regressioni e replay.
- `comparison.png`: differenze appaiate con IC simultanei 98,75%.
- `bundle-files.json`: SHA256 e dimensioni dei payload, anche decodificati per i gzip.

I pesi Google non sono duplicati su GitHub: si scaricano gratuitamente nella
revisione indicata. Hash del file `model.safetensors`:
`2f776efe6245e42b24bc4153ffdf61810140210e4bd3b01fb21f7aa779ab6ce8`.

## Input già pubblicati e riproduzione

Dataset SHA256 `b9de693888d5ba5f982bd4cd7d38515ec547c306aacd1371f38a7edd021b64e2`;
piano `b44a3a2e893b973ee726b42dfa588536ee90db5ecee41dbc5b591dd8a4ac1c6d`;
archivio sorgente `249233a01c52ddd2578b676ae0a464ecbcce01907e34b89138a23c15e1178dc9`.
Si ripristinano tramite lo [script esistente e i bundle delle tre stagioni](../c-three-season-backtest-2026-10-31/README.md).
Il [README dell'esperimento](../../../../backend/ml/experiments/timesfm_xg/README.md)
contiene installazione, inferenza e training completo. Ogni output deve essere nuovo.

Per ricalcolare le metriche dalle previsioni non servono TimesFM o rete:

```powershell
python backend/ml/experiments/timesfm_xg/benchmark.py analyze --predictions docs/performance/evidence/timesfm-c-2026-11-03/predictions.jsonl.gz --out backend/artifacts/research/timesfm-metrics-replay
```

Per controllare in modo separato tutti i contesti e le metriche, dopo il ripristino
degli input nella cartella indicata (il lettore accetta feature gzip):

```powershell
python backend/ml/experiments/timesfm_xg/audit.py --dataset backend/artifacts/research/timesfm-replay-inputs/nightly-extended-canonical.json --matches backend/artifacts/research/timesfm-replay-inputs/matches.json --features docs/performance/evidence/timesfm-c-2026-11-03/features.json.gz --contexts docs/performance/evidence/timesfm-c-2026-11-03/contexts.jsonl.gz --predictions docs/performance/evidence/timesfm-c-2026-11-03/predictions.jsonl.gz --summary docs/performance/evidence/timesfm-c-2026-11-03/summary.json --out backend/artifacts/research/timesfm-independent-audit-replay.json
```

Per rigenerare testo e figura con l'ambiente di ricerca installato:

```powershell
python backend/ml/experiments/timesfm_xg/render_report.py --summary docs/performance/evidence/timesfm-c-2026-11-03/summary.json --report backend/artifacts/research/timesfm-report-replay.md --figure backend/artifacts/research/timesfm-figure-replay.png
```

Il primo batch TimesFM è stato ripetuto con differenza zero; non è stato eseguito
un secondo giro di tutte le inferenze. Il replay completo delle metriche e dei
bootstrap è identico; non è un nuovo campione statistico. I 289 hash si riferiscono
al checkout locale iniziale `6ed36d44`: la base di pubblicazione `fd0f617a` include
un aggiornamento frontend preesistente, distinto dall'esperimento. Il diff del
ramo di ricerca non contiene modifiche a sorgenti operativi o package.
