# Frontend UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare il frontend in un prodotto di analisi sportiva chiaro, Eurobet-only e comprensibile a principianti ed esperti, con glossario completo e strumenti avanzati ordinati.

**Architecture:** Un design system CSS globale governa shell e componenti. Un modulo `features/glossary` centralizza catalogo, pagina, drawer e termini contestuali. Le pagine esistenti mantengono hook e contratti API, mentre le view vengono riorganizzate con progressive disclosure.

**Tech Stack:** React 18, TypeScript 4.9, React Router 6, Testing Library, Jest, CSS esistente, lucide-react.

## Global Constraints

- Modificare esclusivamente `frontend/**`.
- Non aggiungere dipendenze.
- Non cambiare API, payload, modelli, calcoli o logica backend.
- Mostrare e rendere azionabili soltanto quote Eurobet.
- Understat primaria; football-data.co.uk supplementare; nessun SofaScore, FotMob, Transfermarkt o FBref.
- Una sola giocata finale squadra; player props separate; nessuna diagnostica learning nella UI.
- Interfaccia italiana, desktop-first, accessibile e utilizzabile su viewport strette.
- Nessun commit, branch, stash, reset o push: vietati da `AGENTS.md` senza richiesta esplicita.

---

### Task 1: Shell, design system e glossario

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/footpredictor.css`
- Modify: `src/components/common/common-feedback.css`
- Create: `src/features/glossary/glossaryTypes.ts`
- Create: `src/features/glossary/glossaryEntries.ts`
- Create: `src/features/glossary/GlossaryProvider.tsx`
- Create: `src/features/glossary/GlossaryTerm.tsx`
- Create: `src/features/glossary/GlossaryPage.tsx`
- Create: `src/features/glossary/glossary.css`
- Create: `src/features/glossary/glossary.test.tsx`

**Interfaces:**
- Produces: `GlossaryProvider`, `GlossaryTerm`, `GlossaryPage`, `GLOSSARY_ENTRIES`.
- `GlossaryTerm` accepts `termId`, optional `children` and optional `className`.

- [ ] **Step 1: Scrivere test RED**
  - Verificare gruppi “Analisi” e “Strumenti avanzati”.
  - Verificare route `/glossary`, ricerca, categoria, indice e drawer globale.
  - Verificare che tutte le voci obbligatorie abbiano i campi interpretativi completi.
- [ ] **Step 2: Eseguire i test mirati e verificare il fallimento per route/modulo assenti**
  - Run: `npm test -- --watchAll=false src/App.test.tsx src/features/glossary/glossary.test.tsx`
  - Expected: FAIL su route e componenti glossario mancanti.
- [ ] **Step 3: Implementare catalogo, provider, pagina, drawer, termini contestuali e nuova shell**
- [ ] **Step 4: Sostituire i token globali con palette chiara, raggi contenuti e superfici piatte**
- [ ] **Step 5: Eseguire test mirati, typecheck e lint**
  - Run: `npm test -- --watchAll=false src/App.test.tsx src/features/glossary/glossary.test.tsx`
  - Run: `npm run typecheck`
  - Run: `npm run lint`
  - Expected: exit 0.

### Task 2: Previsioni e vincolo quote Eurobet-only

**Files:**
- Modify: `src/components/predictions/predictions.test.tsx`
- Modify: `src/pages/predictions-page.test.tsx`
- Modify: `src/components/predictions/BestValueCard.tsx`
- Modify: `src/components/predictions/PredictionHero.tsx`
- Modify: `src/components/predictions/PredictionWorkbenchView.tsx`
- Modify: `src/components/predictions/ValueOpportunitiesTable.tsx`
- Modify: `src/components/predictions/predictionWorkbenchUtils.ts`
- Modify: `src/hooks/useOddsForMatch.ts`
- Modify: `src/hooks/usePredictionWorkbench.ts`

**Interfaces:**
- Produces: `isActionableOddsSource(source): boolean`.
- `sanitizePredictionForBookmakerOdds` elimina opportunità e consiglio quando la fonte non è `odds_api`.

- [ ] **Step 1: Scrivere test RED**
  - Il referto mostra solo quota Eurobet, probabilità stimata, affidabilità e puntata.
  - Il referto non mostra EV, edge, score o alternative.
  - Un fallback non genera una seconda prediction con quote fallback, non mostra la quota e non espone il pulsante di registrazione.
  - Gli stati `NO_MARKET`, `SPECULATIVE`, `HIGH`, `MEDIUM` e `LOW` hanno etichette italiane.
- [ ] **Step 2: Eseguire i test mirati e verificare i fallimenti di comportamento**
  - Run: `npm test -- --watchAll=false src/components/predictions/predictions.test.tsx src/pages/predictions-page.test.tsx`
  - Expected: FAIL su fallback mostrato e metriche tecniche primarie.
- [ ] **Step 3: Implementare sanitizzazione Eurobet-only e referto decisionale**
- [ ] **Step 4: Aggiungere termini contestuali a probabilità, affidabilità, xG, EV, edge e Kelly nei soli livelli di approfondimento**
- [ ] **Step 5: Eseguire test mirati, typecheck e lint**

### Task 3: Budget comprensibile

**Files:**
- Modify: `src/pages/budget-manager.test.tsx`
- Modify: `src/pages/BudgetManager.tsx`
- Create: `src/pages/budget-manager.css`

**Interfaces:**
- Il capitale esposto è la somma degli stake `PENDING`.
- Il campione concluso è `WON + LOST`; i void sono mostrati separatamente.

- [ ] **Step 1: Scrivere test RED per bankroll iniziale/disponibile, capitale esposto, ROI interpretato e conteggi**
- [ ] **Step 2: Eseguire `npm test -- --watchAll=false src/pages/budget-manager.test.tsx` e verificare il fallimento**
- [ ] **Step 3: Implementare il nuovo riepilogo semantico e separare la manutenzione**
- [ ] **Step 4: Eseguire test mirati, typecheck e lint**

### Task 4: Backtesting interamente italiano e guidato

**Files:**
- Modify: `src/components/backtesting/backtesting-page-view.test.tsx`
- Modify: `src/components/backtesting/BacktestingPageView.tsx`

**Interfaces:**
- I valori API `high_only`, `medium_and_above` e `expandingWindow` restano invariati; cambiano soltanto label e spiegazioni.

- [ ] **Step 1: Scrivere test RED per etichette italiane e assenza delle etichette inglesi**
- [ ] **Step 2: Eseguire il test mirato e verificare il fallimento**
- [ ] **Step 3: Tradurre configurazione, tutorial, stato e risultati; aggiungere GlossaryTerm**
- [ ] **Step 4: Eseguire test mirati, typecheck e lint**

### Task 5: Dati e Provider allineati al backend corrente

**Files:**
- Modify: `src/utils/api.test.ts`
- Modify: `src/utils/api.ts`
- Modify: `src/components/scrapers/scrapers-page-view.test.tsx`
- Modify: `src/components/scrapers/ScrapersPageView.tsx`
- Modify: `src/components/data-manager/DataManagerPageView.tsx`

**Interfaces:**
- Produces: `runFootballDataSync(params)` → POST `/scraper/football-data`.
- `runUnderstatImport` non invia campi SofaScore rimossi dal backend.

- [ ] **Step 1: Scrivere test RED per endpoint football-data, assenza SofaScore e flusso supplementare**
- [ ] **Step 2: Eseguire `npm test -- --watchAll=false src/utils/api.test.ts src/components/scrapers/scrapers-page-view.test.tsx` e verificare il fallimento**
- [ ] **Step 3: Adeguare client API e pagina Provider al contratto backend esistente**
- [ ] **Step 4: Rendere Dati operativa, italiana e coerente con le fonti reali**
- [ ] **Step 5: Eseguire test mirati, typecheck e lint**

### Task 6: Pulizia visiva, responsive e accessibilità

**Files:**
- Modify: tutti i file frontend già toccati in Task 1–5.
- Delete: `src/App.css` se confermato non importato.

- [ ] **Step 1: Cercare gradienti, glassmorphism, glow, font remoti, emoji decorative, testo inglese e riferimenti legacy**
  - Run: `rg -n "linear-gradient|radial-gradient|backdrop-filter|fonts.googleapis.com|SofaScore|FotMob|Transfermarkt|FBref|Confidence filter|Initial train matches|Test window matches|Step matches|Expanding window" src`
- [ ] **Step 2: Rimuovere ogni occorrenza UI non consentita e sostituire stili inline ripetuti**
- [ ] **Step 3: Verificare focus, label, dialog, tooltip, overflow tabelle e `prefers-reduced-motion`**
- [ ] **Step 4: Eseguire typecheck, lint e suite completa frontend**

### Task 7: Verifica runtime e audit finale

**Files:**
- Nessuna modifica prevista; eventuali fix seguono un nuovo ciclo RED/GREEN.

- [ ] **Step 1: Eseguire verifiche frontend fresche**
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test:ci`
  - `npm run build`
- [ ] **Step 2: Eseguire verifiche backend di non regressione**
  - `npm run build`
  - `npm test`
- [ ] **Step 3: Eseguire `docker compose up -d --build backend frontend` e verificare `http://localhost:3001/api/health`**
- [ ] **Step 4: Verificare nel browser desktop e viewport 390px i flussi principali, la console e gli stati vuoti/errore**
- [ ] **Step 5: Eseguire audit statico finale e `git diff -- backend`**
- [ ] **Step 6: Confrontare ogni requisito della specifica con evidenza corrente e chiudere soltanto senza gap**
