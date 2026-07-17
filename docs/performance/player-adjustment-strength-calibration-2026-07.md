# Player Adjustment avanzato & Calibrazione per forza — analisi go/no-go (Luglio 2026)

Data: 2026-07-17
Esito: **NO-GO entrambe — non implementate.** Validate sulla pipeline completa con ensemble attivo; nessuna delle due produce un miglioramento statisticamente significativo.

Baseline per entrambi i test: sistema di produzione attuale (correzione λ per-lega + xgWeight 0.80 + **ensemble DC+Poisson-xG attivo**), walk-forward OOS, 5 campionati, ~5.300 partite di test.

---

## 1. Player Adjustment avanzato — NO-GO

### Il dato ERA disponibile (correzione a un'affermazione precedente)

`feature-ablation-2026-07.md` dichiarava n.4 "non misurabile in backtest: il DB non registra le assenze storiche". **Non è vero**: `matches.raw_json` contiene le rose per-partita (`details.rosters.h/a`) nel **100%** dei match, con `player_id`, `time` (minuti), `xG`, `position`. Le assenze storiche sono ricostruibili.

### Metodo (anti-lookahead)

I "titolari abituali" di una squadra e il loro peso xG sono calcolati **solo dalle partite precedenti** (finestra mobile di 10, titolare = ≥60 min in ≥60% delle gare). Del match corrente si usa **solo chi è sceso in campo** — informazione legittimamente disponibile in produzione (~1h prima del kickoff). Assente = titolare abituale che non compare nella rosa del match.

Varianti confrontate:
- `none` — nessun aggiustamento (baseline)
- `current` — algoritmo esistente (`LineupXgAdjustmentService`): `multiplier = 1 − shareXgAssente × (1 − 0.60)`, cap −18%, applicato alla λ della propria squadra
- `advanced` — attacco e difesa separati e position-aware: assenti offensivi riducono la λ propria, assenti difensivi **alzano la λ dell'avversario**

### Copertura del segnale

| | valore |
|---|---|
| Match valutati | 5.582 |
| Match con ≥1 titolare assente | **3.040 (54%)** |
| Assenti medi per match | 1,69 |
| Range moltiplicatori | **0.820 – 1.108** |

Il segnale è **reale e di magnitudine non trascurabile**: non è un caso di "feature inerte per mancanza di dati".

### Risultati (calibrato)

| Variante | logLoss | Brier | ECE | Δ logLoss | test appaiato per-partita |
|---|---|---|---|---|---|
| **none** | 0.59924 | 0.20616 | 0.0019 | — | — |
| current | 0.59933 | 0.20620 | **0.0008** | **+0.01%** (peggio) | t=0.13, **p=0.90** |
| advanced | 0.59912 | 0.20610 | 0.0014 | −0.02% | t=−0.57, **p=0.57** |

**Breakdown per mercato (Δ logLoss vs none):**

| Mercato | n | current | advanced |
|---|---|---|---|
| 1X2 | 15.846 | +0.03% | −0.03% |
| Double Chance | 15.846 | +0.05% | −0.01% |
| DNB | 7.848 | −0.01% | −0.20% |
| Over/Under | 31.692 | +0.02% | +0.03% |
| BTTS | 10.564 | −0.05% | −0.05% |

**Scommesse:** none 67 bet (ROI −45.1%, CLV +6.30%); current 66 (−46.0%, +7.27%); advanced 62 (−42.6%, **+7.75%**). ROI su campione minuscolo = rumore; il CLV migliora leggermente con `advanced`.

### Diagnosi

Il Dixon-Coles **cattura già l'assenza indirettamente**: se un titolare manca per più giornate, i risultati recenti della squadra lo riflettono nei parametri attacco/difesa. Su una singola partita l'effetto di un assente è piccolo rispetto alla varianza del calcio — la squadra si adatta e il sostituto assorbe le occasioni. Il `replacementRatio = 0.60` (il sostituto rende il 60%) è probabilmente **troppo pessimista**: a livello di xG di squadra il rimpiazzo è quasi neutro.

Nota: la ECE *migliora* (0.0019 → 0.0008 con `current`) ma logLoss e significatività no: l'aggiustamento rende le probabilità marginalmente meglio calibrate senza renderle più accurate.

---

## 2. Calibrazione per tipo di squadra (forti/deboli) — NO-GO

### Ipotesi

La calibrazione oggi è per **famiglia di mercato**. Ipotesi: il *favourite-longshot bias* miscalibra le probabilità estreme (match sbilanciati) diversamente da quelle equilibrate → curve separate per (famiglia × fascia di forza).

Fascia calcolata dalla forza del favorito nelle probabilità del modello (nessun lookahead). Fallback: (famiglia × fascia) → famiglia → globale, per evitare la frammentazione. Distribuzione: 3.738 match `balanced`, 1.844 `mismatch`.

### Risultati (calibrato)

| Variante | logLoss | Brier | ECE | Δ logLoss | test appaiato |
|---|---|---|---|---|---|
| **family (attuale)** | 0.59924 | 0.20616 | **0.0019** | — | — |
| fam × forza (2 fasce) | 0.59915 | 0.20612 | 0.0022 | −0.02% | t=−0.71, **p=0.48** |
| fam × forza (3 fasce) | 0.59907 | 0.20608 | 0.0037 | −0.03% | t=−0.94, **p=0.35** |

**Breakdown per mercato (Δ logLoss vs family):**

| Mercato | 2 fasce | 3 fasce |
|---|---|---|
| 1X2 | −0.03% | −0.07% |
| Double Chance | −0.01% | −0.06% |
| **DNB** | **+0.11%** | **+0.14%** |
| Over/Under | −0.04% | −0.02% |
| BTTS | −0.02% | −0.07% |

### Diagnosi

Guadagno −0.02/−0.03%, non significativo (p=0.35–0.48), e soprattutto **la ECE peggiora** (0.0019 → 0.0022 → 0.0037) — proprio la metrica che la calibrazione dovrebbe migliorare. Stratificare frammenta i campioni: ogni curva ne ha meno ed è più rumorosa. Il DNB peggiora sistematicamente.

L'ensemble ha già portato la ECE a 0.0019 (quasi perfetta): **non resta miscalibrazione da stratificare**. Il favourite-longshot bias che l'ipotesi voleva catturare è già assorbito.

---

## Conclusione trasversale: i mercati goal sono saturi

Sono **tre NO-GO consecutivi** sui mercati goal dopo l'ensemble — Recent Form (`recent-form-half-life-2026-07.md`), Calibrazione per forza, Player Adjustment — tutti con la **stessa diagnosi**: l'ensemble ha portato la ECE a 0.0019 e il logLoss vicino al limite del segnale estraibile dai dati disponibili. Ogni feature aggiuntiva trova poco o nulla da correggere.

**Implicazione strategica:** il margine residuo non è nei mercati goal, ma dove nessuno ha ancora guardato:

1. **Bug nei mercati cartellini** (mai affrontati): il boost `competitiveness` è fuori scala (`SpecializedModels.ts`, `compBoost = 0.22 * (2*sigmoid(...) - 0)` — quel `- 0` è un refuso: ogni partita riceve +10–43% gialli); l'effetto arbitro è contato **tre volte** (refYellowFactor + foulsBonus + correzione post-hoc in DixonColesModel).
2. **Costanti Serie A applicate a 5 campionati** (gialli 3.8, falli 22.4, ratio tiri/goal 11.0): la Premier ha ~3.2 gialli, la Liga ~4.8. Default per-lega calcolabili dal DB.
3. **Corner concessi inesistenti**: si usano i corner *fatti* dall'avversario come proxy di quelli *concessi*; i dati veri sono già in `matches`.
4. **Mercato marcatore anytime**: assente, dati già pronti (xG per giocatore), è il mercato player più giocato.

Questi hanno headroom molto maggiore di qualsiasi ulteriore raffinamento sui goal.
