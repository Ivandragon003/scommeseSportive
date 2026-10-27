# CatBoost challenger C

Questa cartella contiene il training locale del candidato ibrido C. Non contiene un servizio HTTP, un provider LLM o un terzo portafoglio. L'inferenza applicativa legge gli alberi CatBoost JSON nel backend TypeScript e non richiede Python nel container web.

## Verifica Linux per Hostless

`backend/Dockerfile` usa lo stesso target finale `runtime` per web e worker: Node 20 su Debian, dipendenze da `package-lock.json`, senza Python o CatBoost nativo. Il modello operativo viene letto dal registry Turso condiviso; gli artefatti locali non sono copiati nell'immagine. Non serve eseguire il training settimanale dentro il web o il worker.

Il target separato `ml-verification` contiene Python e CatBoost 1.2.8 per verificare l'equivalenza numerica, senza aggiungerli alla produzione. Dalla radice del repository:

```powershell
docker build --target runtime -t footpredictor-hostless:local backend
docker build --target ml-verification -t footpredictor-hostless-ml:local backend
```

Con gli artefatti privati già presenti in `backend/artifacts/research`, senza rete o crediti provider:

```powershell
docker run --rm --network none --cpus 0.25 --memory 256m --mount "type=bind,source=$((Get-Location).Path)/backend/artifacts/research,target=/fixtures,readonly" footpredictor-hostless:local node scripts/research-ml-smoke.js --artifact /fixtures/followup-coherent-candidate/artifact.json --parity /fixtures/run-20261027/parity.json
docker run --rm --network none --cpus 0.5 --memory 512m --mount "type=bind,source=$((Get-Location).Path)/backend/artifacts/research,target=/fixtures,readonly" footpredictor-hostless-ml:local /opt/ml/bin/python ml/verify_linux_parity.py --parity /fixtures/run-20261027/parity.json
docker run --rm --network none footpredictor-hostless-ml:local node --test test/research-catboost.test.js
```

I percorsi degli artefatti sono esempi riferiti allo snapshot locale del 27 ottobre 2026: non costituiscono file distribuiti. Il primo comando rifiuta artefatti `diagnosticOnly`, verifica il contributo C completo, errori di schema/feature e la parità dei tre candidati, poi misura 1.000 inferenze e un gruppo di venti. Il secondo ricarica gli stessi JSON con CatBoost nativo Linux e controlla i riferimenti numerici. Il terzo esegue anche un training effettivo su fixture sintetica dichiarata. La baseline del primo test è simulata: i tempi misurano soltanto caricamento e inferenza ML, non fit A, rete Turso, acquisizione quote o intero tick.

L'inferenza JSON è sincrona e non invoca processi Python o servizi esterni: non esiste un timeout di subprocesso da configurare. Gli errori invalidano la decisione; il controllo del termine T−15 deve comunque avvenire nuovamente alla registrazione, dopo l'inferenza. Un eventuale blocco prolungato del processo si rileva dal watchdog sul heartbeat, non dal solo HTTP. I modelli ammissibili hanno già limiti sul numero di alberi e profondità; il test di risorse non autorizza modelli di dimensione arbitraria.

Una parità numerica superata dimostra compatibilità tecnica. Non promuove un candidato con `productionValidated=false`, non modifica i suoi pesi e non dimostra capacità predittiva o disponibilità del champion sull'account remoto.

## Input e cronologia

`ForecastCore.buildTrainingDataset` esporta tutte le partite concluse ammissibili dei cinque campionati dopo il minimo storico di 30 incontri per competizione. Non filtra sulle giocate precedentemente consigliate. Ogni osservazione usa un target prepartita a T−15 e solo risultati disponibili prima di tale istante, con ritardo minimo prudenziale di due ore dal kickoff. Un timestamp esplicito di disponibilità può soltanto posticipare questo limite.

Il ritardo di due ore è un'ipotesi del protocollo storico, non una prova che ogni informazione fosse effettivamente stata acquisita dal provider in quel momento. Correzioni retroattive della fonte e dati non versionati richiedono analisi separata. Per le simulazioni prospettiche servono snapshot realmente acquisiti prima della decisione.

Le feature numeriche condivise tra training e inferenza includono Elo, campione storico, goal/xG fatti e subiti, copertura xG, tiri, forma sulle ultime cinque gare, rendimento casa/trasferta, riposo, medie stagionali, intensità A e indicatori del campionato. Nessun risultato del target, quota o decisione passata è usato come feature. Valori mancanti hanno fallback espliciti e la copertura xG è una feature distinta; non sono dati osservati inventati.

La configurazione A, le versioni dei motori, i parametri di fit e gli hash dei moduli compilati sono conservati nel manifest. Il fit statistico è ristimato cronologicamente ogni settimana nel dataset. Le probabilità A conservano il blending per famiglia già esistente. Il campo `baselineMatrix` è una matrice congiunta ausiliaria con il peso ensemble di default: quando i pesi per famiglia differiscono non rappresenta esattamente tutte le marginali A. Il benchmark per mercato deve usare `baselineProbabilities` per A, non scambiare questa matrice ausiliaria per l'intero percorso live.

## Training riproducibile

Richiede Python compatibile con CatBoost 1.2.8:

```powershell
python -m pip install -r backend/ml/requirements.txt
python backend/ml/train.py --input <dataset.json> --output <directory-privata> --iterations 120 --depth 5 --folds 3
```

Non passare segreti sulla riga di comando. Il trainer legge solo il dataset già esportato e non effettua richieste di rete, accessi al database o registrazioni di giocate.

Confronta tre candidati:

1. Correzione delle intensità A con regressori CatBoost Poisson e baseline logaritmica.
2. Correzione delle probabilità 1X2 A con classificatore CatBoost e baseline logaritmica; le masse congiunte sono riscalate mantenendo i condizionali del punteggio.
3. Ensemble calibrato con due regressori Poisson standalone interni. Questo candidato rimane una configurazione C; non esiste un portafoglio B.

Pesi di combinazione e temperatura sono selezionati da griglie dichiarate sulla sola finestra di validazione antecedente al test. Non sono presentati come ottimali universali. La selezione primaria usa log loss 1X2; gli altri mercati devono affrontare la propria validazione e nessun risultato 1X2 li abilita automaticamente.

Il protocollo prevede quattro finestre cronologiche: training crescente, selezione di candidato/peso/temperatura, calibrazione successiva e test. Le etichette della calibrazione non selezionano il candidato. Le etichette non ancora disponibili al confine vengono escluse. Kickoff identici rimangono nello stesso intervallo. I test dei fold sono disgiunti. L'ultima finestra test resta separata dalla selezione nel singolo run; ripetere l'ottimizzazione contro lo stesso test ne compromette l'indipendenza e richiede un registro degli esperimenti.

`ResearchProbabilityPipeline` riusa il fit isotonico, le curve per famiglia e il blending bookmaker di `ValueBettingEngine` e `EnhancedMarketAnalysis`. Conserva separatamente probabilità grezze, calibrate e decisionali. I companion per togliere il margine provengono dallo stesso bookmaker e snapshot. È un protocollo storico as-of riproducibile, non una promessa di identità con il contesto live corrente, che può includere informazioni aggiuntive.

`evaluateResearchPipelineBenchmark` applica questo percorso alla finestra test dopo aver stimato i calibratori sulla sola finestra precedente. Le stesse etichette usate per stimare le curve non sono riutilizzate come prova indipendente del valore atteso prudenziale. Senza un ulteriore campione ammissibile con quote reali, il confronto probabilistico resta disponibile e la selezione economica si astiene.

## Artefatti

- `artifact.json`: versione C, feature, parametri, cutoff di training/validazione, alberi numerici, peso, temperatura, metriche e hash del dataset. Include `calibrationPredictions` per costruire i profili successivi nel medesimo codice TypeScript dell'inferenza. È un candidato, non un modello automaticamente validato.
- `report.json`: confronto probabilistico cronologico, numerosità, calibrazione 1X2, metriche per campionato, differenze appaiate e bootstrap per blocchi settimanali. Contiene anche le previsioni test utili al confronto economico separato.
- `parity.json`: campioni di inferenza grezza per verificare equivalenza tra CatBoost Python ed esecuzione JSON TypeScript.
- `fold-N/`: modelli e manifest specifici del fold, senza riscrivere i record delle giocate già archiviate.

Il report probabilistico da solo non esegue un backtest economico, non converte quote di chiusura in quote T−15 e non promuove mercati o modelli. La misura principale è 1X2; per altri mercati occorre usare il motore di settlement e confronto dedicato. La griglia congiunta usa punteggi 0..10 per squadra ed è normalizzata dopo il troncamento; non è una promessa di probabilità di coda esatte.

Il simulatore economico usa stake fisso pari all'1% del patrimonio contabile e massimo 5% impegnato contemporaneamente. L'allocazione fra partite con lo stesso timestamp usa prima il punteggio prudenziale, poi l'identificativo partita per risolvere le parità. Il report non contiene un portafoglio con stake del 5%. Le curve del patrimonio e i segmenti per lega, mercato, stagione e fascia di quota restano separati per A e C.

Il runtime rifiuta un artefatto incompatibile con lo schema feature o la baseline, senza alberi validi, con tipi CatBoost non supportati o validato dopo l'istante di previsione. Le versioni devono restare immutabili nel registry; gli aggiornamenti non riscrivono lo storico.

## Verifiche

Il lettore JSON accetta solo alberi numerici simmetrici, verifica dimensioni e valori finiti e applica il confronto dei bordi su numeri float32, come la quantizzazione CatBoost. Le altre tipologie di feature sono rifiutate esplicitamente. Riferimenti ufficiali: [esportazione JSON](https://catboost.ai/docs/en/features/export-model-to-json), [baseline del Pool](https://catboost.ai/docs/en/concepts/python-reference_pool), [funzioni obiettivo Poisson e MultiClass](https://catboost.ai/docs/en/references/training-parameters/common).

I test `research-forecast.test.js` verificano riproducibilità A, whitelist del target, esclusione dei dati futuri, ritardo dei risultati e copertura dell'export. `research-catboost.test.js` verifica contributo ML, identità probabilistiche, gestione JSON e, quando CatBoost 1.2.8 è installato, un vero training su fixture dichiaratamente sintetiche con confronto Python/Node. Queste fixture verificano l'esecuzione tecnica e non costituiscono evidenza di qualità su partite reali.
