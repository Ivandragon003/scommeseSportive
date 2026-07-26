# Ingest quote di chiusura — ROI/CLV reale — Luglio 2026

Data: 2026-07-26

Obiettivo: sbloccare la misura del **ROI/CLV reale**. Prima il backtest usava
~96% quote sintetiche → misurabile solo la calibrazione, non il profitto. Le
quote (apertura+chiusura) sono nei CSV football-data che scarichiamo già.

## Stage 1 — parse (`67fe769a`)
`parseFootballDataCsv` estrae 1X2 e O/U 2.5 in apertura (`Avg*`/`BbAv*`/`B365*`)
e chiusura (`AvgC*`/`B365C*`, "C" = Closing), con fallback tra colonne.

## Stage 2 — store (`42de782a`)
La sync football-data salva `{opening, closing}` (formato motore:
`homeWin/draw/awayWin`, `over25/under25`) nella colonna additiva
`matches.fd_odds_json`. Idempotente, non distruttiva. Helper `buildMarketOddsJson`.
Scelta di design: colonna dedicata invece di `odds_snapshots` (Eurobet-shaped) →
stage 3 additivo, senza toccare la macchina ROI/CLV Eurobet.

## Stage 3 — wire + validazione (`e956cfb6`)
- `DatabaseService.getFootballDataHistoricalOddsMap`: legge `fd_odds_json` nel
  formato `HistoricalOddsDetail` (apertura = quota giocata, chiusura = closingOdds).
- `PredictionService.runWalkForwardBacktest`: `{ ...footballData, ...eurobet }`
  → Eurobet reale prevale, football-data riempie i buchi.
- `BacktestingEngine.isTrustedClosingContext` (era `isEurobetClosingContext`):
  accetta closing `football_data` oltre a Eurobet per il CLV, senza rompere il
  path Eurobet.

### Validazione ROI su dati reali (5.322 match Turso matchati, 100% con quote)
| Strategia (quote apertura reali) | n | ROI |
|---|---|---|
| Banca favorito 1X2 | 5322 | −1.32% |
| Banca Over 2.5 (apertura <2.0) | 3716 | −2.58% |
| CLV medio favorito (apertura→chiusura) | 5322 | −0.16% |

Tutti nel range atteso (margine bookmaker visibile, niente NaN/assurdi) → il
settlement e le quote sono corretti. Copertura quote reali **~75%** dei match
(era ~4%).

## Stato / note
- `fd_odds_json` si popola alla **prossima sync notturna**; da quel momento il
  backtest usa quote reali sui mercati goal e riporta ROI/CLV veri.
- Copre 1X2 + O/U 2.5 (i mercati goal core). Altri mercati (BTTS, tiri,
  cartellini, player) restano su quote sintetiche/Eurobet dove presenti.
- Il CLV vero richiede apertura≠chiusura: football-data fornisce entrambe.
