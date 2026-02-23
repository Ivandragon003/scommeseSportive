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

## 📊 Valore Atteso e Kelly Criterion

### Expected Value
```
EV = P_nostra × quota - 1
```
Una scommessa è conveniente se EV > 2% (configurabile).

### Kelly Criterion (Frazionale 1/4)
```
f* = (b×p - q) / b
puntata_suggerita = f* × 0.25 × bankroll
```
Dove b = quota-1, p = nostra probabilità, q = 1-p.

### Classificazione Confidenza
| Confidenza | EV | P Nostra | Stake Max |
|---|---|---|---|
| HIGH | ≥8% | ≥55% | 5% bankroll |
| MEDIUM | ≥5% | ≥45% | 3% bankroll |
| LOW | ≥2% | qualsiasi | 2% bankroll |

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

Prerequisito locale (importante):
- `Node.js >= 20` (consigliato tramite `.nvmrc`)
- Con `better-sqlite3@12.6.2` il backend e testato anche su Node 24 (Windows)

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
│   │   │   ├── DixonColesModel.ts     # Core algoritmo statistico
│   │   │   ├── ValueBettingEngine.ts  # EV + Kelly Criterion
│   │   │   └── BacktestingEngine.ts   # Validazione su dati storici
│   │   ├── services/
│   │   │   └── PredictionService.ts   # Orchestrazione
│   │   ├── api/
│   │   │   └── routes.ts              # Express API
│   │   ├── db/
│   │   │   └── DatabaseService.ts     # SQLite persistenza
│   │   └── index.ts                   # Entry point
│   └── data/                          # Database SQLite (locale)
│
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.tsx          # Panoramica
│       │   ├── Predictions.tsx        # Analisi partite
│       │   ├── BudgetManager.tsx      # Bankroll & scommesse
│       │   ├── Backtesting.tsx        # Test su dati storici
│       │   └── DataManager.tsx        # Import dati
│       └── utils/api.ts               # Client API
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
    "referee": "Daniele Orsato",
    "competition": "Serie A",
    "season": "2024-25"
  }
]
```

---

## 🔬 Metriche di Validazione

| Metrica | Descrizione | Target |
|---|---|---|
| **ROI** | Return on Investment su test set | > 0% |
| **Brier Score** | Accuratezza probabilistica | < 0.25 |
| **Sharpe Ratio** | Rendimento risk-adjusted | > 1.0 |
| **Max Drawdown** | Perdita massima dal picco | < 20% |
| **Calibrazione** | Prob. previste vs. reali | Diagonale |
| **Log Loss** | Cross-entropy delle previsioni | < 0.65 |

---

## ⚠️ Note Importanti

1. **Il modello richiede almeno 20-30 partite per squadra** per stime affidabili
2. **Il backtesting usa 70% dati training, 30% test** (divisione cronologica)
3. **Le scommesse con EV > 2% sono considerate value bets** - non garantisce profitto
4. **Usa sempre Kelly Frazionale** (1/4 o 1/2 Kelly) per limitare la varianza
5. **I dati sono salvati localmente** in SQLite (`backend/data/football_predictor.db`)

---

## 🤝 Avvertenza

Questo software è destinato esclusivamente a scopi **educativi e informativi**.
Le scommesse comportano rischi finanziari significativi. Gioca sempre responsabilmente.
