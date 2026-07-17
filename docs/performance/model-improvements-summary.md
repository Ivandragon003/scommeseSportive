# Riepilogo interventi valutati sul modello — indice go/no-go

Ultimo aggiornamento: 2026-07-17

Indice unico di tutti gli interventi valutati, per non ririprendere idee già testate né dimenticare perché sono state scartate. Metodo comune: **backtest walk-forward out-of-sample sull'intera pipeline di produzione** (fit → ensemble → calibrazione per-famiglia → eventuale market blending → value bet), 5 campionati (~3.500 partite goal, ~2.200 con dati cartellini), metriche probabilistiche (logLoss/Brier/ECE) e, dove ha senso, test di significatività appaiato per partita.

Legenda stato: ✅ **Implementato** · ❌ **NO-GO** · ⛔ **Bloccato** (dati insufficienti).

## Implementati

| Intervento | Stato | Metrica principale | Significatività | Motivazione | Rif. |
|---|---|---|---|---|---|
| Correzione bias λ per-lega (`levelCorrection`) | ✅ | logLoss raw **−1.44%**; azzera il bias di livello sui totali (over2.5 calibration-in-large z 6.3→0) | forte sul raw; neutro sul betting (già corretto dal blending) | Il DC sottostima il livello dei goal in modo eterogeneo per lega (Serie A ~1.05, Bundesliga ~1.32); fattore `c` per-lega stimato a fit-time | `lambda-level-bias-analysis-2026-07.md`, commit `6b1a9814` |
| `xgBlend.xgWeight` 0.60 → **0.80** | ✅ | logLoss cal **−0.11%**, ECE cal 0.0060→0.0041 | piccolo ma consistente | Ottimo empirico (plateau 0.75–0.85); oltre 0.85 la logLoss ririsale | `feature-ablation-2026-07.md`, commit `6b1a9814` |
| Ensemble Dixon-Coles + Poisson-xG (w=0.5) | ✅ | logLoss cal **−0.63%**, ECE 0.0057→**0.0018** (3×), Brier −0.8% | **t=−5.70, p<1e-5** (appaiato per partita); consistente su 1X2/O-U/BTTS | Poisson indipendente su rate xG opponent-adjusted = "secondo parere" che il DC (blend xG per-match) non cattura | `ensemble-poisson-xg-2026-07.md`, commit `5ac80647` |
| Bugfix fattore competitiveness cartellini (`- 0` → `- 1`) | ✅ (bug) | aspettativa gialli +26% → **+3.6%**; Over gialli logLoss cal **−2.98%**, ECE 0.0728→0.0279 | calibration-in-large: il bug sovrastimava gli Over su tutte le linee (z fino a −14.5), il fix centra la 4.5 (z≈0) | Refuso: la curva non era centrata → +22% su una partita media, +43% sui derby, su ogni match | `cards-competitiveness-bugfix-2026-07.md`, commit `dc107e5f` |

## NO-GO

| Intervento | Stato | Metrica principale | Significatività | Motivazione | Rif. |
|---|---|---|---|---|---|
| Dynamic xG Blend — auto-peso globale per-fold | ❌ | logLoss cal **−0.07%** vs peso fisso ritarato | non rilevante | La selezione dinamica non batte un peso fisso a 0.80; complessità inutile | `feature-ablation-2026-07.md` |
| Dynamic xG Blend — peso xG per-squadra (ricchezza dati) | ❌ | logLoss cal **−0.01/−0.02%** | rumore | Il peso statico 0.80 è già near-ottimale; nessun segnale per-squadra. *Chiuso definitivamente in 2 formulazioni* | `recent-form-half-life-2026-07.md` |
| Shot Quality Adjustment (regolarizza xG/tiro verso lega) | ❌ | da solo −0.24%, ma **+solo −0.05%** sopra l'ensemble | — | Ridondante con l'ensemble; in combo peggiora anche la calibrazione (ECE 0.0019→0.0026) | `shot-quality-ensemble` (memoria), `ensemble-poisson-xg-2026-07.md` |
| Recent Form adattiva (half-life ottimizzata) | ❌ | −0.50% sul DC isolato, ma **−0.02%** con ensemble attivo | **p=0.65** (non significativo) | Ensemble e recency correggono lo stesso difetto (miscalibrazione DC); non additive. ECE peggiora | `recent-form-half-life-2026-07.md` |
| Calibrazione per tipo di squadra (forti/deboli) | ❌ | logLoss cal **−0.02/−0.03%** | **p=0.35–0.48** | Stratificare (famiglia × forza) frammenta i campioni; ECE peggiora (0.0019→0.0037). L'ensemble ha già saturato la calibrazione | `player-adjustment-strength-calibration-2026-07.md` |
| Player Adjustment (assenze): algoritmo attuale | ❌ | logLoss cal **+0.01%** (peggio) | **p=0.90** | Il DC cattura già le assenze via risultati recenti; `replacementRatio=0.60` troppo pessimista | `player-adjustment-strength-calibration-2026-07.md` |
| Player Adjustment (assenze): avanzato (att/dif + ruoli) | ❌ | logLoss cal **−0.02%** | **p=0.57** | Segnale reale (54% match con ≥1 assente, moltiplicatori 0.82–1.11) ma non migliora le predizioni | `player-adjustment-strength-calibration-2026-07.md` |
| Parametro per-lega `leagueAvgYellow` (3.8 → media reale) | ❌ | logLoss raw **+0.38%** (peggio), cal +0.04% | **p=0.016 nella direzione opposta** | Nell'attuale modello/pipeline il 3.8 globale produce risultati migliori sui gialli (causa non dimostrata) | `per-league-yellow-param-2026-07.md` |
| Vantaggio casa per-squadra | ❌ | nessun guadagno OOS | — | Il bias è di livello totale, non casa-specifico (→ risolto da `levelCorrection`) | `per-team-home-advantage-analysis-2026-07.md` |

## Bloccati (dati insufficienti)

| Intervento | Stato | Motivazione | Rif. |
|---|---|---|---|
| Corner concessi (modello dedicato vs proxy) | ⛔ | Corner reali presenti nell'**1–2%** dei match: impossibile tarare/validare un modello dedicato | `data-coverage-gaps` (memoria) |
| Parametri per-lega falli e corner | ⛔ | Falli e corner all'**1–2%** di copertura: nessun dato su cui stimare i default per-lega | `data-coverage-gaps` (memoria) |
| Effetto arbitro (refactor del triplo conteggio) | ⛔ | Arbitro presente nell'**1–2%** dei match → il codice quasi mai si attiva: refactor senza impatto né validabile | `data-coverage-gaps` (memoria) |

## Conclusioni operative

1. **I mercati goal sono saturi** dopo l'ensemble (ECE calibrata 0.0019). Recent Form, Dynamic xG, Shot Quality, Calibrazione per forza e Player Adjustment sono tutti NO-GO con la stessa diagnosi: non resta miscalibrazione da correggere. **Non riproporre feature sui mercati goal senza un'ipotesi sostanzialmente nuova.**
2. **Il bug cartellini era l'unico problema reale** tra i "miglioramenti al modello esistente", ed è corretto e validato.
3. **Falli/corner/possesso/arbitro sono inutilizzabili** finché non si abilita una nuova fonte dati (esiste `SofaScoreSupplementalScraper`, disattivato via `operational.sofascoreSupplementalEnabled=false`, oppure FBref).
4. **Regole metodologiche apprese** (valide per ogni valutazione futura):
   - misurare sempre sulla **pipeline completa** con lo stack già attivo, mai sul modello isolato (Recent Form sembrava −0.50% da sola, era −0.02% nella pipeline);
   - separare il **fatto misurato** dall'**ipotesi sulla causa**: non presentare la seconda come conclusione senza una prova dedicata;
   - non implementare un parametro "teoricamente più corretto" se il backtest completo dice il contrario.
5. **Prossimo margine reale**: mercato **marcatore anytime** — nuova funzionalità (dati pronti: 2.934 giocatori con xG), non un miglioramento del modello esistente. Da valutare separatamente.
