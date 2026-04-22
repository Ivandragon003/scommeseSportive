# Model Layer Audit

Data audit: 2026-04-21

## Sintesi

Il layer `backend/src/models` conteneva tre categorie mischiate nello stesso livello:

- modelli core di prediction e backtesting
- modelli statistici specializzati per mercati
- utility/shared math

Il problema principale non era la formula, ma il naming e la leggibilità architetturale. Il caso più evidente era `CombinedBettingFixes.ts`: non era più una patch temporanea, ma logica stabile di analisi value, calibrazione e combinazioni. Tenerlo con nome `Fixes` rendeva il layer fuorviante.

Refactor applicato:

- `models/core`
- `models/markets`
- `models/value`
- `models/backtesting`
- `models/utils`

Nessuna formula statistica è stata cambiata in questo task.

## Mappa finale

### Core

#### `backend/src/models/core/DixonColesModel.ts`

- Responsabilità:
  - modello principale pre-match
  - fitting dei parametri squadra
  - generazione probabilità 1X2 / goal / mercati derivati
  - orchestrazione dei modelli mercato specializzati dentro `computeFullProbabilities`
- Export principali:
  - `DixonColesModel`
  - tipi `MatchData`, `FullMatchProbabilities`, `SupplementaryData`
- Chi lo usa:
  - `backend/src/services/PredictionService.ts`
  - `backend/src/services/PredictionContextBuilder.ts`
  - `backend/src/models/backtesting/BacktestingEngine.ts`
- Valutazione:
  - `KEEP`
  - è il modello core reale del prodotto

### Markets

#### `backend/src/models/markets/SpecializedModels.ts`

- Responsabilità:
  - distribuzioni specializzate per `shots`, `cards`, `fouls`, `corners`, `player shots`
  - layer usato davvero in produzione da `DixonColesModel`
- Export principali:
  - `SpecializedModels`
  - tipi dati e distribuzioni mercato (`ShotsModelData`, `CardsModelData`, `FoulsModelData`, ...)
- Chi lo usa:
  - `backend/src/models/core/DixonColesModel.ts`
  - indirettamente `PredictionContextBuilder` tramite i tipi
- Sovrapposizioni:
  - parziale sovrapposizione con `CardsModel.ts` e `ShotsModel.ts`
- Valutazione:
  - `KEEP`
  - è il vero facade di mercato usato dal runtime

#### `backend/src/models/markets/CardsModel.ts`

- Responsabilità:
  - modello standalone cartellini
  - profili squadra cartellini
  - modello standalone falli (`FoulsModel`)
- Export principali:
  - `CardsModel`
  - `FoulsModel`
  - tipi `TeamCardProfile`, `RefereeProfile`, `CardsPrediction`, `FoulsPrediction`
- Chi lo usa:
  - nessun import runtime attivo rilevato nel backend applicativo
  - ora coperto da test di regressione
- Sovrapposizioni:
  - con `SpecializedModels.computeCardsDistribution`
  - con `SpecializedModels.computeFoulsDistribution`
- Valutazione:
  - `KEEP_WITH_NOTE`
  - è codice ambiguo: sembra legacy/standalone, ma contiene logica statistica non banale
  - non va cancellato senza decisione esplicita e regressione comparata contro `SpecializedModels`

#### `backend/src/models/markets/ShotsModel.ts`

- Responsabilità:
  - modello standalone tiri squadra
  - modello ZIP per tiri giocatore
- Export principali:
  - `ShotsModel`
  - tipi `PlayerShotProfile`, `TeamShotProfile`, `TeamShotsPrediction`, `PlayerShotPrediction`
- Chi lo usa:
  - nessun import runtime attivo rilevato nel backend applicativo
  - ora coperto da test di regressione
- Sovrapposizioni:
  - con `SpecializedModels.computeShotsDistribution`
  - con `SpecializedModels.computePlayerShotsPredictions`
- Valutazione:
  - `KEEP_WITH_NOTE`
  - stessa situazione di `CardsModel.ts`: specialistico, non agganciato al runtime principale, ma non “morto con prova”

### Value

#### `backend/src/models/value/ValueBettingEngine.ts`

- Responsabilità:
  - ranking e filtro delle value bet
  - calcolo EV, edge, Kelly, confidence, tier mercato
  - funzioni di budget e diagnostica selezione
- Chi lo usa:
  - `backend/src/services/PredictionService.ts`
  - `backend/src/models/backtesting/BacktestingEngine.ts`
  - test dedicati
- Valutazione:
  - `KEEP`
  - core decision engine lato betting

#### `backend/src/models/value/EnhancedMarketAnalysis.ts`

- Origine:
  - rinominato da `CombinedBettingFixes.ts`
- Responsabilità:
  - calibrazione flat probabilities
  - patch adattive guidate da richness
  - separazione per tier
  - cap intra-match exposure
  - analisi mercati enhanced
  - combinata / combo bet
- Chi lo usa:
  - `backend/src/services/PredictionService.ts`
  - `backend/src/models/backtesting/BacktestingEngine.ts`
- Perché il rename:
  - il contenuto non era una “fix” temporanea
  - è logica di dominio stabile nel layer value
- Valutazione:
  - `KEEP`
  - rename corretto e necessario

### Backtesting

#### `backend/src/models/backtesting/BacktestingEngine.ts`

- Responsabilità:
  - split temporale
  - simulazione quote storiche/sintetiche
  - selezione bet da prediction engine
  - metriche di performance, calibrazione, equity, fold walk-forward
- Chi lo usa:
  - `backend/src/services/PredictionService.ts`
  - `backend/src/services/BacktestReportService.ts`
  - benchmark
- Valutazione:
  - `KEEP`
  - core operativo del backtest

### Utils

#### `backend/src/models/utils/MathUtils.ts`

- Responsabilità:
  - PMF/CDF/funzioni matematiche condivise
- Chi lo usa:
  - `SpecializedModels.ts`
  - `CardsModel.ts`
  - `ShotsModel.ts`
- Valutazione:
  - `KEEP`
  - utility condivisa correttamente separata

## Duplicazioni e sovrapposizioni

### Duplicazione strutturale reale

1. `SpecializedModels.ts` vs `CardsModel.ts`
- Entrambi modellano cartellini
- Entrambi modellano falli
- Solo `SpecializedModels.ts` è chiamato dal percorso prediction core

2. `SpecializedModels.ts` vs `ShotsModel.ts`
- Entrambi modellano tiri squadra
- Entrambi hanno supporto a player shots
- Solo `SpecializedModels.ts` è agganciato al runtime principale

### Duplicazione accettata per ora

Questa duplicazione non è stata rimossa in questo task per tre motivi:

- manca una prova automatizzata che i moduli standalone siano completamente sostituibili
- il task vieta cleanup estetico che alteri output
- i modelli standalone contengono ancora logica statistica riusabile e non banale

## Codice legacy / ambiguo

### Legacy naming corretto

`CombinedBettingFixes.ts` era legacy nel nome, non nel contenuto.

Decisione:
- rinominato in `EnhancedMarketAnalysis.ts`
- mantenuto nel dominio `models/value`

### Legacy funzionale possibile

`CardsModel.ts` e `ShotsModel.ts` sono i candidati legacy più forti, ma non c’è prova sufficiente per eliminarli.

Segnali:
- nessun import runtime attivo rilevato
- responsabilità coperte in parte da `SpecializedModels.ts`

Contro-indicazioni alla rimozione:
- logica statistica ancora coerente
- possibilità di riuso futuro
- rischio di cancellare codice algoritmo non coperto abbastanza

## Raccomandazioni

### Keep

- `core/DixonColesModel.ts`
- `value/ValueBettingEngine.ts`
- `value/EnhancedMarketAnalysis.ts`
- `backtesting/BacktestingEngine.ts`
- `markets/SpecializedModels.ts`
- `utils/MathUtils.ts`

### Keep con nota

- `markets/CardsModel.ts`
- `markets/ShotsModel.ts`

### Remove

- nessun file rimosso in questo task, oltre alla rinomina di `CombinedBettingFixes.ts`

## Prossimi passi consigliati

1. decidere esplicitamente se `CardsModel.ts` e `ShotsModel.ts` devono restare:
   - modelli standalone supportati
   - oppure legacy da deprecare

2. se si vuole ridurre duplicazione vera:
   - estrarre funzioni comuni in `models/markets/shared`
   - oppure consolidare i modelli standalone dentro `SpecializedModels`

3. prima di cancellare file ambigui:
   - aggiungere test comparativi output-to-output tra `SpecializedModels` e moduli standalone
   - verificare che nessun benchmark/backtest cambi comportamento
