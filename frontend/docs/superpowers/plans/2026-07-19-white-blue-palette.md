# White and Blue Frontend Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply a consistent white and light-blue visual identity to the existing React frontend while preserving green exclusively for success and positive values.

**Architecture:** Add semantic primary-color tokens to the global stylesheet, map the existing blue family to those tokens, and migrate only brand or interactive green usages to the primary family. Preserve green, red, and amber tokens for their current semantic states and do not change component structure, data flow, or backend code.

**Tech Stack:** React 18, TypeScript 4.9, CSS custom properties, Create React App, Jest, ESLint, Docker Compose.

## Global Constraints

- Modify frontend files only; `git diff -- backend` must remain empty.
- Do not change layout, routing, API contracts, business logic, prediction logic, odds behavior, or persistence.
- Do not add dependencies, gradients, glow effects, casino styling, or decorative animations.
- Use blue for brand, navigation, selection, primary actions, links, and focus.
- Keep green for success and positive values, red for errors and negative values, and amber for warnings.
- Maintain accessible contrast and visible keyboard focus.
- Do not create commits, branches, stashes, resets, or pushes without explicit user authorization.

---

### Task 1: Establish the semantic white-blue token system

**Files:**
- Modify: `frontend/src/footpredictor.css:1-55`
- Modify: `frontend/src/footpredictor.css:101-107`
- Modify: `frontend/src/footpredictor.css:183-193`
- Modify: `frontend/src/footpredictor.css:319-346`
- Modify: `frontend/src/footpredictor.css:686-691`
- Modify: `frontend/src/footpredictor.css:739-756`
- Modify: `frontend/src/footpredictor.css:811-816`
- Modify: `frontend/src/footpredictor.css:1216-1236`
- Modify: `frontend/src/footpredictor.css:1275-1301`

**Interfaces:**
- Consumes: existing CSS variables imported globally by `frontend/src/App.tsx`.
- Produces: `--primary`, `--primary-hover`, `--primary-dim`, `--primary-border`, and `--primary-focus`; the existing `--blue*` variables remain compatible aliases.

- [ ] **Step 1: Replace green-tinted neutral surfaces with white-blue neutrals**

Update the root token block to use:

```css
--bg: #f5f9fe;
--surface: #ffffff;
--surface2: #f8fbff;
--surface3: #edf5fc;
--surface4: #dfeaf5;

--border: #d5e2ee;
--border-hover: #a9bfd3;
--border-focus: var(--primary);

--text: #132238;
--text-2: #51657a;
--text-3: #718399;
```

- [ ] **Step 2: Add the primary token family and preserve blue compatibility**

Add:

```css
--primary: #1677c8;
--primary-hover: #0f5fa8;
--primary-dim: #eaf4ff;
--primary-border: #b8d7f0;
--primary-focus: rgba(22, 119, 200, 0.24);

--blue: var(--primary);
--blue-dim: var(--primary-dim);
--blue-hover: #dceeff;
--blue-border: var(--primary-border);
```

Keep the existing `--green*`, `--gold*`, and `--red*` variables unchanged for semantic states.

- [ ] **Step 3: Convert global identity and interaction states to primary blue**

Use the primary tokens for text selection, `:focus-visible`, the brand mark, active desktop navigation, form focus rings, active pills/tabs, active mobile navigation, and active mobile-more links:

```css
::selection {
  background: var(--primary-border);
}

:focus-visible {
  outline: 3px solid var(--primary-focus);
  outline-offset: 3px;
}

.app-brand-mark {
  background: var(--primary);
  border-color: var(--primary-hover);
}

.nav-item.active,
.fp-pill-btn.active,
.fp-tab.active,
.mobile-nav-item.active,
.mobile-more-link.active {
  background: var(--primary-dim);
  border-color: var(--primary-border);
  color: var(--primary);
}
```

Set `.nav-item.active .nav-icon-wrap` and `.mobile-more-link__icon` to `color: var(--primary)`. Set `.fp-input`, `.fp-select`, and `.fp-textarea` focus shadows to `var(--primary-focus)`. Set primary button hover to `var(--primary-hover)`.

- [ ] **Step 4: Preserve semantic green components**

Confirm that these selectors continue using `--green*`: `.sync-banner--success`, `.app-status-chip.is-success`, `.fp-btn-green`, `.fp-badge-green`, `.fp-alert-success`, `.fp-live-pill`, and positive metric variants.

- [ ] **Step 5: Run the global token source check**

Run:

```powershell
rg -n -- "--primary|--bg:|--surface2:|--border-focus|app-brand-mark|nav-item.active|focus-visible" frontend/src/footpredictor.css
```

Expected: the new primary tokens and migrated global selectors are present; semantic green token declarations remain present.

### Task 2: Migrate page-specific brand and selection accents

**Files:**
- Modify: `frontend/src/features/glossary/glossary.css`
- Modify: `frontend/src/pages/budget-manager.css`
- Modify: `frontend/src/components/data-manager/DataManagerPageView.tsx`
- Modify: `frontend/src/components/scrapers/ScrapersPageView.tsx`
- Modify: `frontend/src/components/backtesting/BacktestingPageView.tsx`
- Modify: `frontend/src/components/predictions/PredictionWorkbenchView.tsx`
- Modify: `frontend/src/components/predictions/ValueOpportunitiesTable.tsx`

**Interfaces:**
- Consumes: primary tokens introduced by Task 1.
- Produces: consistent blue brand and interactive styling across every main route, with unchanged semantic status styling.

- [ ] **Step 1: Convert Glossary identity and interaction styling**

In `glossary.css`, replace `--green*` with the corresponding `--primary*` token only for:

```css
.glossary-kicker
.glossary-page__count
.glossary-search:focus-within
.glossary-categories button:hover
.glossary-categories button.is-active
.glossary-alphabet a:hover
.glossary-letter
.glossary-category-label
.glossary-formula
.glossary-related a
.glossary-term:hover
.glossary-term:focus-visible
.glossary-quick-list__item > span:last-child
```

Apply the same primary blue border to the mobile `.glossary-page__count`. Do not alter `.glossary-caution` warning styling.

- [ ] **Step 2: Convert Budget brand and selection styling**

In `budget-manager.css`:

```css
.bm-user strong {
  color: var(--primary);
}

.bm-summary {
  border-left-color: var(--primary);
}

.bm-ftab.active {
  border-color: var(--primary-border);
  background: var(--primary-dim);
  color: var(--primary);
}
```

Keep `.bm-summary__item.is-positive`, `.bm-status.won`, ROI, profit, and win metrics green.

- [ ] **Step 3: Convert Data and Provider selectors to primary blue**

In `DataManagerPageView.tsx`, change `.dm-step-num` to `var(--primary)` and `.dm-scope-tab.active` to the primary dim, border, and text tokens. Keep result success, completeness, wins, and positive coverage green.

In `ScrapersPageView.tsx`, change `.sc-comp.on`, `.sc-year.on`, and `.sc-year-num` to the primary tokens. Change the page title class:

```tsx
<h1 className="fp-page-title fp-gradient-blue">Dati e Provider</h1>
```

Keep provider-health, successful synchronization, remaining quota, and completed-data states green.

- [ ] **Step 4: Convert Backtesting page identity to primary blue**

Change:

```tsx
<h1 className="fp-page-title fp-gradient-blue">Backtesting e Validazione</h1>
```

Keep positive ROI, positive profit, positive yield, and low overfitting-risk states green.

- [ ] **Step 5: Convert prediction interactions while preserving positive signals**

In `PredictionWorkbenchView.tsx`, change only interactive focus and the main recommended-pick container to primary:

```css
.pr-stake-input:focus {
  border-color: var(--primary);
}

.pr-decision-report {
  border-color: var(--primary-border);
  border-left-color: var(--primary);
}
```

Keep value-bet markers, positive EV, success alerts, best verified odds, and positive probability series green.

In `ValueOpportunitiesTable.tsx`, change the bet-placement action from `fp-btn-green` to the primary `fp-btn-solid` class:

```tsx
<button
  className="fp-btn fp-btn-solid fp-btn-sm"
  onClick={() => onBet(opportunity)}
  disabled={!budgetReady}
>
  Scommetti -&gt;
</button>
```

- [ ] **Step 6: Audit remaining green usages**

Run:

```powershell
rg -n --glob '*.css' --glob '*.tsx' --glob '*.ts' -- "var\(--green(?:-[a-z]+)?\)|fp-gradient-green|fp-btn-green" frontend/src
```

Expected: remaining green usages describe success, positive values, wins, healthy providers, favorable value metrics, or positive chart series. No navigation, focus, selected filter, page-title, or primary-action usage remains green.

### Task 3: Verify regression safety and runtime presentation

**Files:**
- Verify only: `frontend/src/**`
- Verify only: `backend/**`

**Interfaces:**
- Consumes: completed palette migration.
- Produces: evidence that the frontend is buildable, tested, and isolated from the backend.

- [ ] **Step 1: Run frontend tests**

Run:

```powershell
npm run test:ci -- --runInBand
```

Working directory: `frontend`

Expected: all frontend Jest suites pass.

- [ ] **Step 2: Run frontend lint and typecheck**

Run:

```powershell
npm run lint
npm run typecheck
```

Working directory: `frontend`

Expected: both commands exit with code `0`.

- [ ] **Step 3: Run the production build**

Run:

```powershell
npm run build
```

Working directory: `frontend`

Expected: optimized production build completes successfully.

- [ ] **Step 4: Rebuild and restart the frontend container**

Run:

```powershell
docker compose up -d --build frontend
```

Working directory: repository root.

Expected: the frontend container is rebuilt and reaches a running state.

- [ ] **Step 5: Check the main routes and backend health**

Verify HTTP responses for:

```text
http://localhost:3000/predictions
http://localhost:3000/budget
http://localhost:3000/glossary
http://localhost:3000/backtest
http://localhost:3000/data
http://localhost:3000/scrapers
http://localhost:3001/api/health
```

Expected: frontend routes return the application successfully and backend health reports healthy.

- [ ] **Step 6: Confirm frontend-only scope**

Run:

```powershell
git diff -- backend
git status --short
```

Expected: `git diff -- backend` has no output. Report all existing frontend changes without claiming unrelated dirty files were created by this palette task.
