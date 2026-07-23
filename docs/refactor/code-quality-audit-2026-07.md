# Audit qualità del codice — Luglio 2026

Data: 2026-07-18

Audit mirato a codice morto, parametri inutilizzati, feature calcolate-ma-non-consumate, duplicazioni e inconsistenze. Nessuna nuova feature né ottimizzazione del modello: solo qualità del codice e difetti reali. Ogni rimozione con build + 223 test verdi e commit atomico.

## Rimozioni eseguite

| # | Intervento | Commit | Note |
|---|---|---|---|
| 1 | `fitNegBinFromObservations`, `overUnderWithConfidence` | `916681b6` | Zero caller ovunque (nemmeno test) |
| 2 | Dipendenza `playwright` (package.json + lock + Dockerfile) | `6c3d9b47` | Nessun `import` in `src`; il Dockerfile scaricava Chromium in 2 stage |
| 3 | Ramo corner morto in `buildAsOfSupp` (I1) | `bc5c022e` | `(m as any).homeCorners` su campo assente da MatchData → sempre undefined; + no-op e loop ridondante. A/B: output backtest **identico** prima/dopo |
| 4 | `refereeAvgTotal` + config `understatOnlyMarkets.{cornersEnabled,foulsEnabled}` | `7fa26543` | Mai letti, mai serializzati, non nello spread di `valueBetting.operational`. Verifica doppia |
| 5 | Dedup `makeNegBinOverUnder` | `75ba38c8` | 4 definizioni locali identiche → 1 metodo privato |
| 6 | Dedup `STAT_MARKET_KEY_RE` | `13d8ab1f` | 3 regex inline identiche → 1 costante di modulo |

## Difetti reali trovati e valutati

- **Corner mai popolati nel backtest** (I1): confermato e sistemato (#3). Impatto funzionale nullo oggi (corner disabilitati), ma il ramo *sembrava* funzionare e non poteva. Il cast `as any` mascherava che `MatchData` non porta i corner e `loadBacktestMatches` non li mappa. Quando il mercato corner verrà riattivato, l'aggregazione va riaggiunta insieme al campo su MatchData e alla mappatura nel loader.
- **Config `noUnusedLocals`/`noUnusedParameters`/`strict` = false** (`tsconfig.json`): è la radice per cui il codice morto si accumula senza che il compilatore lo segnali. Non modificato in questo giro (attiverebbe molti errori da bonificare a parte); segnalato come causa di fondo.

## Elementi NON rimossi (per scelta motivata)

- **`playerFoulsCommittedPer90`**: pur mai valorizzato dal chiamante, è **letto** internamente da `PlayerCardsModel` (applica `foulMultiplier`). Non soddisfa il criterio "mai letto" → è un hook di modello dormiente, non codice morto.
- **4ª regex chiave-mercato** (`getActualStatOutcome`): volutamente più stretta (solo `.`, case-sensitive) su input già normalizzato. Unificarla nella costante condivisa ne allargherebbe il comportamento → lasciata intatta.
- **`optimizeTemporalWeights`, `learnContextWeights`**: morte in produzione ma coperte da test (`v4-completion`). Rimuoverle richiede togliere anche i test; non a costo zero come le altre. Recent Form è NO-GO, quindi restano candidate ma non urgenti.

## Feature calcolate ma non consumate (note, non rimosse)

Registrate per riferimento (rimozione o collegamento sono lavoro separato, alcuni con implicazioni di prodotto): finestre `recent.last5/last10`; statistiche stagionali (`cleanSheetsTotal`, `goalDiff`, `xgForPerMatch`); metriche giocatore archiviate (`goal_conversion`, `shots_per90`, `cards_per90`, `total_goals`, `shot_on_target_pct`, `avg_xgot_per_game`, `red_cards_total`); totali/rate squadra. Dettaglio in [`../performance/model-optimization-status-2026-07.md`](../performance/model-optimization-status-2026-07.md).

## Esito

Audit del codice **concluso**. Da qui in poi nessuna ulteriore pulizia salvo bug reali.
