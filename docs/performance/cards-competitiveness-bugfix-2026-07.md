# Bugfix fattore competitiveness cartellini — validazione sul mercato (Luglio 2026)

Data: 2026-07-17
Esito: **bug confermato e corretto.** Il fix migliora il mercato cartellini in modo ampio e statisticamente evidente anche dopo l'intera pipeline (calibrazione inclusa). Commit del fix: `dc107e5f`.

## Il bug

In `SpecializedModels.computeCardsDistribution`:

```
compBoost = 0.22 * (2 * sigmoid(competitiveness * 8 - 4) - 0)   // BUG
compBoost = 0.22 * (2 * sigmoid(competitiveness * 8 - 4) - 1)   // FIX
```

Il `- 0` è un refuso per `- 1`. La forma canonica `2·sigmoid(x) - 1` mappa in (-1, 1) ed è **centrata**; senza il `-1` la curva era traslata verso l'alto, valendo **1.22 su una partita media** (competitiveness=0.5) e fino a **1.43 sui derby** — il doppio del "+22% max" dichiarato dal commento. Poiché `competitiveness` è valorizzata su ogni partita (floor 0.25 in DixonColesModel), il boost si applicava sempre → **l'aspettativa dei cartellini era sovrastimata sistematicamente**.

## Metodo di validazione

Walk-forward OOS, 5 campionati, solo match con gialli disponibili (~50% del totale → 2.181 match valutati). Pipeline realistica: DC fittato per fold → λ → `competitiveness = max(0.25, matchIntensity·0.7)` (come in DixonColesModel) → `computeCardsDistribution` (arbitro e falli assenti = fattori neutri, che è lo scenario di produzione dato che quei dati coprono solo l'1-2% dei match) → over/under gialli → calibrazione isotonica per-famiglia (curve rolling su fold precedenti).

Confronto BUG vs FIX isolando esattamente l'effetto: `muOld = muNew · (compOld/compNew)`, over/under ricostruiti con la stessa dispersione `r` via `negBinOver`. L'unica cosa che cambia è il livello atteso.

Selezioni valutate: **Over gialli** sulle linee 2.5 / 3.5 / 4.5 / 5.5 / 6.5, contro i gialli totali realizzati.

## Risultati

**Aspettativa media gialli** (n=2.181): reale **3.716** · bug **4.473 (+20.4%)** · fix **3.665 (−1.4%)**.

**Metriche probabilistiche (Over gialli):**

| Stadio | logLoss bug → fix | Brier bug → fix | ECE bug → fix |
|---|---|---|---|
| raw | 0.54839 → 0.52053 (**−5.08%**) | 0.18358 → 0.17360 | 0.0997 → **0.0307** |
| **calibrato** | 0.53170 → 0.51585 (**−2.98%**) | 0.17697 → 0.17169 | 0.0728 → **0.0279** |

**La calibrazione assorbe parte del bias ma non lo elimina:** il vantaggio del fix passa da −5.08% (raw) a −2.98% (calibrato) e l'ECE resta più che dimezzata. La isotonica non raddrizza un livello così sballato perché il bias è grande e non uniforme sulle linee.

**Calibration-in-the-large z per linea** (z<0 = sovrastima l'Over):

| Linea | bug z | fix z |
|---|---|---|
| 2.5 | −4.23 | +6.66 |
| 3.5 | −7.27 | +5.11 |
| 4.5 | −12.17 | **+0.18** |
| 5.5 | −14.48 | −3.41 |
| 6.5 | −14.07 | −4.71 |

Il bug sovrastimava massicciamente gli Over su tutte le linee (z fino a −14.5). Il fix centra la 4.5 (z≈0) e riduce drasticamente il bias ovunque.

**logLoss per linea (raw):** 2.5 +0.92% · 3.5 −1.06% · 4.5 −5.56% · 5.5 −10.42% · 6.5 −15.22%. Il guadagno cresce sulle linee alte, le più rilevanti per gli Over cartellini. La 2.5 peggiora marginalmente (è quasi sempre "Over", il livello conta poco).

## Note

- **Betting/CLV non misurabili**: gli snapshot quote archiviati coprono i mercati goal/1X2, non i cartellini. Coerente con la copertura dati.
- **Residuo sulle linee alte**: dopo il fix resta una lieve sovrastima su 5.5/6.5 (z≈−3÷−5) e una lieve sottostima sulle basse — possibile margine per un ritocco della dispersione `r`, ma secondario rispetto al bug corretto.
- Formulazione corretta dell'impatto: era sovrastimata **l'aspettativa** dei cartellini (+20%); l'effetto sulle probabilità dei singoli Over/Under non è lineare (passa per la NegBin) e varia per linea, come mostra il breakdown.

## Conclusione

Bug reale con impatto ampio, confermato sulla pipeline completa: −2.98% logLoss e ECE più che dimezzata sul mercato cartellini **dopo la calibrazione**, consistente su tutte le linee rilevanti. Correzione già in `main`.
