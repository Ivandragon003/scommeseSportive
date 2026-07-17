# Parametro per-campionato leagueAvgYellow (gialli) — analisi go/no-go (Luglio 2026)

Data: 2026-07-17
Esito: **NO-GO — non implementato.** Il parametro per-lega, benché teoricamente più accurato, peggiora le predizioni sul mercato cartellini (raw +0.38%, p=0.016 nella direzione opposta) perché rimuove una compensazione fortuita del `3.8` globale.

## Contesto

`supp.leagueAvgYellow` non viene mai popolato → in produzione vale **3.8 per tutte e 5 le leghe** (`PredictionService.ts:1613`). Le medie reali variano: Serie A 3.62 … La Liga 4.25. `leagueAvgYellow` entra in `computeCardsDistribution` come **bersaglio dello shrinkage** dei gialli squadra (`avgYellowPerTeam = leagueAvgYellow/2`, priorStrength 15 → ~27-43% di peso per team con 20-40 partite). Le medie *squadra* sono invece già dati reali per-team (`avg_yellow_cards`).

## Metodo

Walk-forward OOS, 5 campionati, solo match con gialli (~2.181 valutati), **bugfix compFactor già incluso**. Confronto:
- `global38` — leagueAvgYellow=3.8 (produzione attuale)
- `perLeague` — leagueAvgYellow = media rolling reale della lega

In entrambi l'arbitro è neutro (refereeAvgYellow=leagueAvgYellow), come in produzione (referee assente ~98%), così l'unico effetto è il bersaglio dello shrinkage. Selezioni Over gialli su linee 2.5–6.5, con calibrazione per-famiglia rolling.

## Risultati

Medie rolling usate: Serie A 3.55 · Premier 3.68 · La Liga 4.13 · Bundesliga 3.54 · Ligue 1 3.54.

| Stadio | global38 | perLeague | Δ logLoss |
|---|---|---|---|
| raw | LL=0.51858, ECE=0.0304 | LL=0.52053, ECE=0.0307 | **+0.38%** |
| calibrato | LL=0.51563, ECE=0.0268 | LL=0.51585, ECE=0.0279 | +0.04% |

**Test appaiato per-partita:** n=2.181, t=+2.42, **p=0.016 — significativo nella direzione opposta** (perLeague peggiore).

**Per campionato (raw Δ logLoss):** Serie A +0.23% · Premier +0.35% · La Liga +0.44% · Bundesliga +0.23% · Ligue 1 +0.68%. **Peggiora in tutte e 5.**

**Per linea:** 2.5 +0.72% · 3.5 +0.67% · 4.5 +0.36% · 5.5 −0.01% · 6.5 −0.40%. Peggiora sulle linee basse/centrali, neutro sulle alte.

## Diagnosi

Il `3.8` globale è più alto delle medie reali di 4 leghe su 5. Dopo il bugfix il modello sottostima lievemente i gialli (−1.4%); il `3.8`, come bersaglio di shrinkage un po' alto, tira su le previsioni dei team con pochi dati e **compensa** quella sottostima residua. Sostituirlo con la media reale (più bassa) abbassa le previsioni e peggiora la sottostima. Anche La Liga (media 4.13 > 3.8) peggiora: lì il modello era già in lieve sovrastima e alzare il bersaglio la aggrava.

**Lezione:** un parametro teoricamente più corretto non è automaticamente migliore — conta come interagisce con i bias residui dell'intera pipeline. Solo la validazione full-pipeline lo rivela.

## Decisione

**Non implementato.** Il valore globale 3.8 resta la scelta migliore per i cartellini. Falli e corner restano fuori discussione per mancanza di copertura dati (vedi `data-coverage-gaps` / memoria).
