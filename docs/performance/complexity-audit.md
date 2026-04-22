# Complexity Audit

Data: 2026-04-21  
Scope: backend Express, servizi quote, backtesting, pagine frontend grandi.  
Metodo: analisi statica del codice + benchmark locali con fixture mockate, senza rete.

## Sintesi

Hotspot reali trovati:

1. `EurobetOddsService.matchFixturesToCompetitionMatches`
2. `buildBacktestReport` in `BacktestReportService`
3. `PredictionService.recomputeBudgetFromBets`
4. Derivazioni non memoizzate in `frontend/src/pages/DataManager.tsx`
5. Polling multi-endpoint in `frontend/src/pages/Scrapers.tsx`
6. Doppia prediction in `frontend/src/pages/Predictions.tsx`

Hotspot ottimizzati in questa patch:

1. Matching fixture Eurobet con preindex + cache
2. Aggregazioni report backtest in pass singolo
3. Ricomputazione budget in pass singolo
4. Memoizzazione derivazioni pesanti in `DataManager`

## Benchmark locali

Script: [run-performance-benchmarks.js](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/benchmarks/run-performance-benchmarks.js)  
Comando: `npm --prefix backend run benchmark:performance`

Baseline misurata prima delle ottimizzazioni:

| Benchmark | Input | Avg | p95 |
|---|---:|---:|---:|
| backtest-report | 6000 bets | 22.94 ms | 50.87 ms |
| eurobet-fixture-matching | 350 fixture / 1500 match | 42791.05 ms | 45366.77 ms |
| backtesting-engine | 180 match | 207.68 ms | 249.94 ms |
| prediction-service | 60 prediction | 149.56 ms | 181.00 ms |
| provider-merge | 180 merge | 11.49 ms | 13.42 ms |

Misura corrente dopo la patch:

| Benchmark | Input | Avg | p95 |
|---|---:|---:|---:|
| backtest-report | 6000 bets | 18.34 ms | 38.03 ms |
| eurobet-fixture-matching | 350 fixture / 1500 match | 76.85 ms | 93.80 ms |
| backtesting-engine | 180 match | 197.09 ms | 237.36 ms |
| prediction-service | 60 prediction | 157.20 ms | 196.25 ms |
| provider-merge | 180 merge | 11.69 ms | 18.08 ms |
| budget-recompute | 18000 bet | 2.99 ms | 4.53 ms |

Confronti legacy ricostruiti localmente:

| Hotspot | Legacy | Corrente | Delta |
|---|---:|---:|---:|
| eurobet fixture matching | 1953.35 ms | 76.85 ms | -96.07% |
| budget recompute | 9.30 ms | 2.99 ms | -67.85% |

Nota: per Eurobet il baseline reale pre-patch era molto peggiore del legacy ricostruito, perché includeva anche normalizzazioni e parsing date non cacheati.

## Hotspot per modulo

### 1. Report backtest

- Funzione: `buildBacktestReport`
- File: [BacktestReportService.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/BacktestReportService.ts)
- Input tipico: 1 run con `1k-10k` `detailedBets`
- Complessità prima:
  - summary: `O(n)` ma con molte passate separate sullo stesso array
  - probability buckets: `O(b*n)` con `b=10`
  - gruppi: `O(n)` per grouping + nuove passate `O(n_g)` per ogni gruppo
- Complessità attuale:
  - summary: `O(n)` pass singolo
  - probability buckets: `O(n)` pass singolo
  - gruppi: `O(n)` con accumulatori incrementali
- Perché era lenta:
  - `reduce/filter` ripetuti
  - bucket costruiti con `bets.filter(...)` per ogni intervallo
  - gruppi memorizzavano array completi e poi rieseguivano summary
- Ottimizzazione applicata:
  - accumulatori incrementali
  - `resolveBucketIndex` iterativo
  - metadata dataset calcolati in un solo loop
- Rischio regressione: basso
- Stato: ottimizzato

### 2. Matching fixture Eurobet

- Funzione: `matchFixturesToCompetitionMatches`
- File: [EurobetOddsService.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/EurobetOddsService.ts)
- Input tipico:
  - reale: `5-20` fixture per competizione
  - stress test locale: `350` fixture su `1500` match
- Complessità prima: `O(f*m*s)`
  - `f` fixture
  - `m` match candidati
  - `s` costo di score con normalizzazioni, set e parsing date ripetuti
- Complessità attuale:
  - build index: `O(m)`
  - lookup tipico: `O(f*c)` con `c << m`
  - worst case: fallback ancora `O(f*m)` ma solo se l’indice non produce candidati utili
- Perché era lenta:
  - full scan su tutti i match per ogni fixture
  - `normalizeWords`, slug, identity set e `new Date()` rifatti a ogni confronto
  - `Intl.DateTimeFormat` ricreato ripetutamente nei candidate timestamp
- Ottimizzazione applicata:
  - cache per normalizzazione stringhe, slug, identity candidate, timestamp e time candidates
  - formatter statici per `UTC` e `Europe/Rome`
  - indice `home/away` per ridurre il set di candidati
  - consumo match tramite `Set` di indici, senza `splice` ripetuti sul pool
- Rischio regressione: medio-basso
- Stato: ottimizzato

### 3. Ricomputazione budget

- Funzione: `recomputeBudgetFromBets`
- File: [PredictionService.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/PredictionService.ts)
- Input tipico: `100-20k` bet per utente
- Complessità prima: circa `O(7n)`
  - più `filter` e `reduce` separati sugli stessi record
- Complessità attuale: `O(n)`
- Perché era lenta:
  - stesso array attraversato molte volte per `WON`, `LOST`, `VOID`, ROI e win rate
- Ottimizzazione applicata:
  - helper `summarizeBudgetBetsInternal` a pass singolo
- Rischio regressione: basso
- Stato: ottimizzato

### 4. Prediction generation

- Funzione: `predict`
- File: [PredictionService.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/PredictionService.ts)
- Input tipico: 1 prediction con lookup team, players, schedule, odds alignment e ranking value bet
- Complessità attuale: `O(p + s + m)` lato CPU locale
  - `p` player data
  - `s` selection keys
  - `m` market groups
- Perché può essere lenta:
  - molte dipendenze dal DB
  - flattening e market ranking ad ogni prediction
  - `Predictions.tsx` può fare una seconda chiamata intenzionale quando arrivano quote reali
- Ottimizzazione possibile:
  - cache corta per metadata mercati / nomi selezione
  - dedupe server-side di lookup immutabili durante la stessa request
- Rischio regressione: medio
- Stato: analizzato, non modificato in questa patch

### 5. Backtesting engine

- Funzione: `runBacktest`
- File: [BacktestingEngine.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/models/BacktestingEngine.ts)
- Input tipico: `100-1000` match + odds storiche
- Complessità attuale: dominata da model fit + evaluation loop, circa `O(n log n + n*k)`
- Perché può essere lenta:
  - sort iniziale
  - training/fitting del modello
  - calcolo calibration e metriche finali
- Ottimizzazione possibile:
  - riuso di slice invece di filtri separati in holdout temporale
  - accumulatori incrementali per alcune metriche finali
- Rischio regressione: medio-alto
- Stato: analizzato, non modificato in questa patch

### 6. Provider merge

- Funzione: `mergeOddsMatchMarkets`
- File: [oddsProviderUtils.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/odds-provider/oddsProviderUtils.ts)
- Input tipico: 2 provider match con `10-30` mercati
- Complessità attuale: `O(m*o)`
- Perché può essere lenta:
  - deduplica outcome per signature string
- Ottimizzazione possibile:
  - preallocazione map/set e signature meno costose
- Rischio regressione: basso
- Stato: misurato, non prioritario

### 7. DataManager frontend

- Funzione: derivazioni `competitions`, `seasons`, `years`, `filteredMatches`, `filteredTeams`
- File: [DataManager.tsx](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/frontend/src/pages/DataManager.tsx)
- Input tipico: centinaia di team e match
- Complessità prima: `O(n)` ricostruita a ogni render
- Complessità attuale: `O(n)` ma memoizzata sui soli dependency change
- Perché poteva essere lenta:
  - sort/filter/date parsing in render body
  - ricalcolo anche quando cambiava stato non collegato ai filtri
- Ottimizzazione applicata:
  - `useMemo` su dataset derivati principali
- Rischio regressione: basso
- Stato: ottimizzato

### 8. Predictions frontend

- Funzione: `analyzeMatch`
- File: [Predictions.tsx](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/frontend/src/pages/Predictions.tsx)
- Input tipico: 1 click analisi match
- Complessità attuale: 1 chiamata `/api/predict` base + 1 seconda chiamata solo se arrivano quote bookmaker
- Perché può sembrare un duplicate fetch:
  - la prima serve a mostrare subito la prediction base
  - la seconda ricalcola EV/value con quote reali o fallback
- Ottimizzazione possibile:
  - endpoint backend unico che restituisce prediction base e enriched odds in un solo roundtrip
- Rischio regressione: alto, perché cambia contratto operativo tra frontend e backend
- Stato: analizzato, lasciato invariato volutamente

### 9. Scrapers frontend

- Funzione: polling status
- File: [Scrapers.tsx](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/frontend/src/pages/Scrapers.tsx)
- Input tipico: pagina aperta per minuti
- Complessità attuale: `6` GET ogni `5s`
- Perché può essere lenta:
  - polling multi-endpoint costante
- Ottimizzazione possibile:
  - endpoint aggregato unico `/api/system/overview`
  - backoff quando la tab non è visibile
- Rischio regressione: medio
- Stato: analizzato, non modificato in questa patch

## Loop annidati e pattern cercati

Pattern trovati e già corretti:

- full scan fixture-to-match in Eurobet
- normalizzazione squadra ripetuta nel matching
- parsing data ripetuto nel matching
- bucket backtest con `filter` ripetuti
- summary budget con più `filter/reduce` sullo stesso array
- derivazioni `DataManager` ricostruite a ogni render

Pattern trovati ma non ancora corretti:

- polling multi-endpoint in `Scrapers`
- doppia prediction intenzionale in `Predictions`
- alcuni sort/filter nel `BacktestingEngine`

Pattern non rilevati come problema attuale:

- cicli di dipendenza bloccanti
- chiamate esterne batchabili oltre quanto già presente nel coordinatore quote

## Performance budget

Soglie indicative da tenere come target operativo:

- `buildBacktestReport` su `6000` bet: `avg < 25 ms`, `p95 < 45 ms`
- matching fixture Eurobet su batch grande sintetico (`350` fixture, `1500` match): `avg < 120 ms`
- singola fixture reale Eurobet su meeting di competizione: `p95 < 5 ms` lato matching puro
- ricomputazione budget su `20k` bet: `avg < 5 ms`
- `runBacktest` su `180` match: `avg < 250 ms`
- frontend `DataManager`: nessun `sort/filter` principale ricostruito a ogni render non pertinente
- frontend: nessuna chiamata API identica duplicata nello stesso caricamento pagina
- `Predictions`: la doppia call `/api/predict` è ammessa solo perché la seconda cambia input e output atteso

## Rischi residui

- `BacktestingEngine` resta il prossimo candidato backend se i dataset crescono molto.
- `Scrapers.tsx` continua a fare polling aggressivo su più endpoint.
- `Predictions.tsx` ha ancora un doppio roundtrip intenzionale quando arrivano quote reali.
- I benchmark sono CPU-locali e non misurano latenza DB reale o rete esterna.

## Prossimi miglioramenti consigliati

1. Introdurre un endpoint aggregato per `Scrapers` per ridurre il polling.
2. Aggiungere cache corta per metadata mercati in `PredictionService`.
3. Profilare `BacktestingEngine.computeCalibration` su dataset più grandi.
4. Valutare un endpoint prediction “single roundtrip” solo se si vuole ridurre il doppio fetch frontend senza toccare il comportamento utente.
