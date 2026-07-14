# Backtest comparativo con ablazione delle feature — Luglio 2026

Data esecuzione: 2026-07-14
Script: walk-forward out-of-sample (scratchpad `ablation-backtest.js`), dati Turso di produzione.

## Setup

- **Dati**: 3.504 partite completate (Serie A, Premier League, La Liga, Bundesliga, Ligue 1; stagioni 2024/25 e 2025/26), 100% con xG e statistiche match. 213 partite completate con quote archiviate in `odds_snapshots`.
- **Protocollo**: finestra espansiva con refit ogni 60 partite (train iniziale 300). Curve di calibrazione e pesi di blending fittati **solo su campioni out-of-sample dei fold precedenti**. Al predict non viene passato l'xG della partita (evita lookahead). Quote "prese" = primo snapshot disponibile; closing = ultimo snapshot pre-kickoff (fonte CLV).
- **Selezioni tracciate**: 1X2, doppia chance, DNB, over/under goal 1.5/2.5/3.5, BTTS, più totali tiri/tiri in porta/gialli/falli/corner (linee dal modello).

## Metriche probabilistiche (walk-forward, n=186.570 campioni condivisi)

| Variante | LogLoss | Brier | ECE | Note |
|---|---|---|---|---|
| `raw_noxg` (fit solo goal, no calibrazione) | 0.58781 | 0.19823 | 0.03602 | n=219.436 |
| `raw_xg` (fit ibrido goal+xG) | 0.58433 | 0.19686 | 0.03318 | n=219.436 |
| **`cal_global_noxg` = versione precedente** | **0.57299** | **0.19520** | **0.03193** | baseline |
| `cal_global_xg` (= prec. + n.1) | 0.57092 | 0.19415 | 0.03496 | |
| **`cal_family_xg` = versione attuale (n.1+n.6)** | **0.55357** | **0.18880** | **0.01971** | |

### Contributi isolati

| Feature | Δ LogLoss | Δ Brier | Δ ECE | Verdetto |
|---|---|---|---|---|
| **n.1 xG blend** (fit) | −0.36% (−0.59% sul raw) | −0.54% | −8% sul raw; lievemente peggio post-calibrazione globale | Miglioramento piccolo ma consistente su tutte le metriche raw |
| **n.6 calibrazione per famiglia** | **−3.04%** | **−2.76%** | **−43.6%** | **Il contributo dominante** |
| **Cumulativo (prec. → attuale)** | **−3.39%** | **−3.28%** | **−38.3%** | |

## n.3 — Blending modello↔mercato (solo partite con quote, n=1.215 selezioni)

| Probabilità | LogLoss | Brier | ECE |
|---|---|---|---|
| Solo modello (calibrato) | 0.61893 | 0.21563 | 0.02392 |
| Solo mercato (no-vig) | 0.61523 | 0.21344 | 0.05164 |
| Blend euristico | 0.61528 | 0.21383 | **0.01784** |
| Blend con pesi appresi | 0.61558 | 0.21396 | 0.01783 |

- Il **meccanismo di blending** funziona: log-loss quasi al livello del mercato (che da solo batte il modello) e **ECE migliore di entrambi** (−25% vs solo modello, −65% vs solo mercato).
- Il **peso appreso** oggi è neutro rispetto all'euristica: con ~50 partite quotate per campionato lo storico per categoria raramente supera la soglia minima (80 campioni), quindi i pesi appresi si attivano poco e quando si attivano coincidono di fatto con l'euristica. **Diventerà misurabile man mano che l'archivio odds cresce** (lo scheduler snapshot è attivo).

## Simulazione scommesse (campione ridotto: ~150 partite con quote — indicativo)

| Variante | Bet | ROI (stake Kelly) | ROI flat | Win rate | CLV medio | CLV>0 |
|---|---|---|---|---|---|---|
| Precedente (`prev`) | 258 | +2.9% | +11.7% | 34.9% | +2.39% | 45.3% |
| Attuale (`curr`) | 115 | +0.7% | +4.6% | 33.0% | **+3.69%** | **48.2%** |
| Attuale + pesi appresi | 115 | −0.2% | +4.6% | 33.0% | +3.69% | 48.2% |
| Attuale + Kelly dinamico (n.7) | 114 | **+1.5%** | +2.5% | 32.5% | +3.74% | 48.7% |

Letture (con la cautela dovuta al campione):
- La pipeline attuale genera **il 55% di bet in meno** (115 vs 258): la calibrazione per famiglia sgonfia le probabilità ottimistiche e rende il filtro value più selettivo.
- Il **CLV migliora** (+2.4% → +3.7% medio; quota di bet che battono la closing 45% → 48%): meno bet, ma di qualità di processo migliore. Su campioni così piccoli il CLV è il segnale più affidabile; le differenze di ROI sono rumore (±1σ ≈ ±11% su 115-258 bet flat).
- **n.7 Kelly dinamico**: a parità di selezioni, alza lo stake sui match a parametri stabili (staked +16%) e ha migliorato il ROI del campione (+0.7% → +1.5%). Una bet marginale in meno (l'incertezza bootstrap l'ha spinta sotto soglia). Direzionalmente coerente con il design; campione insufficiente per una conclusione forte.

## n.4 — Aggiustamento xG da assenze

**Non misurabile in backtest**: il DB non registra le assenze storiche per partita. La feature è coperta da test unitari; per misurarne l'impatto serve accumulare richieste di predizione con `homeAbsentPlayers`/`awayAbsentPlayers` valorizzati e confrontare a posteriori.

## Conclusioni

1. **n.6 (calibrazione per famiglia)** è il miglioramento reale dominante: −3% log-loss, ECE quasi dimezzato. Da sola giustifica l'upgrade.
2. **n.1 (xG blend)** dà un miglioramento piccolo ma consistente e gratuito.
3. **n.3**: il blending in sé migliora la calibrazione; il *peso appreso* è oggi inerte per mancanza di storico quote — rivalutare tra qualche mese di snapshot.
4. **n.7**: comportamento direzionalmente corretto (più stake dove il modello è stabile), segnale ROI positivo ma non significativo; il Kelly dinamico resta opt-in (`kellyMode: 'dynamic'`).
5. La versione attuale scommette molto meno e con CLV migliore: meno azione, processo più sano.
