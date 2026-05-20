# Code Cleanup & Optimization Report

Data: 2026-05-20

Branch: `main`

Obiettivo: cleanup conservativo del repository, rimozione solo di elementi con evidenza, riduzione di duplicazioni locali e micro-ottimizzazione senza cambiare prediction, value betting, Eurobet, walk-forward/backtesting, CLV, budget, sync o provider quote.

## File Analizzati

- `backend/src`
- `backend/test`
- `frontend/src`
- `docs`
- `.github`
- `package.json` root, backend e frontend
- `tsconfig` backend/frontend
- configurazioni ESLint
- `.gitignore` e `.gitleaks.toml`

## File Modificati

- `.gitignore`
- `backend/src/services/odds-provider/oddsProviderUtils.ts`
- `docs/refactor/code-cleanup-optimization-report.md`

## File Eliminati

- `.playwright-mcp/console-2026-05-19T15-43-05-897Z.log`

Nota: il file era un log runtime locale non tracciato da Git. Nessun file sorgente tracciato e stato eliminato.

## Codice Morto Rimosso

- Nessun codice applicativo tracciato rimosso.
- `madge --orphans` segnala `backend/src/models/markets/CardsModel.ts`, `backend/src/models/markets/ShotsModel.ts` e `backend/src/services/AdaptiveTuningService.ts` come orfani nel grafo runtime, ma sono coperti da test o appartengono ad aree algoritmiche delicate. Sono stati lasciati intenzionalmente.
- I test frontend risultano orfani per definizione nel grafo runtime e non sono candidati alla rimozione.

## Duplicazioni Eliminate

- In `matchFixturesToMatches` lo score dei candidati fixture veniva calcolato una volta per la diagnostica e una seconda volta tramite `findBestMatchIndex`.
- La funzione ora calcola gli score una sola volta, conserva l'indice originale, ordina gli stessi candidati e riusa il miglior candidato per matching e diagnostica.
- Il comportamento funzionale atteso resta invariato: stesso threshold, stessi candidati diagnostici, stessa rimozione del match gia assegnato dalla pool.

## Ottimizzazioni Computazionali

- `backend/src/services/odds-provider/oddsProviderUtils.ts`
  - Prima: per ogni fixture, scoring completo dei match disponibili due volte, con complessita pratica circa `2 * O(n) + O(n log n)`.
  - Dopo: scoring completo una sola volta, poi sort e selezione, con complessita pratica `O(n) + O(n log n)`.
  - Beneficio: meno fuzzy/team/time scoring ripetuto nel matching fixture provider, senza cambiare formule o soglie.

## Dipendenze Controllate

- `npx depcheck --json` root: nessuna dipendenza inutilizzata o missing.
- `npx depcheck backend --json`: nessuna dipendenza inutilizzata; falso positivo `cheerio` generato da `backend/dist` locale non tracciato.
- `npx depcheck frontend --json`: segnala `@types/jest` come devDependency non usata e `eslint-config-react-app` missing.

## Dipendenze Rimosse

- Nessuna.

## Dipendenze Lasciate Intenzionalmente

- `@types/jest`: lasciata perche i test CRA/Jest usano globali test/expect e rimuoverla sarebbe un rischio non necessario.
- `eslint-config-react-app`: non aggiunta come dipendenza esplicita perche oggi arriva da `react-scripts` e il lint passa. Da rendere esplicita solo in un task dedicato se si vuole scollegare ESLint dalla dipendenza transitiva di CRA.
- `playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth`, `axios`, `express`, `@libsql/client`, `react`, `recharts`, `typescript`, ESLint e librerie test: mantenute per uso runtime/test/build.

## Codice Dubbio Lasciato Intenzionalmente

- Route Express e helper pubblici: non rimossi anche se non chiamati dal frontend.
- Scheduler, sync notturna, scraper, provider odds e `DatabaseService`: non toccati.
- `CardsModel.ts`, `ShotsModel.ts`, `AdaptiveTuningService.ts`: non rimossi perche collegati ad aree modello/test o potenzialmente riusabili da workflow algoritmici.
- Duplicazioni di `clamp` locali nei modelli: lasciate per evitare accoppiamenti artificiali tra moduli statistici delicati.
- Duplicazioni di normalizzazione team tra route e provider: annotate, ma non consolidate in questo task per evitare cambi di diagnostica/API.

## Controlli Sicurezza / Env

- `.env`, `.env.production` e `.env.example` risultano tracciati da Git.
- `.gitignore` ora ignora `.env`, `.env.*`, mantiene esplicitamente `!.env.example` e ignora `.playwright-mcp/`.
- Non sono stati letti o stampati valori reali degli env.
- `gitleaks git . --log-opts="--all" --config .gitleaks.toml --redact` ha trovato 4 finding nella history:
  - `jwt` in `.env.production`, commit `d4c66217f8e0020bfec8d6e4b00bb5a3375c0ea4`
  - `jwt` in `.env`, commit `d4c66217f8e0020bfec8d6e4b00bb5a3375c0ea4`
  - `generic-api-key` in `backend/src/models/value/ValueBettingEngine.ts`, commit `1d6d78df8de55755293d39d5772ba555fcc6cfa8`
  - `generic-api-key` in `backend/src/models/value/ValueBettingEngine.ts`, commit `1d6d78df8de55755293d39d5772ba555fcc6cfa8`
- I finding su `ValueBettingEngine.ts` corrispondono a pattern regex di codice sorgente e sembrano falsi positivi, ma non sono stati allowlistati.
- I finding sugli env richiedono bonifica manuale della history e rotazione credenziali se quei valori sono mai stati reali.

## Comandi Eseguiti

- `git status --short`
- `git ls-files`
- `rg` mirati su dashboard, backtest, provider, normalizzazione, date/time e sorgenti legacy
- `npx depcheck --json`
- `npx depcheck backend --json`
- `npx depcheck frontend --json`
- `npx madge --extensions ts --ts-config backend/tsconfig.json --circular backend/src/index.ts`
- `npx madge --extensions ts,tsx --ts-config frontend/tsconfig.json --circular frontend/src/index.tsx`
- `npx madge --extensions ts --ts-config backend/tsconfig.json --orphans backend/src`
- `npx madge --extensions ts,tsx --ts-config frontend/tsconfig.json --orphans frontend/src`
- `gitleaks git . --log-opts="--all" --config .gitleaks.toml --redact`
- `npm run typecheck` in `backend`
- `npm run lint` in `backend`
- `npm test` in `backend`
- `npm run typecheck` in `frontend`
- `npm run lint` in `frontend`
- `npm run test:ci` in `frontend`
- `npm run build` in `frontend`
- `git diff --check`
- `coderabbit --version`

## Test Passati

- `backend npm run typecheck`: passato
- `backend npm run lint`: passato
- `backend npm test`: passato, 122 test
- `frontend npm run typecheck`: passato
- `frontend npm run lint`: passato
- `frontend npm run test:ci`: passato, 38 test
- `frontend npm run build`: passato
- `git diff --check`: passato; solo warning di normalizzazione LF/CRLF su file toccati

## Test Da Eseguire / In Corso

- Nessuno.

## Test Falliti

- Primo `backend npm run typecheck` fallito durante la patch per un confronto numerico su oggetto invece che su `score.score`.
- Corretto immediatamente e rilanciato con esito positivo.
- `gitleaks` non passa per finding storici gia indicati nella sezione sicurezza/env.
- `coderabbit --version` non passa perche la CLI `coderabbit` non e installata/disponibile nel PATH locale.

## Rischi Residui

- Gli env sono ancora tracciati nello storico Git. `.gitignore` impedisce nuovi rientri accidentali, ma non rimuove file gia tracciati ne bonifica la history.
- `gitleaks` continua a fallire finche non viene fatta una bonifica history o una allowlist motivata per i soli falsi positivi.
- Alcuni file algoritmo appaiono orfani nel grafo runtime ma sono coperti da test o documentazione. Rimuoverli richiede un task dedicato con regressioni numeriche.

## TODO Consigliati

1. Ruotare eventuali credenziali che siano state realmente presenti in `.env` o `.env.production`.
2. Preparare una bonifica history con `git-filter-repo` o BFG, senza force push automatico.
3. Valutare una allowlist gitleaks mirata solo per i falsi positivi regex in `ValueBettingEngine.ts`, lasciando fuori segreti reali.
4. Decidere esplicitamente se `CardsModel.ts`, `ShotsModel.ts` e `AdaptiveTuningService.ts` devono restare come moduli testati o essere consolidati.
5. Se si vuole un audit piu aggressivo, configurare `knip.json` con entrypoint, test e script per ridurre falsi positivi.
