# Rimozione backtest classico

Data: 2026-05-19

## Perche

Il backtest classico con singolo split train/test e stato rimosso dal flusso ufficiale per ridurre ambiguita e rischio di overfitting. Il walk-forward simula meglio l'uso reale: il modello viene addestrato solo su dati precedenti e validato su finestre successive.

## Cosa resta

- `POST /backtest/walk-forward` e l'endpoint ufficiale.
- Top 5 campionati resta supportato solo in modalita walk-forward.
- Restano invariati baseline/current/tuned comparison, quote Eurobet reali vs sintetiche, CLV, overfitting risk e tuning ranking.
- Gli helper condivisi del motore restano nel `BacktestingEngine` perche usati dai fold walk-forward.

## Endpoint deprecati

- `POST /backtest` resta temporaneamente come alias deprecated verso `POST /backtest/walk-forward`.
- La UI non usa piu `POST /backtest`.
- Nuovi run salvati dalla UI hanno `kind: "walk_forward"`.

## Archivio run

I vecchi run classic possono ancora comparire nell'archivio. Se caricati, la UI mostra un badge/avviso legacy e usa il Report Decisionale disponibile, ma non ripropone la vecchia modalita classica.

## File principali aggiornati

- `backend/src/api/routes.ts`
- `backend/src/services/PredictionService.ts`
- `backend/src/models/backtesting/BacktestingEngine.ts`
- `frontend/src/utils/api.ts`
- `frontend/src/hooks/useBacktestingData.ts`
- `frontend/src/components/backtesting/BacktestingPageView.tsx`
- `backend/test/backtesting-engine.test.js`
- `backend/test/prediction-service-best-pick.test.js`
- `frontend/src/components/backtesting/backtesting-page-view.test.tsx`
- `README.md`

## Test da eseguire

```powershell
cd backend
npm run typecheck
npm test

cd frontend
npm run typecheck
npm run test:ci
npm run build
```

## Limiti residui

- `POST /backtest` non e ancora rimosso fisicamente per compatibilita temporanea con client esterni.
- I report legacy classic restano leggibili solo come dati storici; non rappresentano piu il flusso ufficiale.
