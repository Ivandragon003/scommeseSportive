# Formulario del sistema — Football Prediction & Value Betting Engine

**Versione 5.0 — allineata al codice `main` (Luglio 2026).**
Sostituisce `FormularioSistemaScommesse_v4_allineato.docx` (v4.1, maggio 2026), che era indietro di un intero ciclo di lavoro. Questo documento descrive **ciò che il codice fa davvero oggi**, con i valori di configurazione reali. Le voci nuove rispetto alla v4.1 sono marcate 🆕; il codice presente ma non collegato al runtime è marcato ⚠️.

Per le idee valutate e **scartate** (e il perché) vedere il documento compagno [`FORMULARIO-scelte-scartate.md`](FORMULARIO-scelte-scartate.md) e i report in [`docs/performance/`](performance/).

---

## 0. Vincoli operativi

- Stack: React frontend · Node.js + Express + TypeScript backend · libSQL/Turso · Docker · modular monolith.
- Fonte dati calcio: **Understat** (rose, tiri, xG per-match nel `raw_json`). FotMob/Transfermarkt/FBref non attivi.
- Fonte quote: **Eurobet / The Odds API**. Quote sintetiche solo per diagnostica/backtest.
- Mercati value attivi: `goal_1x2`, `goal_ou`, `btts`, `shots`, `shots_ot`, `yellow_cards`, `exact_score`, `handicap`. **Corners e fouls disattivati** dal filtro value (dati reali presenti solo nell'1–2% dei match — vedi §13).
- `maxOdds = 8.00`, `applyMaxOddsToAllMarkets = true`, `sofascoreSupplementalEnabled = false`.

## 1. Configurazione tipizzata

Due file di configurazione:
- `backend/src/config/PredictionEngineConfig.ts` — `predictionEngineConfig` (tabella sotto). Default backward-compatible; logiche che cambiano il comportamento storico opt-in.
- `backend/src/config/predictionConfig.ts` — `predictionConfig`, override da **variabili d'ambiente**: `model.homeAdvantageScale` (default 0.5, moltiplica l'HA salvato in `sanitizeModelParams`), `model.contextWeights` (form 0.12 / motivation 0.06 / absences 0.05 / discipline 0.03), `markets.minSampleSizePerTeam` (8) / `minCombinedSampleSize` (20) — sotto queste soglie i mercati statistici vengono disattivati per quel match.

Valori chiave attuali:

| Sezione | Parametro | Valore |
|---|---|---|
| dixonColes.xgBlend 🆕 | `enableXgBlend` / `xgWeight` / `maxXgValue` | true / **0.80** / 8 |
| dixonColes.temporalWeights | currentSeasonDecay / prevBaseWeight / prevDecay | 0.002 / 0.35 / 0.018 |
| dixonColes.bootstrap | bootstrapMode / samples / cvReference | paramNoise / 200 / 0.25 |
| ensemble 🆕 | `enabled` / `weights` | true / {default,oneXTwo,overUnder,btts} = 0.5 |
| specializedModels | dispersionShrinkageStrength / minSampleForTeamDispersion / countDispersionTolerance | 12 / 12 / 0.5 |
| playerShots | distribution / minutesMode / teamInfluenceWeight | ZIP / triangular / 0.35 |
| playerCards | teamYellowInfluenceWeight / minMinutesForStableCards | 0.25 / 900 |
| calibration | enablePerFamilyCalibration / perFamilyMinSamples | true / 120 |
| marketBlending 🆕 | enableLearnedBlendWeights / minSamples / maxShift | true / 80 / 0.18 |
| lineupXg | enableLineupXgAdjustment / replacementRatio / maxXgReduction | true / 0.60 / 0.18 |
| valueBetting | kellyMode / bootstrapUncertainty.enable/weight | quarter / true / 0.35 |
| valueBetting.operational | maxOdds / applyMaxOddsToAllMarkets | 8.00 / true |

## 2. Dixon-Coles — modello goal

File: `backend/src/models/core/DixonColesModel.ts`.

### 2.1 Lambda attese
```
λ_home = exp(attack_home − defence_away + HA_home)
λ_away = exp(attack_away − defence_home)
```
`HA_home` usa `homeAdvantagePerTeam[home]` se abilitato (opt-in), altrimenti `homeAdvantage` globale (default 0.10). I `contextAdjustments` (home/awayGoalMultiplier) moltiplicano le λ quando presenti. Se al predict vengono passati xG pre-partita (>0), si applica anche un blend `λ = 0.6·λ + 0.4·xG` (usato solo quando l'xG è fornito; non in backtest per evitare lookahead).

### 2.1b Mercati derivati dalla score matrix
Da `computeFullProbabilities`: 1X2, BTTS, Over/Under 0.5–4.5, **exact score** (`exact_H-A`), **handicap europeo** (`hcp_home±X`), **asian handicap** (linee −1.75…+1.75, con rimborso/mezzo sul push), doppia chance e DNB (derivati dal 1X2). Tutti coerenti con la stessa matrice.

### 2.2 🆕 Correzione bias di livello per-lega (`levelCorrection`)
Il DC sottostima il livello totale dei goal in misura **eterogenea per lega**. A fit-time si stima, per casa e trasferta separatamente:
```
c_home = Σ(goal reali casa) / Σ(λ_home)      c_away = Σ(goal reali away) / Σ(λ_away)   (clamp [0.85, 1.35])
```
e in `computeExpectedGoals` si applica `λ_home *= c_home`, `λ_away *= c_away`. Persistito in `model_params.levelCorrection`; se assente → fattore 1.0 (retrocompatibile). Impatto: −1.44% logLoss raw; azzera il bias sui totali (over2.5 calibration-in-large z 6.3→0).

### 2.3 xG blend nel fit 🆕
Il fit massimizza una quasi-log-likelihood Poisson su **pseudo-goal**:
```
effGoal = (1 − xgWeight)·goal_reali + xgWeight·min(xG, maxXgValue)     xgWeight = 0.80
```
La correzione τ resta sui goal interi reali. Riduce il rumore della finalizzazione.

### 2.4 Score dependence (τ)
Interfaccia `ScoreDependenceModel.correction(i,j,λH,λA,ρ)`. Classi presenti: **`ClassicDixonColesDependence`** (default) e **`NoDependence`**. *(Le classi Sarmanov/MarCo della v4.1 sono state rimosse.)*
```
τ(0,0)=1−λH·λA·ρ   τ(1,0)=1+λA·ρ   τ(0,1)=1+λH·ρ   τ(1,1)=1−ρ   altrove 1
```
La score matrix è normalizzata e protetta da probabilità negative.

### 2.5 Ottimizzatore e pesi temporali
`fitModel()` usa **Adam** (β1=0.9, β2=0.999, ε=1e-8) su weighted log-likelihood; L2 reg 0.003; normalizzazione Σattack=0. Pesi temporali per stagione con decadimento esponenziale settimanale (§1). ⚠️ `optimizeTemporalWeights()` esiste ma **non ha caller** (codice morto).

### 2.6 Bootstrap
`bootstrapLambdas()` → `lambdaHomeMean/Std`, `lambdaAwayMean/Std`, `uncertaintyFactor`. Modalità `paramNoise` (default, perturbazioni gaussiane); `jackknife`/`hessian` = fallback deterministici.

## 3. 🆕 Ensemble Dixon-Coles + Poisson-xG

File: `backend/src/models/core/PoissonXgModel.ts`, `backend/src/services/ProbabilityEnsembleService.ts`.

Modello partner: Poisson **indipendente** guidato dai rate xG opponent-adjusted, fittato a fit-time sugli stessi match:
```
leagueXG   = media xG per squadra/partita
attackRate[t] = (media xG fatti)/leagueXG    defRate[t] = (media xG subiti)/leagueXG   (shrinkage 8 partite verso 1)
homeAdv    = (xG medio casa)/(xG medio complessivo)
levelScale = (media goal reali totali)/(2·leagueXG)
λH = leagueXG·attackRate[H]·defRate[A]·homeAdv·levelScale     λA = leagueXG·attackRate[A]·defRate[H]·levelScale
```
La griglia Poisson è normalizzata → mercati esattamente coerenti (1X2=1, over+under=1, btts+no=1).

**Blend** (solo mercati goal, PRIMA della calibrazione):
```
p = (1 − w_famiglia)·p_DixonColes + w_famiglia·p_PoissonXg     w = 0.5 (1X2 / OverUnder / BTTS)
```
Combinazione convessa → preserva i vincoli di coerenza. Persistito in `model_params.poissonXg`; assente → no-op. Impatto: **−0.63% logLoss cal, ECE 0.0057→0.0018, t=−5.70 p<1e-5**, consistente su tutti i mercati goal. Non tocca i mercati non-goal.

## 4. Modelli count specializzati

File: `backend/src/models/markets/SpecializedModels.ts`.

### 4.1 Selezione distribuzione + dispersione
```
NegBin  se var > mean + tolleranza (0.5)      Poisson se var ≈ mean      fallback underdispersed = Poisson shrinkato
r (metodo dei momenti) = mean² / (var − mean),  lower bound data-adaptive 1 + 1/√n,  shrinkage verso r di lega (strength 12)
NegBin: Var[X] = μ + μ²/r
```
`negBinOver`, `negBinPMF`, `negBinCDF` in `MathUtils.ts` (logGamma via Lanczos).

### 4.2 Cartellini (`computeCardsDistribution`)
```
μ_giallo_squadra = shrinkToLeague(avgYellow_team, leagueAvgYellow/2, n, 15) · refFactor · foulsBonus · compFactor
```
- `refFactor`, `foulsBonus`: fattori arbitro, **neutri in produzione** (arbitro/falli presenti nell'1–2% dei match → default = media lega).
- 🆕 **`compFactor` (BUGFIX 2026-07):** curva sigmoidale **centrata**
  ```
  compFactor = 1 + 0.22·(2·sigmoid(competitiveness·8 − 4) − 1)
  ```
  Prima era `− 0` (refuso): valeva 1.22 su una partita media e 1.43 sui derby su OGNI match → aspettativa gialli sovrastimata del +26%. Col fix: neutro sulla partita media, ±22% agli estremi, bias +26%→+3.6%. Sul mercato Over gialli: logLoss cal −2.98%, ECE 0.0728→0.0279.
- Rossi: Poisson, fattore arbitro più smorzato. Card points = μ_gialli + 2·(λ_rossi).
- **Correzione gialli↔falli (post-hoc in DixonColesModel):** `yellowFoulsCorrFactor = (falliAttesi/leagueAvgFouls)^0.7 · (0.7 + 0.3·refStrictness)`, applicata a `expectedTotalYellow` e alle O/U gialli quando |fattore−1|>0.02. ⚠️ Inerte in produzione (falli 1–2%).

### 4.3 Falli / Corner / Tiri
- **Falli:** correzione possesso esponenziale, correlazione intra-partita ρ≈0.25. ⚠️ gira su default (dato falli 1–2%).
- **Corner:** NegBin, proxy `avgCornersFor·0.6 + avgCornersAgainst·0.4`. ⚠️ gira su default (dato corner 1–2%).
- **Tiri:** NegBin per squadra e totale, con `SERIE_A_SHOT_GOAL_RATIO = 11.0` per il blend λ→tiri impliciti (α=0.35).

## 5. Mercati per giocatore

- **Tiri/SOT giocatore (runtime):** `SpecializedModels.computePlayerShotsPredictions()` — Dirichlet-multinomiale su medie aggregate, shrinkage share verso prior di ruolo (FW 0.20, MF 0.12, DF 0.05, GK 0.01), r per giocatore via Dirichlet. Output: expectedShots, prob 1+/2+/3+, SOT.
- **Gialli giocatore:** `PlayerCardsModel.predictPlayerYellowCards()` — ZIP. `rate = weight·rawRate + (1−weight)·rolePrior`, moltiplicatori arbitro (smorzato per coverage) e ambiente-squadra `clamp(1 + 0.25·(teamExpYellows/leagueAvg − 1), 0.80, 1.25)`; zero-inflation da minuti.
- ⚠️ **`ShotsModel.ts` (v4: ZIP/ZINB, gerarchico team→player, distribuzione minuti, SOT separato) esiste ma NON è collegato al runtime**: manca una tabella `player_match_stats` (il DB ha solo aggregati). Il runtime usa il Dirichlet aggregato sopra.

## 5b. Costruzione degli input (data layer)

Le medie che alimentano i modelli sopra non sono grezze: vengono aggregate da servizi dedicati.

- **Medie squadra** (`DatabaseService.recomputeTeamAverages` / `TeamAveragesService.ts`): tiri, tiri in porta, gialli, rossi, falli, corner, xG, possesso per squadra, con **decadimento temporale esponenziale** `peso = exp(−DECAY_PER_DAY·(oggi−data))`, `DECAY_PER_DAY = 0.005/giorno` (half-life ≈ 139 giorni). Alimenta `homeTeamStats`/`awayTeamStats` (`avgYellowCards`, `avgShots`, `avgFouls`, `avgHomeCorners`, `sampleSize`, `varShots`…).
- **Stats giocatore** (`PlayerDerivedStatsService.ts`): ricostruite dalle rose in `raw_json` — `avg_xg_per_game`, `shots_per90`, `shotShareOfTeam`, `yellow_cards_total`, `minutes_total`, `gamesPlayed`. Alimentano i mercati player e il lineup xG adjustment.
- **Stats arbitro** (`RefereeDerivedStatsService.ts`): `avgYellow`, `avgFouls`, `avgRed`, `games`, `dispersionYellow`. ⚠️ Copertura arbitro 1–2% → quasi sempre assenti al predict.
- **Ingestione:** `UnderstatScraper.ts` (dati calcio), `OddsApiService`/`odds-provider/*` (quote), `SofaScoreSupplementalScraper.ts` (disattivato).

## 6. Context builder

File: `backend/src/services/PredictionContextBuilder.ts`. Produce `homeGoalMultiplier`, `awayGoalMultiplier`, `home/awayShotMultiplier`, `richnessScore`, e i segnali forma/assenze/motivazione.
```
richnessScore = clamp(0.30 + min(1, n/24)·0.32 + hasBothXG·0.12 + playerCov·0.10 + refCov·0.06, 0.30, 0.93)
```
⚠️ `learnContextWeights()` esiste ma **non ha caller** (i pesi runtime restano quelli di `predictionConfig`).

**🆕 Lineup xG adjustment** (`LineupXgAdjustmentService.ts`, opt-in su richiesta con assenti):
```
multiplier = 1 − quotaXgAssente·(1 − replacementRatio)     replacementRatio = 0.60, cap −18%
```

## 7. Calibrazione isotonica per famiglia 🆕 (nel runtime)

File: `backend/src/services/PredictionService.ts` (`getCalibrationProfile`) + `EnhancedMarketAnalysis.ts`.
Curve isotoniche (PAV) fittate su replay OOS dei match completati, **una per famiglia di mercato** con fallback globale (`perFamilyMinSamples = 120`). Applicate a valle dell'ensemble. Blending bayesiano verso la diagonale: `α = max(0.10, 1/(1 + n/1000))`. È il contributo dominante sulla qualità delle probabilità (ECE quasi dimezzata rispetto alla calibrazione globale).

## 8. Market blending (modello ↔ mercato) 🆕

File: `ValueBettingEngine.blendWithMarketProbability()` + `MarketBlendLearningService.ts`.
```
modelWeight = 0.50 + dataQuality·0.35  (+0.04 goal_1x2/over/btts_yes; −0.04 under/btts_no;
                                        −0.10 player_shots_ot/yellow; −0.16 se manca la companion odd)
peso appreso (se ≥80 campioni): clamp(learned.modelWeight, modelWeight ± 0.18)
modelWeight = clamp(modelWeight, 0.40, 0.84)     p_blend = modelWeight·p_model + (1−modelWeight)·p_noVig
```
Il no-vig si ricava dalle companion odds. Il peso appreso corregge l'euristica entro `maxShift`, senza mai uscire dai bound.

## 9. Value betting

File: `backend/src/models/value/ValueBettingEngine.ts`.
```
EV = p_model·odds − 1     implied_raw = 1/odds     edge = p_model − implied_raw     edgeNoVig = p_model − p_noVig
```
Soglie EV base (`EV_THRESHOLDS`): goal_1x2 3.0% · btts_yes 3.4% · btts_no 5.5% · goal_over 2.8% · goal_under 4.5% · goal_ou 2.5% (legacy) · shots/shots_ot 4.0% · yellow_cards 4.5% · exact_score/handicap 5.0% · other 4.0% · **corners/fouls 12% e comunque disabilitati**. `maxOdds = 8.00`; `MAX_STAKE_PERCENT = 4.0%`.

**Stake — Quarter Kelly** con incertezza bootstrap 🆕:
```
kelly = (p·(odds−1) − (1−p)) / (odds−1)     stake = quarterKelly · confidence
computeSuggestedStakeWithUncertainty: riduce lo stake in funzione di uncertaintyFactor (peso 0.35)
```
`kellyMode='dynamic'` (opt-in): la frazione Kelly scala linearmente con l'incertezza del modello tra `dynamicKellyMaxFraction=0.50` (parametri stabili, u=0) e `dynamicKellyMinFraction=0.10` (instabili, bootstrap CV alto). `computeDynamicEvThreshold` (opt-in) modula la soglia via richnessMultiplier / varianceMultiplier / calibrationPenalty.
`getEffectiveEvThreshold(cat) = baseThreshold + evDelta` (adaptive tuning, §12).

## 10. Combo / multi-bet
```
P_combo = Π p_i     odds_combo = Π odds_i     EV_combo = P_combo·odds_combo − 1
cap = MAX_STAKE·0.6 = 2.4%     MAX_COMBO_STAKE(n) = max(0.5%, 2.4%/√n)     (comboRiskMode = sqrtLegs)
```
`covarianceMonteCarlo` = scaling deterministico da matrice di correlazione; fallback a sqrtLegs se mancano correlazioni.

## 11. Backtesting

File: `backend/src/models/backtesting/BacktestingEngine.ts`. Metriche: ROI, Win Rate, Brier, LogLoss, Sharpe, Max Drawdown, Recovery/Profit Factor; weighted (`metricWeightMode`: none/stake/inverseOdds/marketVariance); `edgeNoVig`, `edgeDecayByMonth`, `rollingSharpe`, calibrazione globale e per-mercato, `marketReports`. `runBacktest()` con temporal holdout + fallback trainRatio.

## 12. Adaptive tuning

File: `backend/src/services/AdaptiveTuningService.ts`.
```
rawEvDelta = −filterRejectionRate·0.010 − rankingErrorRate·0.002 + confirmationRate·0.002 + wrongPickRate·0.004
confidenceScale = clamp(totalWeight/12, 0.2, 1.0)     evDelta = clamp(rawEvDelta·confidenceScale, −0.012, +0.008)
```

## 13. 🆕 Realtà della copertura dati (importante)

Misurata su 7.082 match completati (5 leghe):

| dato | copertura | conseguenza |
|---|---|---|
| gialli, rossi, tiri, tiri in porta, xG | ~50–100% | mercati goal/tiri/gialli affidabili |
| falli, corner, possesso, arbitro | **1–2%** | modelli falli/corner girano su default; effetto arbitro quasi mai attivo |
| rose per-partita (raw_json) | 100% | assenze ricostruibili |

Implicazione: ogni lavoro su falli/corner/arbitro è **speculativo** finché non si abilita una nuova fonte dati (`SofaScoreSupplementalScraper`, oggi disattivato, o FBref).

## 14. Pipeline di predizione (ordine reale)

1. `computeExpectedGoals` → λ con **levelCorrection**
2. `buildScoreMatrix` (τ) → matrice punteggi
3. `computeFullProbabilities` → mercati goal (flat) + mercati specializzati
4. **ensemble** DC + Poisson-xG sui mercati goal (§3)
5. enrich (doppia chance, DNB derivati dal 1X2 blendato)
6. **calibrazione isotonica per famiglia** (§7)
7. **market blending** modello↔mercato dove esistono quote (§8)
8. filtro value + Quarter Kelly con incertezza (§9)

## 15. Mappa file → funzionalità

| File | Funzionalità |
|---|---|
| `config/PredictionEngineConfig.ts` | default e feature flag |
| `models/core/DixonColesModel.ts` | λ, levelCorrection, τ, Adam, xG blend fit, bootstrap, score matrix |
| `models/core/PoissonXgModel.ts` 🆕 | modello Poisson-xG (ensemble) |
| `services/ProbabilityEnsembleService.ts` 🆕 | blend goal DC↔Poisson per-famiglia |
| `models/markets/SpecializedModels.ts` | count models (tiri/gialli/falli/corner), dispersione, bugfix compFactor |
| `models/markets/PlayerCardsModel.ts` | gialli giocatore (ZIP) |
| `models/markets/ShotsModel.ts` ⚠️ | tiri giocatore v4 (non collegato) |
| `services/PredictionService.ts` | pipeline, calibrazione per-famiglia, sanitize params |
| `services/PredictionContextBuilder.ts` | contesto, richnessScore |
| `services/LineupXgAdjustmentService.ts` 🆕 | correzione xG da assenze |
| `services/MarketBlendLearningService.ts` 🆕 | pesi blend appresi |
| `models/value/ValueBettingEngine.ts` | EV/edge, market blend, Kelly, combo, soglie |
| `models/backtesting/BacktestingEngine.ts` | metriche, calibrazione, market reports |
| `services/AdaptiveTuningService.ts` | evDelta |
| `services/TeamAveragesService.ts` + `db/DatabaseService.ts` | medie squadra con decay esponenziale |
| `services/PlayerDerivedStatsService.ts` | stats giocatore da raw_json |
| `services/RefereeDerivedStatsService.ts` | stats arbitro |
| `services/UnderstatScraper.ts`, `services/odds-provider/*`, `OddsApiService.ts` | ingestione dati e quote |
| `config/predictionConfig.ts` | override da env (homeAdvantageScale, context weights, min sample) |
```

## 16. Appendice — servizi operativi e infrastrutturali

Componenti non-modello (plumbing), elencati per completezza. Non contengono formule predittive.

| File | Ruolo |
|---|---|
| `services/OddsApiService.ts`, `odds-provider/OddsApiProvider.ts`, `OddsProvider.ts`, `OddsProviderCoordinator.ts`, `oddsProviderUtils.ts`, `providerRuntimeConfig.ts` | Recupero e normalizzazione quote (The Odds API/Eurobet), coordinamento provider, config runtime |
| `services/OddsApiKickoffSyncService.ts` | Sincronizza gli orari di kickoff con le quote |
| `services/playerProps.ts` | Parsing/normalizzazione delle chiavi mercato player prop (`player_<id>_<market>_<side>_<line>`) |
| `services/BacktestReportService.ts` | Formattazione dei report di backtest |
| `services/SystemObservabilityService.ts` | Osservabilità/telemetria delle run |
| `services/UnderstatScraper.ts`, `SofaScoreSupplementalScraper.ts` | Scraping dati calcio (SofaScore disattivato) |
| `db/DatabaseService.ts` | Accesso libSQL/Turso, schema, medie squadra con decay, snapshot quote |
| `config/algorithmVersions.ts` | Versioning degli algoritmi |
| `api/routes.ts`, `api/predictionPayloadFormatter.ts` | Layer HTTP: endpoint e formattazione payload di predizione |

Con questa appendice il formulario copre **tutti** i file sorgente del backend: strato modello (§2–5), dati (§5b), contesto/value/calibrazione (§6–12), realtà dati (§13), pipeline (§14) e infrastruttura (§16).

---

*Documento generato da revisione diretta del codice `main` (Luglio 2026). Le percentuali di miglioramento provengono dai backtest walk-forward OOS in `docs/performance/`.*
