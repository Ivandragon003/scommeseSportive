# Marcatore anytime (E5) — validazione e implementazione — Luglio 2026

Data: 2026-07-26

Nuovo mercato player prop: **marcatore anytime** (P(giocatore segna ≥1 goal)).
Indicato in `model-optimization-status` come "unico margine reale sui giocatori".

## Gate quote — superato
`player_goal_scorer_anytime` ("Anytime Goal Scorer Yes/No") esiste su the-odds-api
per tutte e 5 le leghe. Nota: la doc segnala "US bookmakers" per questi player
props → la provenienza va tracciata (§4), ma il mercato è prezzabile.

## Validazione (as-of, tutte le stagioni, 85.894 osservazioni giocatore-match)
Modello: P(segna) = 1 − e^(−λ), λ = rate/90 × (minuti attesi / 90). Goal per-match
estratti dai roster `raw_json` (prototipo di E2), aggregati as-of.

| Modello | logLoss | Brier | ECE | segna% reale | segna% pred |
|---|---|---|---|---|---|
| da goals/90 | 0.367 | 0.072 | 0.026 | 8.28% | 8.40% |
| **da xG/90** | **0.256** | 0.071 | **0.013** | 8.28% | 9.42% |
| xG/90 + difesa avv. | 0.256 | 0.071 | 0.014 | 8.28% | 9.27% |

**Decisioni:**
- **GO** — il modello è ben calibrato (ECE 0.013).
- **xG/90 batte nettamente goals/90** (logLoss 0.256 vs 0.367) → si usa l'xG.
- La difesa avversaria non aggiunge nulla → v1 senza (resta semplice).
- Lieve sovrastima (9.42% vs 8.28%) → shrink empirico **0.88** su λ
  (`predictionConfig.playerGoals.xgShrink`, override `PLAYER_GOALS_XG_SHRINK`).

## Implementazione
- `playerProps.ts`: nuovo market type `goals` (+ alias scorer/marcatore/anytime).
- `OddsApiService`: parsing `player_goal_scorer_anytime` (Yes/No o nome giocatore)
  → chiave `player_goals_<slug>_over_0.5` (anytime = over 0.5 goal).
- `PredictionService.buildPlayerPropMarkets`: ramo `goals`, P(segna) da `xg_per90`
  × minuti attesi × shrink.
- `ValueBettingEngine`: categoria `player_goals` (soglia EV 0.070, buffer 0.040).
- `routes.ts`: `player_goal_scorer_anytime` tra i mercati richiesti.
- Test: parsing quote (nome / Yes-No) + parsing chiave legacy.

## Scope / limiti
- Il mercato gira sugli **aggregati** `xg_per90` della tabella `players` (come le
  altre player props). La tabella `player_match_stats` (E2 completo) — per
  forma/recency/split casa-trasferta e backtest player — resta **rinviata**: non
  serve al mercato e il pattern recency è storicamente NO-GO.
- Non backtestabile nel `BacktestingEngine` attuale (non valuta i player); la
  validazione è quella as-of qui sopra.
- Minuti attesi = media storica (E4): stima, non formazioni ufficiali.
