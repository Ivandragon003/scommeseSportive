# SHOT_GOAL_RATIO 11.0 → 9.0 — Luglio 2026

Data: 2026-07-18
Commit: `065a75c8`
File: `backend/src/models/core/DixonColesModel.ts` (~491)

## Contesto

Il modello tiri stima i tiri impliciti dai λ Dixon-Coles con un blend:

```
tiri_attesi = 0.65 · avgShots_squadra + 0.35 · (λ · SHOT_GOAL_RATIO)
```

La costante era hardcoded a **11.0** e si chiamava `SERIE_A_SHOT_GOAL_RATIO`, ma veniva applicata a tutte e 5 le leghe.

## Osservazione

Ratio reale tiri-totali/goal misurato sul DB (7.076 match, 4 stagioni):

| Lega | ratio reale |
|---|---|
| Bundesliga | 8.23 |
| Premier League | 8.79 |
| Ligue 1 | 8.84 |
| La Liga | 9.36 |
| Serie A | 9.84 |

Media ~9.0. Il valore 11.0 **sovrastimava i tiri impliciti in tutte le leghe**, nessuna esclusa.

## Classificazione

**Parametro subottimale — NON un bug di implementazione.** Il codice applicava correttamente il design previsto; era il valore numerico a essere empiricamente sbagliato. Distinzione mantenuta volutamente: una costante che migliora dopo il tuning non e' un bug.

## Metodo

Due misurazioni successive, la prima scartata perche' metodologicamente viziata.

### Tentativo 1 (SCARTATO) — metrica confusa dalla selezione

Backtest walk-forward standard, confronto del `logLoss` per-mercato. **Invalido**: il `logLoss`/`Brier` del backtest sono calcolati **solo sulle bet selezionate** (`BacktestingEngine.ts` ~2609), e configurazioni diverse selezionano bet diverse. Il confronto misurava insiemi differenti, non la calibrazione. Su questa metrica 9.0 sembrava *peggiorare* (0.6619 → 0.6803): risultato spurio.

### Tentativo 2 (VALIDO) — metrica selection-independent

Scoring su **tutte** le linee over/under tiri totali di **tutti** i match di test (non solo le bet selezionate), sulla pipeline fedele con `supp` as-of-date (vedi `backtest-asof-supp-i1-2026-07.md`). Walk-forward 4 fold, 4 stagioni, 5 leghe.

## Risultati

| Lega | logLoss 11→9 | Brier 11→9 | ECE 11→9 | n oss. |
|---|---|---|---|---|
| Serie A | 0.6437 → **0.5821** | 0.2177 → 0.1978 | 0.1596 → **0.0772** | 9.576 |
| Premier League | 0.7199 → **0.6191** | 0.2344 → 0.2074 | 0.1999 → **0.1193** | 9.576 |
| La Liga | 0.6070 → **0.5645** | 0.2024 → 0.1890 | 0.1255 → **0.0572** | 9.576 |
| Bundesliga | 0.6922 → **0.5924** | 0.2187 → 0.1914 | 0.1920 → **0.1125** | 7.714 |
| Ligue 1 | 0.6464 → **0.5693** | 0.2126 → 0.1892 | 0.1732 → **0.0929** | 8.190 |

- **5/5 leghe migliorano tutte e tre le metriche.** Sign test appaiato p ≈ 0.031.
- **ECE circa dimezzato** ovunque: 11.0 sovrastimava sistematicamente P(over tiri).
- Paired-t per-osservazione (Serie A): t ≈ −25.4 su n = 9.576.
- `shots_on_target` invariato, come atteso (il ratio tocca solo i tiri totali).

## Limiti dichiarati

- **ROI/CLV non validati**: il 96% delle quote nel backtest e' sintetico (derivato dalle probabilita' del modello stesso). Solo logLoss/Brier/ECE sono affidabili su questo dataset.
- La metrica valuta le probabilita' **grezze** del modello, prima della calibrazione per-famiglia e del market blending di produzione. E' il livello corretto per valutare *questo* parametro, ma non equivale al P&L finale.
- **La calibrazione dei tiri resta imperfetta anche a 9.0** (ECE 0.06–0.12): c'e' margine oltre il solo ratio. Non e' stato esplorato un ottimo per-lega ne' valori diversi da 9.0.

## Decisione

**Implementato** (`SHOT_GOAL_RATIO = 9.0`, costante rinominata perche' non piu' specifica della Serie A). Build verde, suite test completa verde.
