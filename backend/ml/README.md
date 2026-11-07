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

La release locale [C-99ec096b068bb360](../current-models/challenger.json) usa
la baseline `A-c6c759d111a7734a`, con ricetta fissa e calibrazione coerente
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
