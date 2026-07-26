# D5 (coerenza tiri-in-porta) e D3 (baseline rossi) — esiti — Luglio 2026

Data: 2026-07-26

## D5 — coerenza rate tiri-in-porta — NO-GO

**Ipotesi:** in `computeShotsDistribution` il rate OT usa `rawSOT / blendedShots`
(volume tiri blended con λ), mentre l'accuratezza vera è `rawSOT / rawShots`.

**Analisi:** algebricamente il volume blended **si cancella** nel valore atteso
(`muHomeOT = muHome × rawSOT/blendedShots` → il blend sparisce), quindi i SOT
attesi restano legati all'accuratezza grezza. L'incoerenza morde solo tramite il
cap `min(0.65)` (che non scatta quasi mai) e la divergenza λ-tiri.

**Test di calibrazione as-of (6.299 match, tutte le stagioni, SOT totali):**

| Variante | logLoss | Brier | ECE |
|---|---|---|---|
| Attuale (blend si cancella) | 0.67894 | 0.24004 | 0.08470 |
| Fix (OT scala col blend) | 0.68721 | 0.24230 | 0.09113 |

Il fix **peggiora** (−1.22% logLoss, ECE peggiore); cap attivo 0/6299. La
formulazione attuale è migliore: legare i SOT all'accuratezza grezza calibra
meglio del blend λ-based (che aggiunge rumore ai SOT). **NO-GO, nessuna modifica.**

Nota: l'ECE SOT resta alto (~0.085) in entrambe → margine di calibrazione sui
tiri esiste, ma D5 non è la leva giusta.

## D3 — baseline rossi — non implementato (impatto non misurabile)

Il fattore-arbitro-rossi usa il proxy `leagueAvgYellow × 0.05` come stima di
`leagueAvgRed`. Verificato che il proxy è sbagliato per-lega (rossi non scalano
coi gialli):

| Lega | rossi/match reali | proxy (gialli×0.05) |
|---|---|---|
| Premier | 0.118 | 0.194 (+64%) |
| Ligue 1 | 0.239 | 0.181 (−24%) |
| La Liga | 0.261 | 0.229 (−12%) |
| Serie A | 0.181 | 0.201 (+11%) |
| Bundesliga | 0.167 | 0.195 (+17%) |

**Ma** il fattore-rossi arbitro è attivo solo con dato arbitro (~100% Premier,
~1-2% altrove) e sui rossi rari: l'effetto sui card points è < 0.1 punti, non
misurabile in backtest. Farlo per-lega (come B6) richiederebbe plumbing
`supp.leagueAvgRed` → modello (oggi non popolato) per un guadagno nullo
misurabile. **Rinviato**: correttezza reale ma sotto il rumore.

## Conclusione
D2, D5 NO-GO; D3 non misurabile. Il modello squadra (goal/tiri/cartellini) è
spremuto. Il valore residuo è nell'infrastruttura (ingest quote di chiusura per
ROI/CLV; `player_match_stats` per marcatore anytime), non nel micro-tuning.
