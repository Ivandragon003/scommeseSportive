# Recent Form adattiva (half-life ottimizzata) — analisi go/no-go (Luglio 2026)

Data: 2026-07-17
Esito: **NO-GO — non implementata.** Il guadagno è reale sul Dixon-Coles isolato (−0.50% logLoss) ma **svanisce quasi del tutto con l'ensemble attivo** (−0.02%, p=0.65): le due feature curano lo stesso difetto.

## Ipotesi

`dixonColes.temporalWeights.currentSeasonDecay` = 0.002/settimana → half-life ≈ **346 settimane**: dentro la stagione le partite pesano quasi uguale, quindi il modello **non ha praticamente pesatura di forma recente**. Ipotesi: accorciare la half-life (dare più peso alle gare recenti) migliora le stime attacco/difesa.

## Fase 1 — sweep half-life sul Dixon-Coles isolato (exp8)

Walk-forward OOS, 5 campionati, ~3.500 partite, override via `fitModel(opts.currentSeasonDecay)`.

| decay/wk | half-life | logLoss cal | ECE cal | Δ vs attuale |
|---|---|---|---|---|
| **0.002 (attuale)** | 346 wk | 0.60308 | 0.0057 | — |
| 0.01 | 69 wk | 0.60139 | 0.0045 | −0.28% |
| **0.02 (ottimo)** | **35 wk** | **0.60006** | 0.0041 | **−0.50%** |
| 0.04 | 17 wk | 0.60127 | 0.0020 | −0.30% |
| 0.08 | 9 wk | 0.60671 | 0.0034 | +0.60% (overfit) |

Curva a U rovesciata pulita, ottimo a **half-life ~35 settimane** (≈ una stagione di memoria effettiva). Su questa base la feature sembrava un GO netto.

## Fase 2 — validazione sulla pipeline COMPLETA con ensemble attivo (exp10)

Disegno: entrambe le varianti con **ensemble ON** (classi di produzione). Il Poisson-xG non usa pesatura temporale → **identico** nelle due varianti, quindi il delta misurato è esattamente l'effetto della recency del DC *sopra* l'ensemble.

| Stadio | base (decay 0.002) | rf (decay 0.02) | Δ logLoss |
|---|---|---|---|
| raw | LL=0.59862, ECE=0.0053 | LL=0.59854, ECE=0.0079 | −0.01% |
| **calibrato** | LL=0.59924, ECE=**0.0019** | LL=0.59912, ECE=**0.0037** | **−0.02%** |

**Test appaiato bloccato per partita:** n=5.282, media Δ(rf−base)/match = −0.000128, **t = −0.453, p = 0.65** → **non significativo**.

**Breakdown per mercato (calibrato) — nessuna direzione coerente:**

| Mercato | n | Δ logLoss | ECE base→rf |
|---|---|---|---|
| 1X2 | 15.846 | −0.02% | 0.0109→0.0108 |
| Double Chance | 15.846 | −0.00% | 0.0108→0.0115 |
| DNB | 7.848 | +0.01% | 0.0215→0.0211 |
| Over/Under | 31.692 | −0.07% | 0.0077→0.0051 |
| BTTS | 10.564 | +0.07% | 0.0183→0.0162 |

**Simulazione scommesse:**

| | #bet | ROI Kelly | yield flat | winrate | CLV |
|---|---|---|---|---|---|
| base | 67 | −45.06% | −47.12% | 14.9% | +6.30% |
| rf | 64 | −44.94% | −56.05% | 14.1% | +6.84% |

## Perché il guadagno sparisce (diagnosi)

Il beneficio dell'ensemble consisteva nel **correggere le probabilità troppo ottimistiche del Dixon-Coles** (ECE 0.0057→0.0018, vedi `ensemble-poisson-xg-2026-07.md`). La half-life ottimizzata correggeva **lo stesso difetto** per un'altra strada (ECE 0.0057→0.0041 in fase 1). Una volta che l'ensemble ha già sanato la miscalibrazione, alla recency **non resta segnale da aggiungere**: non sono due informazioni diverse, sono due cure per la stessa malattia.

Indizio a conferma: con l'ensemble attivo la **ECE calibrata peggiora** (0.0019→0.0037), cioè la recency *disturba* leggermente un ensemble già ben calibrato.

## Decisione

**Non implementata.** Criteri di accettazione non soddisfatti: guadagno ridotto del 96% (−0.50% → −0.02%) e non statisticamente significativo (p=0.65) sulla pipeline reale, con ECE in peggioramento. Aggiungere complessità (e un parametro in più da mantenere/tarare) per zero beneficio misurabile non è giustificato.

**Lezione metodologica:** validare solo sul modello isolato avrebbe portato a implementare una modifica inutile in produzione. Le feature vanno sempre misurate **sopra lo stack già attivo**.

## Nota correlata — Dynamic xG Blend: NO-GO definitivo

Bocciato in **due formulazioni indipendenti**:
1. auto-selezione del peso globale per-fold (−0.07% vs peso fisso ritarato) — vedi `feature-ablation-2026-07.md` e analisi λ;
2. peso xG **per-squadra** adattivo alla ricchezza dati (−0.01/−0.02% = rumore).

Il peso statico `xgWeight=0.80` è già near-ottimale (plateau 0.75–0.85). Questione chiusa: non riaprire senza un'ipotesi sostanzialmente diversa.
