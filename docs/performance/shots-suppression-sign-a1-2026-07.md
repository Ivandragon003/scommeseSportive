# A1 — Segno invertito della difesa avversaria sui tiri di casa — Luglio 2026

Data: 2026-07-26

## Bug
In `computeShotsDistribution` ([SpecializedModels.ts](../../backend/src/models/markets/SpecializedModels.ts)):

```
muHome = homeShots × homeAdv / awayTeamShotsSuppression   // DIVIDE (sbagliato)
muAway = awayShots × homeTeamShotsSuppression             // MOLTIPLICA (corretto)
```

`shotsSuppression = tiri concessi / media lega` → **>1 = difesa DEBOLE**. I tiri
di casa devono CRESCERE contro una difesa ospite debole, ma la divisione li
faceva CALARE (segno invertito). `muAway` moltiplicava correttamente: asimmetria
= bug. Il difetto si propagava anche ai tiri-in-porta di casa
(muHomeOT ∝ 1/awaySupp^1.5, anch'esso invertito).

## Fix
`muHome = homeShots × homeAdv × awayTeamShotsSuppression` (moltiplicazione,
simmetrica a `muAway`). Corregge anche la direzione dei tiri-in-porta di casa
(ora ∝ awaySupp^0.5).

## Validazione (calibrazione as-of, tutte le stagioni, 6.299 match)

| Mercato | logLoss attuale | logLoss fix | Δ |
|---|---|---|---|
| Tiri totali | 0.73060 | 0.65050 | **−10.96%** |
| Tiri casa | 0.72482 | 0.67161 | **−7.34%** |

ECE tiri totali 0.14 → 0.10. È il singolo bug più impattante del batch di audit
(A1–A7): la difesa avversaria era invertita su un mercato attivo e servito.

## Note
- `muAway` era gia' corretto: nessuna modifica.
- Non interagisce con D5 (che riguardava il denominatore del rate OT, NO-GO): A1
  corregge il segno di `muHome`, indipendente.
- 236/236 test pass (+2 regressione A1).
