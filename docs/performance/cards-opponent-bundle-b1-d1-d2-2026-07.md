# Bundle falli/cartellini B1 + B3 + D1 + D2 — esperimenti e decisioni — Luglio 2026

Data: 2026-07-26

Obiettivo: dare al modello cartellini il termine avversario e (eventualmente) la
correlazione casa/ospite. Valore concentrato sui **cartellini** (mercato attivo,
ora backtestabile correttamente dopo A6). Falli non tradeable (nessuna quota).

Metodo: backtest di **calibrazione as-of** su tutte le stagioni (6.621 match
testati, ≥6 gare per squadra), metrica selection-independent (logLoss / Brier /
ECE) sui booking points (`gialli + 2·rossi`), linee 3.5 / 4.5 / 5.5.

## B1 — split casa/trasferta dei gialli — NO-GO

Usare la media gialli in casa (per la squadra di casa) e in trasferta (per
l'ospite) invece della media overall **peggiora in tutte e 5 le leghe**
(logLoss ALL 0.63983 vs 0.63823 baseline). Lo split dimezza il campione e il
rumore supera il segnale casa/trasferta. **Scartato.**

## D1 — termine avversario sui gialli — GO (opzione 2: `fouls_drawn`)

I gialli di una squadra crescono con i falli **subiti** dall'avversario
(`fouls_drawn` = quanto l'avversario "provoca"). Confronto delle due opzioni,
termine applicato come post-moltiplicatore sulla media (clamp [0.7, 1.4]):

| Variante | logLoss ALL | ECE ALL |
|---|---|---|
| baseline (no avversario) | 0.63823 | 0.0196 |
| Opzione 1 — cartellini indotti | 0.63559 | 0.0204 |
| **Opzione 2 — `fouls_drawn`** | **0.63512** | **0.0166** |

Opzione 2 vince overall + 3/5 leghe testa a testa, ECE migliore, ed è più
semplice (`fouls_drawn`/B3 già calcolato). **Rivalidazione come SOSTITUZIONE**
della vecchia `yellowFoulsCorrFactor` (mal calibrata: shrink ×0.85 ad arbitro
assente → ECE 0.07–0.11 fuori Premier):

| Lega | logLoss produzione | logLoss D1 | Δ |
|---|---|---|---|
| ALL | — | — | **+1.45%** |
| Serie A | 0.63929 | 0.62609 | +2.07% |
| Bundesliga | 0.65925 | 0.64430 | +2.27% |
| Ligue 1 | 0.64206 | 0.62428 | +2.77% |
| Premier | 0.63415 | 0.62886 | +0.83% |
| La Liga | 0.65043 | 0.65240 | −0.30% |

Migliora 4/5 leghe, ECE ~−78%. `both` (stack D1 + vecchia correzione) peggiora →
conferma la sostituzione. **Implementato** (commit `e9c9166b`): `fouls_drawn`
letto da `PredictionContextBuilder`, aggregato as-of nel `BacktestingEngine`,
propagato anche ai booking points.

## D2 — correlazione casa/ospite sui gialli — NO-GO

Correlazione empirica reale ρ ≈ 0.18 (0.13 Serie A → 0.22 La Liga): esiste. Ma
aggiungerla alla varianza del totale (sopra D1) dà risultati **marginali e
incoerenti**:

- logLoss ALL: −0.04% (ρ=0.12) — dentro il rumore.
- Migliora La Liga/Bundesliga (anche ECE), **peggiora Serie A / Premier / Ligue 1**.
- Nessun ρ robusto cross-lega.

Causa probabile: il NegBin con dispersione dinamica `r` per-squadra **ingrossa
già** le code; la correlazione doppia-conta l'overdispersion dove `r` la cattura.
**Scartato**, coerente con la filosofia "no complessità per guadagni marginali
non consistenti".

## Esito del bundle
- **B1:** NO-GO (split gialli peggiora 5/5).
- **B3 + D1 opzione 2:** GO, implementato (`fouls_drawn` come termine avversario,
  sostituisce la correzione grezza; +1.45% logLoss, ECE −78%, 4/5 leghe).
- **D2:** NO-GO (marginale/incoerente).
- **B2 / B7:** non affrontati (marginali; corner disabilitati).
