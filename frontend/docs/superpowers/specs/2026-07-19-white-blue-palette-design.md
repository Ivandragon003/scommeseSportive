# White and Blue Frontend Palette

Date: 2026-07-19

## Goal

Restore a white and light-blue visual identity across the existing frontend without changing layout, content hierarchy, application behavior, API contracts, or backend code.

The interface must remain clear, professional, desktop-first, and free from decorative gradients, glow effects, casino styling, or unnecessary visual noise.

## Approved Direction

Use blue as the brand and interaction color:

- logo and product identity;
- active navigation items;
- primary buttons and links;
- selected tabs and controls;
- keyboard focus indicators;
- informative highlights and contextual accents.

Keep green exclusively as a semantic color for successful states and positive values. Keep red for errors and negative values, and amber for warnings.

## Color System

The implementation will introduce or consolidate semantic design tokens instead of replacing every green value globally.

Target palette:

- application background: very pale blue;
- header, sidebar, panels, tables, dialogs, and cards: white;
- primary blue: approximately `#1677C8`;
- primary hover: approximately `#0F5FA8`;
- pale blue surface: approximately `#EAF4FF`;
- blue border: approximately `#B8D7F0`;
- primary text: dark navy;
- secondary text: neutral blue-gray;
- success: existing accessible green family;
- warning: existing accessible amber family;
- error: existing accessible red family.

Exact values may be adjusted slightly during implementation to preserve WCAG contrast and consistency with the current component system.

## Token Architecture

Add dedicated primary tokens such as:

- `--primary`;
- `--primary-hover`;
- `--primary-dim`;
- `--primary-border`;
- `--primary-focus`.

Existing green tokens remain semantic success tokens. Brand and interactive selectors currently tied to green will be migrated to the primary blue tokens. This prevents successful and positive states from losing their established meaning.

Hardcoded green focus rings, brand borders, and decorative shadows will be replaced with token-based blue or neutral equivalents where they represent interaction or identity.

## Component Scope

Apply the palette consistently to:

- application shell, logo, header, sidebar, and navigation;
- Predictions, Budget, Glossary, Backtesting, Data, and Provider pages;
- primary and secondary actions;
- tabs, filters, inputs, focus rings, links, and selected states;
- tables, panels, notices, drawers, dialogs, and empty states;
- glossary indexes, entries, contextual term links, and quick-access controls.

Success, positive metric, error, negative metric, and warning components retain their semantic colors.

No component structure, routing, business logic, data flow, or user-facing functionality will change.

## Accessibility

- Primary blue controls and text must maintain sufficient contrast against white and pale-blue surfaces.
- Focus indicators must remain clearly visible without relying on color alone where an outline or border is appropriate.
- Semantic states must retain labels or icons in addition to color.
- Hover, active, disabled, and focus-visible states must remain distinguishable.

## Data Flow and Error Handling

This is a presentation-only change. It does not affect frontend hooks, requests, API payloads, persistence, prediction logic, odds handling, or backend error processing.

Existing success, warning, and error messages keep their meaning and behavior; only non-semantic brand styling changes from green to blue.

## Verification

Verify the change through:

- focused source scans for remaining brand uses of green and hardcoded legacy colors;
- frontend tests;
- frontend lint;
- TypeScript typecheck;
- production frontend build;
- Docker frontend rebuild when available;
- visual checks of the main routes and interactive states;
- explicit confirmation that `git diff -- backend` is empty.

## Out of Scope

- backend changes;
- API or data-model changes;
- layout redesign;
- typography or spacing redesign;
- new dependencies;
- new animations or decorative effects;
- changes to prediction, bankroll, odds, glossary, or provider behavior.
