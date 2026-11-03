# Dati congelati per la verifica degli strumenti C

Questa directory è un asset tecnico immutabile, letto dal ripristino del
repository. Non è una descrizione alternativa dello stato dell'app né una
validazione indipendente del modello. La guida del protocollo e dei comandi è
[Research](../../../research-platform.md); le decisioni sono nel
[catalogo delle scelte scartate](../../../FORMULARIO-scelte-scartate.md).

## Contratto dei file

- `bundle-files.json`: dimensioni e SHA256 dei payload usati dal ripristino.
- `nightly-extended-canonical.json.gz`: dataset pulito di 6.573 righe.
- `season-plan.json.gz`: finestre congelate, con 4.892 target test disgiunti.
- `comparison-plan.json.gz`, `evaluation-variants.json` e i sei archivi
  `evaluation-fold-*.tar.gz`: configurazioni e 42 artefatti del replay.
- `predictions/`: probabilità individuali congelate, manifest e ricalcolo.
- Gli altri JSON conservano controlli temporali, confronti, parametri e prove
  di conservazione; sono metadati dello stesso dataset già consultato.

Il ripristino usa anche `matches-frozen.json.gz` e `actual-c906-artifact.json.gz`
dal [bundle qualità](../c-data-audit-2026-10-31/README.md). Non spostare o modificare
i file per riordinare documentazione: lo script ne verifica nomi e hash.

## Ripristino e controllo

Dalla radice del repository, Python 3.11+; nessuna rete o credenziale:

```powershell
python backend/scripts/restore-challenger-season-inputs.py --out backend/artifacts/research/replay-c
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-three-season-backtest-2026-10-31/predictions --out backend/artifacts/research/replay-c-metrics --expected-records 6573 --expected-cohort 4892 --expected-reconstructed 0 --gzip
```

Le destinazioni devono essere nuove. Atteso SHA256 delle probabilità JSONL
decodificate: `559a079f613e12bbf5fdd05c21b1abea17ed94019cfadbcefd77ac6de7a7c216`.
Il PASS controlla integrità e calcoli degli input fissati; non certifica prima
pubblicazione degli xG, quote storiche Nightly o futura superiorità di C.

Per ricalcolare le probabilità dagli artefatti, dopo la build backend:

```powershell
node backend/scripts/research-challenger-development.js evaluate --dataset backend/artifacts/research/replay-c/nightly-extended-canonical.json --plan backend/artifacts/research/replay-c/comparison-plan.json --variants backend/artifacts/research/replay-c/comparison-canonical-inputs/variants.json --out backend/artifacts/research/replay-c-comparison.json --markdown backend/artifacts/research/replay-c-comparison.md
```

Non ricompilare `dist` durante la valutazione. La guida Research descrive il
training separato: un rifit cambia metadati e non deve essere spacciato per
l'artefatto operativo disponibile nel passato. L'opzione diagnostica della
ricetta C906 non autorizza registrazione o adozione.
