# Baseline di regressione del solo A operativo

Snapshot: `a474e36cee8372d4e214c704effdb92b488f9242`, catturato prima delle
modifiche successive al modello C. Non aggiornare questi valori per fare
passare una modifica di C: una variazione di A richiede una decisione esplicita.

`source-manifest.json` conserva SHA256 del contenuto letto con `git show`
dallo snapshot indicato, normalizzando CRLF in LF. Prima della cattura dei
golden è stata verificata l'identità dei 36 sorgenti correnti con quei blob.
Il manifest protegge modelli, configurazione, utility e servizi importanti
di previsione, selezione e quote A. Non congela il database o i file research
di C, che possono evolvere separatamente.

`expected.json` contiene output catturati dal vero `PredictionService.predict`
prima del cambiamento C. Ogni scenario è stato eseguito due volte e i
risultati sono stati confrontati prima di salvare la baseline. Le fixture
usano soltanto oggetti in memoria: **nessuna partita o quota rappresenta
un'osservazione reale**, e il nome bookmaker contiene `[TEST ONLY]`.
La stringa tecnica `odds_api` serve solo a esercitare il normale contratto
di ammissione del motore, senza contattare il provider.

La fixture carica i default espliciti delle variabili del modello, blocca clock
e seme pseudocasuale; ripristina le variabili d'ambiente, clock e random
d'ambiente modificate alla fine di ogni caso. Fornisce curve storiche congelate,
anche non identità, al confine del caricamento della calibrazione. Restano reali
contesto, DC, partner Poisson-xG, modelli statistici, bootstrap, tuning da review,
applicazione della calibrazione, blending, filtri, ranking, stake e picker.
I numeri sono confrontati dopo arrotondamento a dieci cifre decimali.
Gli hash runtime di codice/stato/versione vengono esclusi dal confronto
comportamentale; gli hash sorgente sono verificati separatamente.

Scenari: listino completo, soli tiri/cartellini, consiglio principale sui
cartellini, storico e calibrazione deboli, assenza del partner Poisson,
assenza di quote. I golden includono catalogo raw, curve fornite, tuning,
probabilità finali, opportunità accettate/speculative, diagnostica filtri,
scelta spiegata e pacchetto canonico con ordine, confidenza e stake.

Per ripetere il controllo, dopo la build ordinaria del backend:

```powershell
node --test test/operational-a-regression.test.js
```

Il test non misura redditività, non ricostruisce il fit storico delle curve
fornite, non copre gli input possibili in modo esaustivo e mantiene le player
props disabilitate. Non dimostra che le quote siano disponibili nel deploy o
che un servizio esterno sia raggiungibile. Il blocco sorgente protegge anche
componenti di quei percorsi non esercitati dai sei casi.
