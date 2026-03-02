# ⚽ FootPredictor - Sistema di Analisi Statistica Calcio

Sistema completo per l'analisi predittiva di partite di calcio con stima probabilistica
delle scommesse sportive basata sul **modello Dixon-Coles** esteso.

---

## 🧮 Modello Matematico

### Modello di Base: Dixon-Coles (1997)

Il modello assume che i goal seguano una **distribuzione di Poisson bivariata**:

```
λ_home = exp(α_home + β_away + γ)   # Expected goals casa
λ_away = exp(α_away + β_home)        # Expected goals ospite

P(X=x, Y=y) = P(x|λ_h) × P(y|λ_a) × τ(x,y,λ_h,λ_a,ρ)
```

Dove:
- **α** = forza offensiva di ogni squadra
- **β** = solidità difensiva di ogni squadra
- **γ** = fattore vantaggio campo (stimato ~0.25 in log-scala)
- **ρ** = parametro di correzione Dixon-Coles (stimato ~-0.13)

### Correzione Dixon-Coles (τ)

Corregge la sovra/sottostima dei risultati a basso punteggio:

```
τ(0,0) = 1 - λ_h × λ_a × ρ
τ(1,0) = 1 + λ_a × ρ
τ(0,1) = 1 + λ_h × ρ
τ(1,1) = 1 - ρ
τ(x,y) = 1  per x+y > 2
```

### Decadimento Temporale

I dati storici vengono pesati con:
```
w = exp(-τ × età_in_settimane)
τ = 0.0065  →  half-life ≈ 36 settimane
```

### Integrazione xG

Quando disponibili, gli Expected Goals vengono blendati con il modello DC:
```
λ_home_finale = 0.6 × λ_home_DC + 0.4 × xG_casa_storico
```

### Stima dei Parametri (MLE)

I parametri sono stimati massimizzando la **log-verosimiglianza**:
```
LL = Σ_i w_i × log[P(x_i, y_i | α, β, γ, ρ)]
```

via gradient ascent con normalizzazione dei parametri.

---

## 📊 Modelli Statistici Specializzati

### Distribuzione Binomiale Negativa

Tiri, cartellini e falli usano una **Negative Binomial** parametrizzata come:

```
E[X] = μ       Var[X] = μ + μ²/r
```

Dove `r` è il **parametro di dispersione**, stimato dinamicamente per ogni squadra
dal metodo dei momenti: `r = μ² / (Var - μ)`.

#### Log-Gamma: approssimazione di Lanczos (9 coefficienti)

La PMF della NegBin richiede `logΓ(k+r)`. Si usa l'approssimazione di **Lanczos**
invece di Stirling, con precisione ~15 cifre significative anche per k piccoli (0..4),
rilevanti nei mercati cartellini.

#### Lower bound adattivo di r (dipendente dalla numerosità)

Il parametro r non può scendere sotto un valore arbitrariamente piccolo. Il lower bound
è **data-adaptive**:

```
r_min = 1 + 1 / sqrt(n)
```

Dove `n` è il numero di partite osservate per quella squadra/arbitro. Con n=5 → r_min ≈ 1.45
(prudente), con n=100 → r_min ≈ 1.10 (lascia parlare i dati). Un lower bound fisso (es. 1.5)
ignorerebbe un r realmente basso su campioni grandi, perdendo potenziale edge.

---

### Modello Tiri (NegBin)

- **r dinamico per squadra**: stimato dalla varianza storica dei tiri, invece di un valore
  fisso (r=9 per tutti). Prior empirica: `Var ≈ μ × 1.6` se la varianza non è disponibile.
- **Tiro in porta separato**: il tasso conversione tiro→SOT è aggiustato indipendentemente
  dalla soppressione difensiva avversaria (una difesa chiusa riduce i SOT più dei tiri totali).
- **Struttura output**: `home/away.totalShots.distribution`, `home/away.shotsOnTarget.distribution`,
  `combined.overUnder` (chiavi flat: `over235`, `over255`, …), `combined.onTargetOverUnder`.
  I campi legacy (`expectedTotalShots`, `expectedShotsOnTarget`, `overUnder`) sono mantenuti
  per compatibilità con `DixonColesModel.ts`.

---

### Modello Cartellini (NegBin)

- **r dinamico** per gialli home/away stimato dalla varianza storica.
- **Fattore arbitro con smorzamento bayesiano**:
  ```
  refFactor = 1 + (raw_factor - 1) × n / (n + 15)
  ```
  Un arbitro con 5 partite ha peso smorzato del 75% verso la media lega. I rossi usano
  un prior più forte (n+25) perché l'evento è più raro e l'stima meno affidabile.
- **Competitiveness sigmoidale**: sostituisce i moltiplicatori lineari fissi (+22% derby,
  +12% high stakes) che si sommavano in modo non validato. Boost massimo cap al +22%
  su curva sigmoidale continua, evitando extrapolazioni agli estremi.
- **Correlazione falli→cartellini**: un arbitro con tanti falli tende a dare più cartellini
  (correlazione empirica ≈ 0.35).

---

### Modello Falli (NegBin)

- **Correzione possesso non-lineare** (esponenziale invece di lineare):
  ```
  homePossCorr = exp(-0.22 × (poss - 0.5) / 0.5)
  ```
  A poss=60%: riduzione ~10.5% falli; a 70%: ~18%. La formula lineare precedente
  sovrastimava l'effetto agli estremi.
- **Correlazione intra-partita ρ = 0.25** tra falli casa e falli ospite.
  Questa è una **best conservative estimate**, non una verità statistica. La correlazione
  reale dipende da tipo di partita, arbitro, stato del match e non è costante. La letteratura
  empirica su dati Serie A indica ρ ∈ [0.15, 0.40]. Aggiornare con regressione sul proprio
  dataset tramite backtesting.

---

### Modello Giocatori — Tiri (ZIP / Dirichlet-Multinomial)

- **Regression-to-mean per ruolo**: giocatori con pochi dati vengono spinti verso
  la shot share media del proprio ruolo (FW ≈ 20%, MF ≈ 12%, DF ≈ 5%).
  Formula: `share_adj = (n × share_obs + priorN × share_prior) / (n + priorN)`
- **Normalizzazione robusta** delle share: evita divisione per zero se la somma è nulla.

---

## 📈 Value Betting e Kelly Criterion

### Implied Probability senza Vig

La probabilità implicita raw `1/quota` include il margine del bookmaker (~5-8%).
Il sistema calcola anche la **probabilità senza vig** con il metodo proporzionale (Pinnacle standard):

```
overround = Σ (1 / odds_i)      (es. 1.053 = vig 5.3%)
P_no_vig  = (1 / odds) / overround
```

L'edge viene calcolato contro `P_no_vig` per evitare di sovrastimare sistematicamente
il vantaggio su ogni scommessa.

### Expected Value
```
EV = P_nostra × quota - 1
```
Una scommessa è conveniente se EV > 2% (configurabile).

### Kelly Criterion (Frazionale 1/4)

```
f* = (b×p - q) / b
puntata_suggerita = f* × confidenceMultiplier × bankroll
```

Dove b = quota-1, p = nostra probabilità, q = 1-p. La confidence **modula** Kelly
senza sovrascriverlo con floor fissi:

| Confidence | Multiplier |
|---|---|
| HIGH   | × 1.20 |
| MEDIUM | × 1.00 |
| LOW    | × 0.75 |

Il risultato è clampato tra MIN_STAKE (0.3%) e MAX_STAKE (5%) del bankroll.

### Classificazione Confidenza

| Confidence | EV | P Nostra |
|---|---|---|
| HIGH   | ≥ 8% | ≥ 55% |
| MEDIUM | ≥ 5% | ≥ 45% |
| LOW    | ≥ 2% | qualsiasi |

### Calibrazione Isotonica (PAVA)

Il modello Dixon-Coles produce probabilità sistematicamente overconfident. Il sistema
implementa la calibrazione isotonica (Pool Adjacent Violators Algorithm) per correggere
la mappa P_raw → P_calibrata.

**Blending anti-overfitting**: la calibrazione può peggiorare con campioni piccoli o
non stazionari. Si usa un blending proporzionale a n:

```
P_final = α × P_raw + (1 - α) × P_cal
α = 1 / (1 + n / 1000)
```

Soglie operative: n < 200 → α ≈ 0.90 (quasi ignorare la calibrazione); n = 1000 → α ≈ 0.50;
n ≥ 3000 → α ≈ 0.10. Non calibrare mai su meno di qualche migliaio di predizioni.

### ROI su scommesse liquidate

```
ROI = (totalReturn - settledStaked) / settledStaked × 100
```

Il calcolo esclude le scommesse pendenti (`PENDING`) dal denominatore, evitando la
sottostima del ROI durante la stagione.

---

## 🚀 Installazione e Avvio

### Opzione 1: Docker (consigliato)

```bash
git clone <repo>
cd football-predictor
docker-compose up --build
```

Apri http://localhost:3000

### Opzione 2: Sviluppo Locale

Prerequisiti:
- `Node.js >= 20` (consigliato tramite `.nvmrc`)
- Configura Turso/libSQL tramite variabili ambiente (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`)

**Backend:**
```bash
cd backend
npm install
npm run dev
# Backend su http://localhost:3001
```

**Frontend:**
```bash
cd frontend
npm install
npm start
# Frontend su http://localhost:3000
```

---

## 📁 Struttura Progetto

```
football-predictor/
├── backend/
│   ├── src/
│   │   ├── models/
│   │   │   ├── DixonColesModel.ts      # Core algoritmo statistico
│   │   │   ├── SpecializedModels.ts    # NegBin per tiri/cartellini/falli
│   │   │   ├── CardsModel.ts           # Modello cartellini standalone
│   │   │   ├── ValueBettingEngine.ts   # EV + Kelly + vig removal + calibrazione
│   │   │   └── BacktestingEngine.ts    # Validazione su dati storici
│   │   ├── services/
│   │   │   └── PredictionService.ts    # Orchestrazione
│   │   ├── api/
│   │   │   └── routes.ts               # Express API
│   │   ├── db/
│   │   │   └── DatabaseService.ts      # Turso/libSQL persistenza
│   │   └── index.ts                    # Entry point
│
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.tsx           # Panoramica
│       │   ├── Predictions.tsx         # Analisi partite
│       │   ├── BudgetManager.tsx       # Bankroll & scommesse
│       │   ├── Backtesting.tsx         # Test su dati storici
│       │   └── DataManager.tsx         # Import dati
│       └── utils/api.ts                # Client API
│
└── docker-compose.yml
```

---

## 📥 Importazione Dati

### Fonti Consigliate

| Fonte | URL | Dati |
|---|---|---|
| football-data.org | https://football-data.org | Risultati, API gratuita |
| fbref.com | https://fbref.com | xG, tiri, falli, arbitri |
| understat.com | https://understat.com | xG per tiro |

### Formato JSON Import

```json
[
  {
    "matchId": "sa_2024_001",
    "homeTeamId": "inter",
    "awayTeamId": "milan",
    "homeTeamName": "Inter",
    "awayTeamName": "Milan",
    "date": "2024-09-22T15:00:00Z",
    "homeGoals": 2,
    "awayGoals": 1,
    "homeXG": 2.3,
    "awayXG": 1.1,
    "homePossession": 55,
    "awayPossession": 45,
    "homeTotalShots": 14,
    "awayTotalShots": 9,
    "homeShotsOnTarget": 6,
    "awayShotsOnTarget": 3,
    "homeFouls": 10,
    "awayFouls": 13,
    "homeYellowCards": 1,
    "awayYellowCards": 2,
    "homeRedCards": 0,
    "awayRedCards": 0,
    "homeTeamVarShots": 8.4,
    "awayTeamVarShots": 6.1,
    "homeTeamVarYellow": 0.9,
    "awayTeamVarYellow": 0.7,
    "refereeSampleSize": 42,
    "referee": "Daniele Orsato",
    "competition": "Serie A",
    "season": "2024-25"
  }
]
```

I campi `*Var*` e `*SampleSize` sono **opzionali ma raccomandati**: alimentano la stima
del parametro di dispersione r e il lower bound adattivo. In assenza, il sistema usa
prior empiriche Serie A.

---

## 🔬 Metriche di Validazione

| Metrica | Descrizione | Target |
|---|---|---|
| **ROI** | Return on Investment su scommesse liquidate | > 0% |
| **Brier Score** | Accuratezza probabilistica | < 0.25 |
| **Sharpe Ratio** | Rendimento risk-adjusted | > 1.0 |
| **Max Drawdown** | Perdita massima dal picco | < 20% |
| **Calibrazione** | Prob. previste vs. reali (isotonica) | Diagonale |
| **Log Loss** | Cross-entropy delle previsioni | < 0.65 |

---

## ⚠️ Note Importanti

1. **Il modello richiede almeno 20-30 partite per squadra** per stime affidabili. Con meno dati
   il lower bound adattivo `r_min = 1 + 1/sqrt(n)` penalizza automaticamente la dispersione.
2. **Il backtesting usa 70% dati training, 30% test** (divisione cronologica).
3. **Le scommesse con EV > 2% sono considerate value bets** — non garantisce profitto.
4. **Usa sempre Kelly Frazionale** (×0.25) con cap al 5% del bankroll.
5. **Non calibrare le probabilità su meno di ~1000 predizioni**: sotto quella soglia il blending
   `α = 1/(1 + n/1000)` riduce automaticamente il peso della calibrazione isotonica.
6. **La correlazione intra-partita falli ρ = 0.25 è una stima baseline**: ricalibrarla
   con regressione sul proprio dataset tramite backtesting.
7. **I dati applicativi sono salvati su Turso/libSQL** (nessun database SQLite locale in runtime).

---

## Best Quote Value Algorithm (Dettaglio Operativo)

### Mercati analizzati

L'endpoint `/api/scraper/odds/match` richiede mercati `h2h`, `totals`, `spreads`.
Se non disponibili: fallback `h2h`, `totals`. Se il provider non risponde: quote stimate
dal modello (`model_estimated`).

### Pipeline di scelta "miglior quota valore"

1. Il modello stima le probabilità reali per ogni selezione (`p_model`).
2. La quota bookmaker produce probabilità implicita **senza vig**:
   `p_no_vig = (1/quota) / overround` (metodo proporzionale).
3. Calcolo valore:
   - `EV = p_model × quota - 1`
   - `edge = p_model - p_no_vig`
4. Filtro opportunità: EV > 2%, odds ∈ [1.30, 15.00], edge > 0 contro `p_no_vig`.
5. Ranking finale con score composito:
   - `baseModelScore = EV×0.58 + edge×0.24 + kellyFraction×0.12 + confidenceBoost`
   - `totalScore = baseModelScore + contextualScore`
6. La selezione con `totalScore` massimo diventa `bestValueOpportunity`.

### Confidence boost usato nello score

| Confidence | Boost |
|---|---|
| HIGH   | +3.5 |
| MEDIUM | +1.8 |
| LOW    | +0.7 |

### Fattori contestuali

Il `contextualScore` usa un vettore fattori:
- `homeAdvantageIndex`
- `formDelta`
- `motivationDelta`
- `suspensionsDelta` (squalifiche + assenze chiave)
- `disciplinaryDelta` (espulsioni recenti)
- `atRiskPlayersDelta` (diffidati)
- `competitiveness` (derby/alta posta — ora modellato con curva sigmoidale)

Componente direzionale principale:
```
direction × (homeAdvantage×8 + form×6 + motivation×5 + suspensions×4 + disciplinary×3 + diffidati×2)
```

Adattamento per tipo mercato:
- Mercati cartellini/falli: bonus legato a `competitiveness` e `disciplinaryDelta`.
- Mercati over: boost su forma/motivazione.
- Mercati under: penalizzazione se forma spinge verso ritmo alto.

### Input opzionali a `/api/predict`

```json
{
  "homeTeamId": "inter",
  "awayTeamId": "milan",
  "competition": "Serie A",
  "bookmakerOdds": { "homeWin": 1.85, "draw": 3.40, "awayWin": 4.20 },
  "homeFormIndex": 0.72,
  "awayFormIndex": 0.55,
  "homeObjectiveIndex": 0.9,
  "awayObjectiveIndex": 0.6,
  "homeSuspensions": 1,
  "awaySuspensions": 0,
  "homeRecentRedCards": 0,
  "awayRecentRedCards": 1,
  "homeDiffidati": 2,
  "awayDiffidati": 0,
  "homeKeyAbsences": 0,
  "awayKeyAbsences": 1,
  "homeTeamVarShots": 8.4,
  "awayTeamVarShots": 6.1,
  "homeTeamSampleSize": 28,
  "awayTeamSampleSize": 28
}
```

Se non forniti, il sistema usa inferenza da parametri squadra e valori neutri.

### Output aggiuntivo in risposta prediction

- `bestValueOpportunity`: selezione, quota, EV, edge, `edgeNoVig`, confidence,
  `factorBreakdown` (`baseModelScore`, `contextualScore`, `totalScore`), `reasons[]`.
- `analysisFactors`: valori numerici dei fattori contestuali e note diagnostiche.
- `shotsPrediction.combined.overUnder`: Over/Under tiri totali (linee 15.5–31.5).
- `shotsPrediction.combined.onTargetOverUnder`: Over/Under tiri in porta (linee 5.5–11.5).

### Configurazione Turso

```bash
cd backend
cp .env.example .env
# imposta TURSO_DATABASE_URL e TURSO_AUTH_TOKEN
npm install
npm run dev
```

---

## 🤝 Avvertenza

Questo software è destinato esclusivamente a scopi **educativi e informativi**.
Le scommesse comportano rischi finanziari significativi. Gioca sempre responsabilmente.