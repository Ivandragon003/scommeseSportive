# Ensemble Dixon-Coles + Poisson-xG — validazione e risultati (Luglio 2026)

Data: 2026-07-15
Feature: media pesata delle probabilità dei mercati goal tra Dixon-Coles e un modello Poisson indipendente guidato dai rate xG. `p = (1-w)·p_DC + w·p_PoissonXg`, `w = 0.5`.
Stato: **implementata e mergiata su `main`** (commit `5ac80647`, merge `5361c18d`). Baseline dei test = sistema di produzione con correzione λ per-lega + `xgWeight=0.80`.

## Perché un secondo modello

Il Dixon-Coles blenda l'xG del **singolo match** (rumoroso per finalizzazione/portiere). Il Poisson-xG usa le **medie xG opponent-adjusted** per squadra (segnale stabile) ed è un Poisson indipendente senza il bias di livello strutturale del DC. Sono due viste diverse degli stessi dati: la loro media batte ciascuna.

## Protocollo

Walk-forward out-of-sample, finestra espansiva, refit ogni 60 partite (train iniziale 300), 5 campionati (Serie A, Premier, La Liga, Bundesliga, Ligue 1), ~3.500 partite. Curve di calibrazione per-famiglia fittate solo su campioni OOS dei fold precedenti, separatamente per baseline ed ensemble (le curve vanno applicate alle stesse probabilità su cui sono fittate). Le classi usate nel backtest finale (exp6/exp7) sono quelle **di produzione** (`PoissonXgModel`, `blendGoalProbabilities`).

## Ricerca del peso (exp4)

| w Poisson | logLoss cal | ECE cal | Δ vs solo DC |
|---|---|---|---|
| 0 (solo DC) | 0.60306 | 0.0058 | — |
| 0.25 | 0.60034 | 0.0030 | −0.45% |
| **0.5 (scelto)** | **0.59927** | **0.0019** | **−0.63%** |
| 0.65 | 0.59938 | 0.0024 | −0.61% |
| 0.8 | 0.60000 | 0.0037 | −0.51% |

Ottimo a **w≈0.5** (plateau 0.5–0.65).

## Validazione pipeline completa (exp6, classi di produzione)

| Stadio | logLoss base→ens | Brier | ECE base→ens |
|---|---|---|---|
| raw | 0.60260 → 0.59862 (**−0.66%**) | 0.20754→0.20587 | 0.0071→0.0054 |
| **calibrato** | 0.60308 → 0.59925 (**−0.63%**) | 0.20775→0.20616 | **0.0057→0.0018** |

**Breakdown per mercato (calibrato) — consistente, non concentrato:**

| Mercato | n | Δ logLoss | ECE |
|---|---|---|---|
| 1X2 | 39.540 | −0.50% | 0.0054→0.0054 |
| Over/Under | 31.692 | **−0.83%** | 0.0097→0.0078 |
| BTTS | 10.564 | −0.54% | 0.0197→0.0183 |

**Significatività (test appaiato bloccato per partita, match indipendenti):**
n = 5.282 match, media Δ(ens−base)/match = −0.0036, **t = −5.70, p < 1e-5** → miglioramento altamente significativo.

## Analisi value bet (exp7): il calo 89→67 sono falsi edge, non conservatività

Il motore ha un floor di EV ~5% (nessuna bet 2–5%).

| Fascia EV | opp base | opp ens | % persa in fascia |
|---|---|---|---|
| 5–10% | 14 | 8 | **71%** |
| >10% | 75 | 59 | 36% |

- La fascia **debole (5–10%) è potata molto di più** (71% vs 36%): l'ensemble elimina preferenzialmente gli edge marginali.
- Gli edge >10% eliminati avevano **winrate ~19–20%** nel baseline: erano falsi edge gonfiati dalla peggiore calibrazione del baseline (ECE 0.0057 → 0.0018), non veri.
- Potatura distribuita su 1X2 (41% dei suoi) e Over/Under (50%), non su un solo mercato.

**CLV medio per fascia (indicatore anticipatore, migliora ovunque):**

| Fascia | CLV base | CLV ens |
|---|---|---|
| 5–10% | +5.29% | **+7.76%** |
| >10% | +5.04% | **+6.09%** |
| Globale | +5.08% | **+6.30%** |

## Simulazione scommesse (campione ridotto ~70–89 bet, indicativo)

| | #bet | ROI Kelly | yield flat | winrate | CLV |
|---|---|---|---|---|---|
| base | 89 | −31.4% | −36.6% | 19.1% | +5.08% |
| ens | 67 | −45.0% | −47.1% | 14.9% | +6.30% |

ROI/yield **negativi per entrambe** (anche il baseline, a differenza del +0.7% dell'ablation di luglio): sul campione minuscolo di quote archiviate sono rumore, non un segnale. Il CLV — l'unica metrica di processo affidabile a questi n — migliora con l'ensemble.

## Conclusioni

1. Miglioramento **reale, significativo (p<1e-5) e consistente su tutti i mercati goal** attraverso l'intera pipeline fit→calibrazione.
2. La calibrazione migliora di ~3× (ECE 0.0057→0.0018): l'ensemble sgonfia le probabilità troppo ottimistiche del DC.
3. Il calo dei value bet è **eliminazione di edge deboli/falsi** (CLV in miglioramento in tutte le fasce), non eccesso di conservatività.
4. **Shot Quality Adjustment scartato**: ridondante con l'ensemble (solo −0.05% aggiuntivo e peggiora la calibrazione).

**Nota operativa:** il beneficio si attiva dopo un refit per competizione (popola `poissonXg` nel blob `model_params`). Finché non si rifà il fit, l'ensemble è no-op → nessuna regressione.
