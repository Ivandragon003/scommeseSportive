# Backtesting Performance

Data: 2026-04-22  
Scope: ottimizzazione del layer report/calibrazione del backtesting in [BacktestReportService.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/BacktestReportService.ts).  
Obiettivo: ridurre i passaggi inutili sui `detailedBets`, scalare meglio quando un run viene filtrato molte volte per mercato, sorgente e date, mantenendo identiche formule e output numerici.

## Hotspot analizzati

Metriche e sezioni coinvolte:

- ROI
- yield
- hit rate
- Brier score
- log loss
- realized EV
- bucket per probabilità
- bucket per EV / edge / confidence
- segmentazione per competizione / mercato / source / data

Problemi trovati nella baseline:

1. `buildBacktestReport()` filtrava l'intero array bet-level con `filter()` e poi rieseguiva altre passate separate per summary, segmenti e bucket.
2. I filtri `market`, `source`, `dateFrom`, `dateTo` costringevano a rifare parsing data e normalizzazione source a ogni report.
3. Ogni cambio filtro sulla stessa run ripartiva da zero e riscansionava tutto lo storico.
4. Non esisteva un indice riusabile per chiavi ad alta cardinalità come `market`, `source` o date.
5. I record invalidi venivano tollerati, ma non contati esplicitamente.

## Strategia applicata

### 1. Dataset normalizzato e indicizzato

Per ogni array `detailedBets` viene costruito un dataset indicizzato, cachato in `WeakMap` sulla reference dell'array:

- `byMatchId: Map<string, number[]>`
- `byPredictionId: Map<string, number[]>`
- `byCompetition: Map<string, number[]>`
- `byMarket: Map<string, number[]>`
- `bySource: Map<string, number[]>`
- `byDateBucket: Map<string, number[]>`
- `timestampEntries` ordinato per range filter su date

Note:

- `predictionId` non è garantito dal tipo storico `BacktestBetDetail`; l'indice viene comunque popolato quando il campo è presente nel payload.
- `byDateBucket` usa bucket mensili `YYYY-MM`; per i filtri di range viene usato anche `timestampEntries` con binary search.

### 2. Aggregazioni single-pass

Sul subset filtrato non vengono più fatte passate separate per:

- summary
- byCompetition
- byMarket
- bySource
- byConfidence
- byEvBucket
- byEdgeBucket
- probabilityBuckets

Ora tutto viene aggregato in una sola passata sugli indici filtrati.

### 3. Cache per report filtrati

Ogni dataset indicizzato mantiene una cache interna per firma filtro:

- `market`
- `source`
- `dateFrom`
- `dateTo`

Questo riduce drasticamente il costo quando la stessa run viene ricalcolata più volte in UI o lato API con filtri ripetuti.

### 4. Contabilizzazione esplicita dei record invalidi

Il report espone ora:

- `dataset.quality.invalidMatchDates`
- `dataset.quality.invalidProbabilities`
- `dataset.quality.invalidOdds`
- `dataset.quality.missingMatchIds`
- `dataset.quality.missingPredictionIds`

I record non vengono nascosti: restano nel report, ma vengono contati.

## Complessità prima / dopo

### Baseline legacy

Per un singolo report:

- filtro dataset: `O(n)`
- summary: `O(n)`
- gruppi: più passate `O(n)` su stesso subset
- probability buckets: `O(n)`
- parsing date e normalize source ripetuti dentro il filtro

Complessità pratica: `O(c * n)` con costante alta, dove `c` è il numero di passate logiche sulle stesse bet.

Per una sequenza di filtri sulla stessa run:

- `O(f * c * n)`

con `f = numero filtri richiesti`.

### Implementazione attuale

Prima chiamata sulla run:

- normalizzazione + indici: `O(n)`
- ordinamento `timestampEntries`: `O(n log n)`
- aggregazione report: `O(m)`

dove `m` è il numero di bet che passano il filtro.

Chiamate successive sulla stessa run:

- risoluzione candidati da indici: `O(i + r)`
- intersezione insiemi: `O(k)`
- aggregazione single-pass sul subset filtrato: `O(m)`

In pratica:

- prima chiamata: più costosa della baseline, perché paga la costruzione dell'indice
- chiamate successive e sequenze di filtri: molto più veloci della baseline

Questa è la tradeoff voluta: il collo di bottiglia reale era il ricalcolo ripetuto sullo stesso run.

## Benchmark locali

Comando:

```powershell
cd C:\Users\ACER\Desktop\DANIELE\scommeseSportive\backend
npm run benchmark:performance
```

Script:

- [run-performance-benchmarks.js](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/benchmarks/run-performance-benchmarks.js)

### Benchmark singolo report

`legacy` = implementazione precedente ricostruita localmente  
`cold` = nuova implementazione con dataset ricreato a ogni iterazione  
`warm` = nuova implementazione con stesso run riusato, quindi con indice/cache attivi

| Scenario | Avg | p95 | Delta vs legacy |
|---|---:|---:|---:|
| legacy 100 | 0.78 ms | 1.31 ms | baseline |
| cold 100 | 1.88 ms | 5.08 ms | +141.03% |
| warm 100 | 0.02 ms | 0.09 ms | -97.44% |
| legacy 1.000 | 2.57 ms | 4.83 ms | baseline |
| cold 1.000 | 6.35 ms | 11.51 ms | +147.08% |
| warm 1.000 | 0.02 ms | 0.05 ms | -99.22% |
| legacy 10.000 | 18.28 ms | 25.22 ms | baseline |
| cold 10.000 | 66.83 ms | 86.38 ms | +265.59% |
| warm 10.000 | 0.26 ms | 0.28 ms | -98.58% |
| legacy 100.000 | 169.36 ms | 173.00 ms | baseline |
| cold 100.000 | 1538.44 ms | 1577.87 ms | +808.49% |
| warm 100.000 | 5.38 ms | 5.52 ms | -96.82% |

### Benchmark realistico: sequenza filtri sullo stesso run

Filtro cycle usato:

1. nessun filtro
2. `source=fallback`
3. `market=goal_1x2`
4. `market=shots, source=fallback`
5. range date marzo-aprile
6. `market=goal_ou, source=synthetic` con range date

| Scenario | Avg | p95 | Delta vs legacy |
|---|---:|---:|---:|
| filter-cycle legacy 10.000 | 214.44 ms | 225.01 ms | baseline |
| filter-cycle current 10.000 | 3.35 ms | 3.51 ms | -98.44% |
| filter-cycle legacy 100.000 | 1987.74 ms | 2036.47 ms | baseline |
| filter-cycle current 100.000 | 30.17 ms | 30.24 ms | -98.48% |

## Interpretazione corretta dei numeri

Il refactor non ottimizza la primissima lettura cold di una run enorme.  
Ottimizza il caso che oggi conta operativamente:

- carichi un run
- applichi filtri multipli
- cambi mercato / source / range date
- riapri il report o i suoi segmenti

In quel caso il nuovo design evita di rifare `full scan` e parsing a ogni volta.

## Verifica di correttezza numerica

Controlli eseguiti:

1. test backend verdi su [backtest-report-service.test.js](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/test/backtest-report-service.test.js)
2. benchmark con confronto esplicito `legacy reference` vs implementazione corrente, per tutti i dataset sintetici usati
3. nessuna modifica alle formule di:
   - ROI
   - yield
   - hit rate
   - Brier score
   - log loss
   - expected / realized EV
   - bucket probability / EV / edge / confidence

Risultato:

- output numerici identici sulla baseline ricostruita
- differenze non rilevate nei benchmark di confronto

## Impatto sul codice

File principali toccati:

- [BacktestReportService.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/BacktestReportService.ts)
- [backtest-report-service.test.js](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/test/backtest-report-service.test.js)
- [run-performance-benchmarks.js](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/benchmarks/run-performance-benchmarks.js)

## Rischi residui

1. Su dataset molto grandi, il costo cold resta alto per via della costruzione dell'indice e degli oggetti normalizzati.
2. La cache è per reference dell'array `detailedBets`: se un caller ricrea sempre un nuovo array identico, il vantaggio si perde.
3. `predictionId` resta opzionale nel payload storico; l'indice esiste ma non sempre è pienamente utile.
4. Il prossimo hotspot naturale resta [BacktestingEngine.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/models/backtesting/BacktestingEngine.ts), che può ancora migliorare su metriche finali e slice temporali.

## Prossimi miglioramenti consigliati

1. Spostare il report dataset index a livello di run persistita, così il cold path non ricostruisce tutto da zero a ogni processo.
2. Serializzare un indice compatto per i run grandi se il report viene consultato spesso.
3. Valutare una rappresentazione più compatta del dataset normalizzato per ridurre heap nel caso `100k+`.
4. Profilare anche [BacktestingEngine.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/models/backtesting/BacktestingEngine.ts) su `10k+` match sintetici, separando costo model-fit e costo metriche/report.
