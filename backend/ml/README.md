# Strumenti ML del modello C

Trainer CatBoost, diagnostica e test offline. Il backend operativo legge modelli
numerici JSON in TypeScript: non richiede Python o CatBoost nativo.

Riferimenti canonici:

- [Modello C](../../docs/models/MODEL-C.md): input, inferenza e registro.
- [Research](../../docs/research-platform.md): cronologia, comandi, calibrazione,
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

La release locale [C-75fd74eb875e9d0e](../current-models/challenger.json) usa
la baseline `A-9227e65a047783bd`, con ricetta fissa e calibrazione coerente
descritte nella guida del modello. La sua presenza non costituisce registrazione
o adozione.

Il trainer usa CatBoost 1.2.8; i requisiti includono il database di fusi orari
necessario su Windows. `npm test` backend comprende già la build. Il test
CatBoost nativo può essere opzionale dove Python non è configurato: uno skip non
equivale a training verificato.

Il target Docker `ml-verification` è separato dal runtime e usa
[requirements-linux-verification.txt](requirements-linux-verification.txt).
Serve alla parità Python/TypeScript; non attiva modelli né modifica portafogli.
Una parità numerica non dimostra un miglioramento predittivo.

Tenere gli output sotto `backend/artifacts/` o in una destinazione esplicita,
separati da sorgenti e dati produttivi. Il training non registra modelli: i
comandi di registrazione e adozione sono documentati in Research.

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
