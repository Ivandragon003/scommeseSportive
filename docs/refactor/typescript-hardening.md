# TypeScript Hardening

## Obiettivo

Rendere `lint` e TypeScript piu utili nel trovare codice morto e bug reali senza attivare in un colpo solo regole che oggi genererebbero centinaia di errori.

## Strategia graduale

### Fase 1: codice morto e hook incoerenti

Stato: applicata in questa patch.

Cosa e stato abilitato:

- `@typescript-eslint/no-unused-vars` in backend e frontend
- escape hatch esplicito con `_unused`, `_err`, `_ignored`
- `react-hooks/exhaustive-deps` riabilitata nel frontend

Cosa e stato corretto per portare il repo a verde:

- rimosso stato morto e handler non usati in `DataManagerPageView`
- stabilizzate le dipendenze dei `useEffect` in `usePredictionWorkbench` e `BudgetManager`
- rimossi import e helper backend non piu usati
- ripuliti alcuni `any` nel provider layer backend e nel workbench predictions frontend

### Fase 2: riduzione progressiva di `any`

Stato: avviata solo su sottoinsiemi puliti.

Cartelle/moduli gia stretti:

- `backend/src/services/odds-provider/**/*.ts`
- `frontend/src/components/common/**/*.{ts,tsx}`

In queste aree `@typescript-eslint/no-explicit-any` e ora attiva.

Passi successivi consigliati:

- introdurre contratti API condivisi o paralleli per i payload piu usati
- creare `frontend/src/types` quando i view model principali saranno stabili
- spostare fuori da `any` i flussi predictions, budget e backtest piu usati dalla UI

### Fase 3: TypeScript piu stretto per cartelle progressive

Stato: pianificata, non ancora applicata globalmente.

Approccio consigliato:

- mantenere `strict: false` a livello repo
- attivare prima controlli piu severi sui moduli nuovi o gia refactorizzati
- valutare `noImplicitAny`, `noUnusedLocals` e `noUnusedParameters` tramite tsconfig separati o per cartelle quando il debito residuo sara basso

## Regole attive dopo questa patch

### Backend

- `@typescript-eslint/no-unused-vars`: `error`
- `@typescript-eslint/no-explicit-any`: `off` globale
- `@typescript-eslint/no-explicit-any`: `error` in `src/services/odds-provider/**/*.ts`

### Frontend

- `@typescript-eslint/no-unused-vars`: `error`
- `react-hooks/exhaustive-deps`: `error`
- `@typescript-eslint/no-explicit-any`: `off` globale
- `@typescript-eslint/no-explicit-any`: `error` in `src/components/common/**/*.{ts,tsx}`

## Regole volutamente ancora disattivate

### `strict: true`

Non abilitata. Oggi impatterebbe troppe aree legacy insieme e renderebbe la patch poco controllabile.

### `noImplicitAny`

Non abilitata globalmente per lo stesso motivo. La riduzione di `any` va fatta prima sui confini dei moduli e poi nelle implementazioni interne.

### `@typescript-eslint/no-explicit-any` globale

Non abilitata. In repo ci sono ancora flussi legacy con payload dinamici, soprattutto su prediction, backtesting e route Express.

### `noUnusedLocals` / `noUnusedParameters` del compilatore TypeScript

Non abilitati. In questa fase il controllo viene demandato a ESLint per avere rollout piu graduale e feedback piu leggibile.

## Debito residuo principale

- payload API e prediction ancora troppo dinamici in frontend hooks e pagine legacy
- route/backend con diversi `req.body` e `res.json` non tipizzati
- modelli statistici legacy con shape dati non ancora consolidate

## Prossime mosse consigliate

1. Introdurre tipi espliciti per i payload di `/api/predict`, `/api/backtest/report`, `/api/system/*`.
2. Portare `no-explicit-any` su altri moduli gia refactorizzati, non sulle aree legacy tutte insieme.
3. Preparare un tsconfig piu stretto per i moduli nuovi o per una suite di cartelle pulite.
