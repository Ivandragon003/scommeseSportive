# I1 — Dati supplementari as-of-date nel backtest — Luglio 2026

Data: 2026-07-18
Commit: `fefe4962`
File: `backend/src/models/backtesting/BacktestingEngine.ts`
Test: `backend/test/backtest-asof-supp.test.js`

## Problema osservato (dimostrato a runtime)

`BacktestingEngine` invocava il modello **senza il 5° argomento `supp`**:

```ts
this.model.computeFullProbabilities(homeId, awayId, homeXG, awayXG)  // supp assente
```

Misurato instrumentando il prototipo durante un fold reale (Serie A): **1018 chiamate su 1018 con `supp` undefined (100%)**. Per contrasto, in produzione la predizione servita ha `supp` popolato con dati reali (verificato: Genoa avgYellow 1.42, avgFouls 10.6, avgCorners 5).

### Conseguenze dimostrate

- Cartellini, falli, corner e tiri giravano su `SERIE_A_DEFAULTS` + λ, **mai** su medie squadra reali, arbitro o competitiveness.
- I **corner non venivano nemmeno calcolati** (il gate `hs.avgHomeCorners !== undefined` era sempre falso).
- Qualunque esperimento sui mercati count misurava i **default**, non il modello → risultati non trasferibili alla produzione.

## Intervento

Helper `buildAsOfSupp` / `computeAsOfTeamRecord` / `computeAsOfRefereeRecord` che replicano in-memory la costruzione di `supp` di produzione (`recomputeTeamAverages` + `PredictionContextBuilder.buildTeamStats`), aggregando **solo** i match con `date < D`:

- medie **decadute** (`exp(-0.005·giorni)`, riferimento = data partita) e **split per venue**;
- gialli/rossi/falli **combinati** cross-venue pesati, come in produzione;
- varianza (non decaduta), `sampleSize` per venue, possesso, suppression;
- arbitro: medie sui match passati con lo stesso arbitro;
- guardia anti-leakage esplicita (difensiva) oltre al filtro `< D`;
- toggle `asOfSupplementaryData` (default **ON**) per A/B legacy vs fedele.

## Validazione di fedelta'

Confronto campo-per-campo su **100 osservazioni-squadra, 5 leghe**, contro la **formula di produzione valutata allo stesso cutoff D** (SQL di `recomputeTeamAverages` con `date < D` e decadimento riferito a D).

> Nota metodologica: confrontare direttamente con `PredictionContextBuilder` sarebbe stato **invalido**, perche' in produzione legge la tabella `teams` calcolata su tutta la storia fino a `now`, non as-of. Si sarebbero confrontati insiemi di partite diversi.

| Campo | MAE | max | bias | err. rel. medio |
|---|---|---|---|---|
| avgShots | 0.0000 | 0.0002 | +0.0000 | **0.00%** |
| avgShotsOT | 0.0000 | 0.0001 | +0.0000 | **0.00%** |
| avgYellowCards | 0.0000 | 0.0000 | −0.0000 | **0.00%** |
| avgFouls | 0.0000 | 0.0001 | −0.0000 | **0.00%** |
| avgCorners | 0.0000 | 0.0001 | −0.0000 | **0.00%** |
| shotsSuppression | 0.0000 | 0.0000 | +0.0000 | **0.00%** |
| sampleSize | 0.0000 | 0.0000 | +0.0000 | **0.00%** |
| varShots | 0.047 | 2.79 | +0.047 | 0.19% |
| varShotsOT | 0.006 | 0.29 | +0.006 | 0.09% |
| varYellowCards | 0.001 | 0.04 | +0.001 | 0.04% |
| varFouls | 0.478 | 15.5 | +0.478 | 5.64% |

Medie, suppression e sampleSize replicano la produzione in modo **esatto**. Le varianze combaciano entro 0.04–0.2% (falli 5.6% con outlier a basso campione).

**Differenza sistematica sulle varianze (bias sempre positivo).** Spiegazione **ipotetica, non verificata con esperimento dedicato**: la formula SQL di produzione `AVG(x²) − AVG(x)²` soffre di cancellazione catastrofica (piu' marcata sui falli, valori grandi), mentre l'helper usa la deviazione dalla media, numericamente piu' stabile. Se corretta, l'helper sarebbe **piu' accurato**, non meno. In ogni caso la varianza e' un input di secondo ordine (parametro di dispersione `r`).

## Verifiche post-intervento

- `supp` popolato in **5080/5120** chiamate (le 40 restanti sono match iniziali senza storico — corretto).
- **Nessuna eccezione** di leakage.
- **Mercati goal invariati** (goal_1x2 0.6642 vs 0.6649 baseline) → nessuna regressione, e conferma che `supp` non tocca il path goal.
- Suite test completa verde + 6 test dedicati (anti-leakage, split venue, combinazione cross-venue, arbitro, campi volutamente null).

## Campi volutamente non popolati

`competitiveness` / `isDerby` (il modello li deriva da λ), `contextAdjustments` (forma/motivazione/assenze sono input di request, assenti nello storico), `leagueAvgYellow` / `leagueAvgFouls` / `homeAdvantageShots` (**la produzione stessa li lascia ai default**, quindi popolarli disallineerebbe), `homePlayers` / `awayPlayers` (fuori scope).

Conseguenza: I1 sblocca la misurabilita' dei mercati **team-count**, **non** delle context-adjustment ne' delle player props.

## Blocchi residui scoperti (I1 e' necessario ma non sufficiente)

1. **`DISABLED_CATEGORIES = {corners, fouls}`** (`ValueBettingEngine.ts` ~627): corner e falli danno **0 bet** anche con `supp` popolato.
2. **logLoss/Brier calcolati solo sulle bet selezionate** (`BacktestingEngine.ts` ~2609): i confronti fra varianti di modello sono **confusi dalla selezione**. Per decidere un parametro serve una metrica selection-independent (usata per `shot-goal-ratio-2026-07.md`).
