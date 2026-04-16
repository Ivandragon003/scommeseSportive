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

## Setup locale e avvio

- usa sempre `./.env` nella root del repository
- crea il file con `copy .env.example .env`
- il backend legge dal root `.env` database, odds, scheduler e Playwright
- il frontend locale non usa segreti; `FRONTEND_PORT` serve al mapping Docker

```powershell
npm install
npm --prefix backend install
npm --prefix frontend install
npm run dev
```

Servizi: frontend `http://localhost:3000`, backend `http://localhost:3001/api/health`.

Docker: `docker compose up -d --build`

Comandi root: `npm run dev`, `npm run dev:backend`, `npm run dev:frontend`, `npm run build`, `npm run test`, `npm run ci`.

Per setup completo, deploy, GitHub Actions e troubleshooting usa la sezione `Onboarding operativo` in fondo a questo README.

Compatibili: `start.bat`, `start.sh`, `docker-compose.yml`, `docker-compose.prod.yml`.

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

### Fonte dati attiva del progetto

| Ambito | Fonte | Note operative |
|---|---|---|
| Dati calcistici | Understat | Fonte ufficiale attiva per squadre, partite, giocatori, xG e tiri |
| Quote utente | Eurobet | Unica fonte quote mostrata lato UI |
| Fallback tecnici quote | Provider interni / diagnostici | Ammessi solo lato backend, mai mostrati come quote Eurobet |

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
Se non disponibili: fallback `h2h`, `totals`. Se il provider non risponde, eventuali
stime o fallback restano interni al backend per continuita operativa e diagnostica,
ma non devono essere mostrati all'utente come quote Eurobet.

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

### Configurazione runtime locale

Usa solo il file `.env` nella root del repository.

```powershell
copy .env.example .env
npm install
npm --prefix backend install
npm --prefix frontend install
npm run dev
```
---

## 🤝 Avvertenza

Questo software è destinato esclusivamente a scopi **educativi e informativi**.
Le scommesse comportano rischi finanziari significativi. Gioca sempre responsabilmente.
---

## FORMULARIO COMPLETO DEL SISTEMA
Football Prediction & Value Betting Engine  
Versione 4.0 — Aprile 2026

### 1. DIXON-COLES MODEL

#### 1.1 Goal Rate (Lambda) per squadra
Il tasso di goal attesi viene stimato come:

```
lambda_home = alpha_home x beta_away x gamma_home x exp(HA_home)
lambda_away = alpha_away x beta_home x gamma_away
```

dove:
- `alpha_i` = parametro offensivo (attack param)
- `beta_i` = parametro difensivo (defence param)
- `gamma_home` = `contextAdjustments.homeGoalMultiplier` (da `PredictionContextBuilder`)
- `HA_home` = `homeAdvantagePerTeam[homeId] ?? homeAdvantage`
  parametro per squadra/stadio (nuovo v4)
  globale `0.10` se non specificato -> `exp(0.10) ~= +10.5%` goal in casa

Nuovo v4: `homeAdvantage` non e piu un unico scalare globale.  
`fitModel()` ora stima un HA separato per ogni squadra home se `enablePerTeamHomeAdvantage=true`.  
Il parametro globale rimane come prior e fallback (shrinkage).  
Ridotto da `0.25` (v1) -> `0.10` (v3): home win rate Serie A 2020-2024 ~40% (era ~46% pre-2015).

#### 1.2 Score Matrix — Distribuzione di Poisson bivariata
La probabilita di un risultato `(i, j)`:

```
P(home=i, away=j) = tau(i,j,lambda_home,lambda_away,rho) x Poisson(i,lambda_home) x Poisson(j,lambda_away)
```

Correzione `tau` di Dixon-Coles (bassi punteggi):
- `tau(0,0) = 1 - lambda_home x lambda_away x rho`
- `tau(1,0) = 1 + lambda_away x rho`
- `tau(0,1) = 1 + lambda_home x rho`
- `tau(1,1) = 1 - rho`
- `tau(i,j) = 1` per tutti gli altri `(i,j)`

`rho` = parametro correlazione goal casa/ospite (default ~`-0.13`)

#### 1.3 Ottimizzatore Adam (nuovo v4 — sostituisce Gradient Ascent)
I parametri vengono stimati massimizzando la log-verosimiglianza pesata con l'ottimizzatore Adam:

```
L = sum_t w(t) x log P(home_goals_t, away_goals_t)
```

Peso ibrido stagione-aware (invariato):
- stagione corrente: `w = exp(-0.002 x age_weeks)` (quasi uniforme)
- stagione precedente: `w = 0.35 x exp(-0.018 x age_weeks)`
- stagioni piu vecchie: `w = 0.08 x exp(-0.018 x age_weeks)`
- partite pre-cambio allenatore: `w x 0.15`
- partite pre-evento strutturale (mercato, promozione): `w x 0.25` (nuovo v4)

Adam update (Kingma & Ba, 2014):

```
m1_t = beta1 x m1_{t-1} + (1 - beta1) x g_t      [beta1 = 0.90]
m2_t = beta2 x m2_{t-1} + (1 - beta2) x g_t^2    [beta2 = 0.999]
m1_hat = m1_t / (1 - beta1^t)    (bias correction)
m2_hat = m2_t / (1 - beta2^t)
Delta_theta = lr x m1_hat / (sqrt(m2_hat) + eps) [eps = 1e-8]
theta_{t+1} = theta_t + Delta_theta
```

Convergenza: `|LL_t - LL_{t-1}| < 1e-7` per 8 iter (era 1e-6, 12 iter).  
Tipicamente converge in 80-120 iter (era 200-280 con gradient ascent).  
Vantaggio Adam: learning rate adattivo per parametro.  
Interfaccia pubblica `fitModel()` invariata: cambia solo il loop interno.

#### 1.4 Bootstrap parametrico per propagazione incertezza (nuovo v4)
Il metodo `bootstrapLambdas()` campiona N perturbazioni gaussiane dei parametri stimati e restituisce la distribuzione di lambda:

```
sigma_attack[t]  = PARAM_NOISE_BASE / sqrt(n_home)   [PARAM_NOISE_BASE = 0.18]
sigma_defence[t] = PARAM_NOISE_BASE / sqrt(n_away)
sigma_HA         = PARAM_NOISE_BASE / sqrt(n_total)
```

Per ogni campione `i = 1..N` (`N = 200` default):

```
alpha_H^i = alpha_home + eps_i x sigma_attack_home     [eps_i ~ N(0,1)]
alpha_A^i, beta_H^i, beta_A^i, HA^i analogamente
lambda_home^i = exp(alpha_H^i - beta_A^i + HA^i)
lambda_away^i = exp(alpha_A^i - beta_H^i)
```

Output:
- `lambda_home_mean`, `lambda_home_std`, `lambda_away_mean`, `lambda_away_std`
- `CV_max = max(std_home/mean_home, std_away/mean_away)`
- `uncertaintyFactor = clamp(CV_max / 0.25, 0, 1)` in `[0,1]`

`uncertaintyFactor = 0`: parametri stabili (molte partite)  
`uncertaintyFactor = 1`: alta incertezza (poche partite, lambda molto variabile)  
Usato dal Bayesian Kelly nel Value Engine per scalare lo stake.

#### 1.5 Probabilita mercati 1X2 e Over/Under
Dalla score matrix (invariato rispetto a v3):

| Mercato | Formula |
|---|---|
| `P(homeWin)` | `sum_{i>j} P(home=i, away=j)` |
| `P(draw)` | `sum_{i=j} P(home=i, away=j)` |
| `P(awayWin)` | `sum_{i<j} P(home=i, away=j)` |
| `P(btts)` | `sum_{i>=1, j>=1} P(i, j)` |
| `P(over 2.5)` | `sum_{i+j>2} P(i, j)` |
| `P(exact i-j)` | `P(home=i, away=j)` diretta |
| `P(handicap h)` | `sum_{i-j>h} P(i, j)` europeo |

### 2. SPECIALIZED MODELS — Binomiale Negativa

#### 2.1 Distribuzione NegBin e stima dispersione

```
P(X=k | mu, r) = C(k+r-1, k) x p^r x (1-p)^k
p = r / (r + mu)
E[X] = mu
Var[X] = mu + mu^2/r
```

Stima `r` dai dati (metodo dei momenti):

```
r = mu^2 / (sigma^2 - mu)
r_min = 1 + 1/sqrt(n)
r_max contestuale: shots 40, SOT 30, yellow 50, fouls 60
```

#### 2.2-2.5 Tiri, cartellini, falli, angoli
Invariati rispetto a v3. I parametri `r` sono stimati dinamicamente per ogni squadra dai dati storici di varianza.

### 3. SHOTS MODEL — Zero-Inflated Poisson (giocatore)

#### 3.1 Modello ZIP

```
P(X=0) = pi + (1-pi) x e^{-lambda}
P(X=k) = (1-pi) x e^{-lambda} x lambda^k / k!   per k >= 1
E[X] = (1-pi) x lambda
Var[X] = (1-pi) x lambda x (1 + pi x lambda)
```

#### 3.2 Stima parametri ZIP — algoritmo EM

```
E-step: gamma = pi / (pi + (1-pi) x e^{-lambda})
n_structural = n_zeros x gamma

M-step: pi_new = n_structural / n
lambda_new = sum x_i / (n - n_structural)
```

Convergenza: `|Delta_pi| < 1e-6` AND `|Delta_lambda| < 1e-6` (max 100 iter).

#### 3.3 minutesFactor con distribuzione triangolare (nuovo v4)
Distribuzione triangolare sui minuti `[min, mode, max]`:

```
min  = expectedMinutes x (1 - minutesUncertainty)   [default +-15%]
max  = min(90, expectedMinutes x (1 + minutesUncertainty))
mode = expectedMinutes

E[minutesFactor] = (min + max + mode) / (3 x 90)
Var[minutesFactor] = (min^2 + max^2 + mode^2 - minxmax - minxmode - maxxmode) / 18 / 90^2
```

Propagazione varianza su `pi`:

```
minutesVariancePenalty = 0.4 x sqrt(Var[minutesFactor])
pi_adj = min(0.98, pi + (1 - E[minutesFactor]) x 0.30 + minutesVariancePenalty)
lambda_adj = lambda x E[minutesFactor] x locationMult x defenceQuality
```

Tiri in porta: stessa logica con `minutesVariancePenalty x 0.8` (attenuato).  
Confidenza: `min(0.90, sigma((n - 10) / 7))` (invariato).  
Piu incertezza sui minuti -> `pi` piu alto -> piu probabilita strutturale di 0 tiri.

### 4. PREDICTION CONTEXT BUILDER

#### 4.1 absenceLoad scalato per profondita rosa (nuovo v4)

```
ABSENCE_IMPACT_RATE = 0.28

homeAbsenceLoad = homeSuspensions + homeKeyAbsences x 1.35
awayAbsenceLoad = awaySuspensions + awayKeyAbsences x 1.35

homeAbsenceDivisor = max(13, homeRosterDepth) x 0.28
awayAbsenceDivisor = max(13, awayRosterDepth) x 0.28

absencesDelta = clamp(
  awayAbsenceLoad/awayAbsenceDivisor - homeAbsenceLoad/homeAbsenceDivisor,
  -1, +1
)
```

Esempi:
- rosa 16 -> divisore 4.5
- rosa 22 -> divisore 6.2
- rosa 28 -> divisore 7.8

#### 4.2 goalBias con interazione forma x assenze (nuovo v4)

```
formAbsenceInteraction = formDelta x absencesDelta x 0.04

goalBias = formDelta x w_form
         + motivDelta x w_motivation
         + restDelta x 0.05
         + schedLoadDelta x 0.04
         + absencesDelta x w_absences
         + disciplineDelta x w_discipline
         + formAbsenceInteraction
```

`shotBias` analogo, con `formAbsenceInteraction x 0.6`.

Pesi (invariati):
- `w_form ~= 0.12`
- `w_motivation ~= 0.06`
- `w_absences ~= 0.05`
- `w_discipline ~= 0.03`

#### 4.3 Moltiplicatori goal con asimmetria di forma (v2, invariato)

```
homeFormAbs = clamp((homeFormIndex - 0.5) x 0.08, -0.04, +0.04)
awayFormAbs = clamp((awayFormIndex - 0.5) x 0.08, -0.04, +0.04)
pureGoalBias = goalBias - formDelta x w_form x 0.5

homeGoalMultiplier = clamp(1 + homeFormAbs + pureGoalBias, 0.72, 1.35)
awayGoalMultiplier = clamp(1 + awayFormAbs - pureGoalBias, 0.72, 1.35)
homeShotMultiplier = clamp(1 + homeFormAbsx0.8 + pureShotBias, 0.75, 1.30)
awayShotMultiplier = clamp(1 + awayFormAbsx0.8 - pureShotBias, 0.75, 1.30)
```

#### 4.4 RichnessScore (invariato v3)

```
richnessScore = clamp(
  0.30 + min(1, sampleBase/24)x0.32 + (hasBothXG?0.12:0)
  + playerCoveragex0.10 + refereeCoveragex0.06,
  0.30, 0.93
)
```

### 5. VALUE BETTING ENGINE

#### 5.1 Expected Value e edgeNoVig (nuovo v4)

```
EV = P_model x odds - 1

p_implied_raw = 1 / odds
p_no_vig = p_implied_raw / overround

edge = P_model - p_implied_raw
edgeNoVig = P_model - p_no_vig
```

#### 5.2 Bayesian Kelly adattivo (nuovo v4)

```
Full Kelly: f* = (b x P - (1-P)) / b, b = odds - 1
Quarter Kelly: f_quarter = f* x 0.25

stake_base = clamp(f_quarter x 100 x confidenceMult,
                   MIN_STAKE=0.25%, MAX_STAKE=4.0%)

uncertaintyDiscount = clamp(uncertaintyFactor, 0, 1) x 0.5
stake_final = max(0.25%, stake_base x (1 - uncertaintyDiscount))
```

Confidence multiplier (invariato):
- HIGH (`EV>=8%` AND `kelly>=1.5%`): `x1.20`
- MEDIUM (`EV>=5%` AND `kelly>=0.8%`): `x1.00`
- LOW (altrimenti): `x0.70`

`computeSuggestedStake()` resta invariata (wrapper con `uncertaintyFactor=0`).  
Usare `computeSuggestedStakeWithUncertainty()` passando l'output di `bootstrapLambdas()`.

#### 5.3 Soglie EV per categoria (invariato v3)

| Categoria | Soglia EV minimo |
|---|---|
| `goal_1x2` | 3.0% |
| `goal_ou` | 2.5% |
| `shots` | 4.0% |
| `shots_ot` | 4.0% |
| `corners` | 3.5% |
| `yellow_cards` | 4.5% |
| `fouls` | 5.0% |
| `exact_score` | 5.0% |
| `handicap` | 5.0% |

#### 5.4 Soglia EV adattiva per richnessScore (invariato v3)

```
evMultiplier = 1 + (1 - richnessScore) x 1.2
evDelta_agg  ~= soglia_base x (evMultiplier - 1)
```

### 6. COMBINATE (Multi-Bet)

#### 6.1 Matematica e MAX_COMBO_STAKE scalato con sqrt(n_legs) (nuovo v4)

```
P_combo = product_i P_i
odds_combo = product_i odds_i
EV_combo = P_combo x odds_combo - 1

b = odds_combo - 1
f* = (b x P_combo - (1-P_combo)) / b
f_quarter = f* x 0.25

BASE_COMBO_CAP = 4.0% x 0.6 = 2.4%
MAX_COMBO_STAKE(n) = max(0.5%, BASE_COMBO_CAP / sqrt(n))

stake_combo = clamp(f_quarterx100, MIN_STAKE=0.25%, MAX_COMBO_STAKE(n))
```

#### 6.2 Correzione correlazione intra-partita (invariato v3)
Correlazioni stimate:
- `homeWin <-> over2.5`: `rho ~= +0.40`
- `over2.5 <-> btts`: `rho ~= +0.55`
- `homeWin <-> btts`: `rho ~= -0.20`
- `shots <-> over2.5`: `rho ~= +0.30`

Kelly corretto (approssimazione pratica):
- `sum stake_i` per partita `<= 5% bankroll` (CORE)
- `sum stake_i` per partita `<= 4% bankroll` (SECONDARY)
- Se si supera, scaling proporzionale degli stake

### 7. CALIBRAZIONE ISOTONICA (aggiornato v4)

#### 7.1 Fit con bucket adattivi + Pool Adjacent Violators (nuovo v4)
Passo 1 — bucket adattivi a densita uniforme:
- ordina le bet per `ourProb` crescente
- `nBuckets = max(1, floor(n / MIN_BUCKET_SIZE))`, con `MIN_BUCKET_SIZE = 20`
- ogni bucket ha ~`MIN_BUCKET_SIZE` bet
- `x_bucket = media ourProb`, `y_bucket = frequenza vittorie`

Passo 2 — Isotonic Regression (PAV):
- se `y[i] > y[i+1]`, fondi i bucket
- ripeti fino a convergenza
- risultato: `y[0] <= y[1] <= ... <= y[K]`

Output: `predictedRange = '[min%-max%]'` su quantili effettivi.

#### 7.2 Applicazione della calibrazione (invariato v3)

```
t = (p_raw - x_lo) / (x_hi - x_lo)
p_cal = y_lo + t x (y_hi - y_lo)

alpha = max(0.10, 1 / (1 + n/1000))
p_final = alpha x p_raw + (1-alpha) x p_cal
```

### 8. BACKTESTING ENGINE (aggiornato v4)

#### 8.1 Holdout temporale duro (nuovo v4)

```
runBacktest(matches, odds, trainRatio=0.7, confidenceLevel, temporalHoldoutMonths=0)
```

Con `temporalHoldoutMonths > 0`:
- `cutoff = lastDate - temporalHoldoutMonths mesi`
- `trainSet = matches con date < cutoff`
- `testSet = matches con date >= cutoff` (mai visto nel fitting)
- fallback a `trainRatio` se `trainSet < 30`

Metrica chiave: confronto `edgeNoVig(testSet)` vs `edgeNoVig(trainSet)`.

#### 8.2 Nuove metriche di monitoraggio (nuovo v4)

| Metrica | Descrizione |
|---|---|
| `edgeNoVig` | `mean(ourProb_i - 1/odds_i)` |
| `edgeDecayByMonth` | edgeNoVig per mese |
| `rollingSharpePeriods` | Sharpe su finestre fisse di 50 bet |
| `usedSyntheticOddsOnly` | true se tutte le quote sono sintetiche |

#### 8.3 Metriche standard (invariato v3)

| Metrica | Formula |
|---|---|
| ROI | `(totalReturn - totalStaked) / totalStaked x 100` |
| Win Rate | `betsWon / betsPlaced` |
| Brier Score | `mean((P_model_i - outcome_i)^2)` |
| Log Loss | `-mean(y_i log(P_i) + (1-y_i) log(1-P_i))` |
| Sharpe Ratio | `(mu_profit / sigma_profit) x sqrt(bets_per_year)` |
| Max Drawdown | `min((bankroll_t - peak_t)/peak_t)` |
| Recovery Factor | `netProfit / |MaxDD x initialBankroll|` |
| Profit Factor | `sum(profit_won) / sum(|profit_lost|)` |

#### 8.4 Walk-Forward Validation (invariato v3)
Per ogni fold `k = 1..K`:
- train: `match[0 .. splitPoint_k]`
- test: `match[splitPoint_k .. splitPoint_k + testWindow]`
- expanding window: train cresce a ogni fold
- rolling window: train a dimensione fissa

Metriche aggregate:
- `medianFoldROI`
- `roiStdDev`
- `positiveFoldRate = count(ROI_k > 0)/K`

### 9. ADAPTIVE TUNING — Learning Reviews (invariato v3)

```
evDelta raw = -filterRejectionRatex0.010
              -rankingErrorRatex0.002
              +confirmationRatex0.002
              +wrongPickRatex0.004

confidenceScale = clamp(totalWeight/12, 0.2, 1.0)
evDelta = clamp(raw x confidenceScale, -0.012, +0.008)
```

### 10. RIEPILOGO MODIFICHE v4

| Modifica | File e descrizione |
|---|---|
| Adam optimizer | `DixonColesModel.ts` — sostituisce gradient ascent, bias correction |
| homeAdvantagePerTeam | `DixonColesModel.ts` — parametro HA per squadra/stadio |
| structuralBreaks | `DixonColesModel.ts` — penalita peso 0.25 pre-eventi strutturali |
| bootstrapLambdas() | `DixonColesModel.ts` — bootstrap parametrico N=200, `uncertaintyFactor` |
| Holdout temporale duro | `BacktestingEngine.ts` — `temporalHoldoutMonths` in `runBacktest()` |
| Isotonic + bucket adattivi | `BacktestingEngine.ts` — PAV con bucket uniformi >=20 bet |
| edgeNoVig + edgeDecay + rollingSharpe | `BacktestingEngine.ts` — metriche monitoraggio alpha |
| MAX_COMBO_STAKE x 1/sqrt(n_legs) | `ValueBettingEngine.ts` — cap stake combinata scalato |
| Bayesian Kelly adattivo | `ValueBettingEngine.ts` — `computeSuggestedStakeWithUncertainty()` |
| absenceLoad per profondita rosa | `PredictionContextBuilder.ts` — divisore dinamico |
| Interazione forma x assenze | `PredictionContextBuilder.ts` — `formDelta x absencesDelta x 0.04` |
| minutesFactor triangolare | `ShotsModel.ts` — triangolare +-15%, varianza su pi ZIP |

--- Fine del documento ---

## Environment locale e rotazione credenziali

- Crea il file locale con `copy .env.example .env` nella root del repository e compila solo i placeholder necessari.
- Non versionare mai `.env`, `.env.production` o altri file con credenziali reali.
- Se il repository ha esposto credenziali in passato, ruotale prima di qualunque nuovo deploy o pubblicazione pubblica.
- Dopo la clonazione installa prima le dipendenze root con `npm install`, poi quelle di `backend` e `frontend`: le cartelle `node_modules` non devono essere nel repository.

## Sicurezza e rotazione credenziali

### Uso corretto dei segreti

- In GitHub Actions usa sempre `Settings > Secrets and variables > Actions` per salvare chiavi API, token DB e credenziali runtime.
- Nei workflow referenzia i segreti solo tramite `${{ secrets.NOME_SECRET }}`.
- In `docker-compose.yml` e `docker-compose.prod.yml` il runtime deve leggere i valori solo da variabili ambiente interpolate, non da file committati con valori reali.
- `.env.example` deve contenere solo placeholder sicuri.

### Secret scan automatico

- Il repository esegue uno scan automatico su `push` e `pull_request` tramite [`.github/workflows/secret-scan.yml`](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.github/workflows/secret-scan.yml).
- La configurazione Gitleaks sta in [`.gitleaks.toml`](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.gitleaks.toml).
- Lo scan locale richiede `gitleaks` installato sulla macchina oppure Docker disponibile.
- Lo scan locale equivalente e:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\security\run-secret-scan.ps1 -Mode git
```

### Cosa fare se una chiave viene esposta

1. revoca o ruota subito la credenziale compromessa
2. aggiorna GitHub Secrets, variabili ambiente locali e ambiente di deploy
3. riesegui lo scan locale e quello CI
4. valuta la bonifica history seguendo [docs/security/history-cleanup.md](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/docs/security/history-cleanup.md)
5. registra data, impatto e credenziali ruotate nel changelog operativo interno

### Come ruotare le credenziali applicative

- `TURSO_AUTH_TOKEN`: genera un nuovo token dal provider, aggiorna GitHub Secrets e i file `.env` locali, poi invalida il vecchio token.
- `ODDS_API_KEY` e altre API key esterne: crea una nuova chiave dal portale del provider, sostituiscila nei secret manager, poi revoca la precedente.
- Se il leak ha toccato piu ambienti, ruota tutte le varianti `dev`, `staging`, `prod` e non solo quella usata localmente.

### Bonifica history

- La guida operativa e in [docs/security/history-cleanup.md](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/docs/security/history-cleanup.md).
- Nessuna bonifica distruttiva viene eseguita automaticamente in questo repository.

## Onboarding operativo

### Setup locale raccomandato

1. Clona il repository.
2. Crea `./.env` nella root a partire da [`.env.example`](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.env.example).
3. Installa le dipendenze:

```powershell
npm install
npm --prefix backend install
npm --prefix frontend install
```

4. Avvia lo sviluppo da root:

```powershell
npm run dev
```

Servizi previsti:
- frontend: [http://localhost:3000](http://localhost:3000)
- backend: [http://localhost:3001/api/health](http://localhost:3001/api/health)

### Variabili ambiente: verita unica

- Il file `.env` nella root e la sola sorgente di verita locale.
- Backend:
  `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ODDS_API_KEY`, `THE_ODDS_API_KEY`, `SKIP_EUROBET_SCRAPER`, `UNDERSTAT_*`, `SOFASCORE_*`, `ODDS_SNAPSHOT_*`, `LEARNING_REVIEW_*`, `EUROBET_*`, `TZ`, `AUTO_SYNC_ON_BOOT`.
- Frontend:
  nessun segreto runtime richiesto in locale; `FRONTEND_PORT` serve per Docker.

### Docker

Avvio standard:

```powershell
docker compose up -d --build
```

Avvio produzione-like:

```powershell
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Compatibilita preservata:
- [start.bat](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/start.bat)
- [start.sh](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/start.sh)
- [docker-compose.yml](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/docker-compose.yml)
- [docker-compose.prod.yml](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/docker-compose.prod.yml)

### GitHub Actions e deploy

- CI generale: [`.github/workflows/ci.yml`](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.github/workflows/ci.yml)
- Nightly sync: [`.github/workflows/nightly-sync.yml`](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.github/workflows/nightly-sync.yml)
- Secret scan: [`.github/workflows/secret-scan.yml`](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.github/workflows/secret-scan.yml)
- Eurobet smoke manuale: [`.github/workflows/eurobet-smoke.yml`](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.github/workflows/eurobet-smoke.yml)

Per GitHub Actions e deploy usa solo GitHub Secrets o variabili ambiente del runtime:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `ODDS_API_KEY`

### Smoke Eurobet

Controllo locale rapido:

```powershell
cd backend
npm run smoke:eurobet -- --competition "Serie A" --verbose
```

Con fixture specifiche:

```powershell
cd backend
npm run smoke:eurobet -- --competition "Serie A" --fixture "Inter|Milan|2026-04-20T18:45:00Z" --include-extended-groups
```

### Troubleshooting

- Playwright/Chromium:

```powershell
cd backend
npx playwright install --with-deps chromium
```

- Debug Eurobet con browser visibile:

```powershell
cd backend
npm run dev:eurobet-headed
```

- Porte:
  `3000` per frontend locale, `3001` per backend; in Docker puoi cambiare la porta frontend con `FRONTEND_PORT`.
- Env:
  se usi i comandi root, non creare `.env` separati in `backend` o `frontend`.
