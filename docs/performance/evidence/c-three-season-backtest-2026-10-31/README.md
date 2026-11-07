# Dati congelati per la verifica degli strumenti C

Questa directory conserva dati, probabilità e risultati storici. Il ripristino
comprende soltanto dati: i pesi dei vecchi modelli sono esclusi per rispettare la
richiesta di eliminarli senza archiviarli. La guida del protocollo e dei comandi è
[Research](../../../research-platform.md); le decisioni sono nel
[catalogo delle scelte scartate](../../../FORMULARIO-scelte-scartate.md).

## Contratto dei file

- `bundle-files.json`: contratto `challenger-season-data-bundle-v2`, con dimensioni
  e SHA256 dei soli dati ripristinabili e delle probabilità salvate.
- `nightly-extended-canonical.json.gz`: dataset pulito di 6.573 righe.
- `season-plan.json.gz`: finestre congelate, con 4.892 target test disgiunti.
- `comparison-plan.json.gz`: finestre del confronto storico.
- `predictions/`: probabilità individuali congelate, manifest e audit delle metriche.
- `evaluation-variants.json`: metadati della selezione storica; i percorsi dei
  vecchi artefatti non costituiscono file disponibili per un nuovo ricalcolo.
- Gli altri JSON conservano controlli temporali, confronti, parametri e prove
  di conservazione; sono metadati dello stesso dataset già consultato.

Il ripristino usa anche `matches-frozen.json.gz` dal
[bundle qualità](../c-data-audit-2026-10-31/README.md). Mantiene i byte del dataset,
delle finestre e delle probabilità salvate; non estrae archivi di modelli e non
ricrea pesi storici. Le probabilità possono essere controllate e le metriche
ricalcolate, ma non possono essere rigenerate dai modelli eliminati.

## Ripristino e controllo

Dalla radice del repository, Python 3.11+; nessuna rete o credenziale:

```powershell
python backend/scripts/restore-challenger-season-inputs.py --out backend/artifacts/research/replay-c-data
python backend/scripts/audit-challenger-metrics.py --bundle backend/artifacts/research/replay-c-data/predictions --out backend/artifacts/research/replay-c-metrics --expected-records 6573 --expected-cohort 4892 --expected-reconstructed 0 --gzip
```

Le destinazioni devono essere nuove. Atteso SHA256 delle probabilità JSONL
decodificate: `559a079f613e12bbf5fdd05c21b1abea17ed94019cfadbcefd77ac6de7a7c216`.
Il manifest di ripristino dichiara `modelWeightsRestored: 0` e
`modelReconstructionAvailable: false`. Il PASS controlla integrità e calcoli dei
dati e delle probabilità già salvate; non certifica prima
pubblicazione degli xG, quote storiche Nightly o futura superiorità di C.

La ricostruzione completa delle probabilità dagli artefatti storici non è più
disponibile. Un nuovo training produce un nuovo modello e nuove impronte; non
ricrea l'esecuzione passata e non autorizza registrazione o adozione.
