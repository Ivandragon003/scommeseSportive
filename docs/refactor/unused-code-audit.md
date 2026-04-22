# Unused Code Audit

Data audit: 2026-04-21

Obiettivo: identificare codice morto, file inutilizzati e dipendenze inutili con evidenza verificabile, evitando rimozioni distruttive su algoritmo, scraper e backtest.

## Strumenti eseguiti

- `npx depcheck` in root: nessun problema rilevato
- `npx depcheck` in `backend`: falso positivo su `cheerio`, segnalato solo da file compilati locali in `dist/`
- `npx depcheck` in `frontend`: `@types/jest` segnato come unused, `eslint-config-react-app` segnato come missing
- `npx knip` in root: output troppo rumoroso e non affidabile senza config dedicata
- `npx madge --extensions ts --ts-config backend/tsconfig.json --orphans backend/src`
- `npx madge --extensions ts,tsx --ts-config frontend/tsconfig.json --orphans frontend/src`
- `npx madge --extensions ts --ts-config backend/tsconfig.json --circular backend/src/index.ts`
- `npx madge --extensions ts,tsx --ts-config frontend/tsconfig.json --circular frontend/src/index.tsx`
- `git grep` mirati sui file sospetti
- `npx eslint "src/**/*.{ts,tsx}" --rule "@typescript-eslint/no-unused-vars:error"` in backend e frontend solo per audit

## Sintesi esecutiva

- Nessun ciclo di dipendenza rilevato in backend o frontend.
- Nessun file di codice applicativo e non algoritmico ha evidenza sufficiente per rimozione immediata.
- Due file backend risultano orfani dal grafo dell'app:
  - `backend/src/models/CardsModel.ts`
  - `backend/src/models/ShotsModel.ts`
- Questi due file sembrano realmente non referenziati dal runtime, ma non sono stati rimossi per vincolo esplicito: sono codice algoritmo e non hanno test di regressione dedicati che garantiscano assenza di impatti indiretti.
- Unico elemento rimosso dal versionamento con evidenza piena: `backend/artifacts/eurobet-smoke-report.json`, perché output runtime e non sorgente.

## File sicuramente inutilizzati

### Rimossi dal versionamento

| File | Evidenza | Raccomandazione | Esito |
| --- | --- | --- | --- |
| `backend/artifacts/eurobet-smoke-report.json` | report generato dallo smoke test; non fa parte del sorgente; sostituito da sample documentale | `remove` | rimosso dal versionamento |

## File forse inutilizzati

### Candidati forti ma non rimossi

| File | Evidenza | Rischio | Raccomandazione |
| --- | --- | --- | --- |
| `backend/src/models/CardsModel.ts` | `madge --orphans` lo segnala orfano; `git grep "CardsModel"` trova solo README, il file stesso e tipi omonimi in `SpecializedModels.ts`, ma nessun import della classe | alto: codice algoritmo | `refactor` prima di rimuovere. Aggiungere test di regressione o snapshot sulle distribuzioni e poi eliminare o integrare |
| `backend/src/models/ShotsModel.ts` | `madge --orphans` lo segnala orfano; `git grep "ShotsModel"` trova solo README, il file stesso e tipi omonimi in `SpecializedModels.ts`, ma nessun import della classe | alto: codice algoritmo | `refactor` prima di rimuovere. Verificare se il contenuto e gia assorbito da `SpecializedModels.ts` |

### Note di contesto

- Il runtime attivo usa `DixonColesModel.ts` e `SpecializedModels.ts` per shots/cards/fouls.
- README documenta ancora `CardsModel.ts` e `ShotsModel.ts`, quindi la documentazione stessa li presenta come parte del sistema anche se oggi non entrano nel grafo dell'app.
- Per coerenza con i vincoli del task, questi file vanno trattati come debito tecnico da isolare, non come cleanup immediato.

## Dipendenze non usate

### Frontend

| Dipendenza | Evidenza | Valutazione | Raccomandazione |
| --- | --- | --- | --- |
| `@types/jest` | `depcheck` la segna unused | ambigua | `keep` per ora. I test sotto `frontend/src/**/*.test.ts` usano globali Jest (`test`, `expect`) e il progetto non ha `react-app-env.d.ts` versionato. Rimuoverla senza prima verificare la strategia type-only dei test sarebbe rischioso |

### Backend

- Nessuna dipendenza sicuramente inutilizzata emersa da `depcheck`.
- `depcheck` ha segnalato `cheerio` come missing solo per `backend/dist/services/FBrefTeamStatsScraper.js`, cioe output compilato locale non tracciato. Non e un problema del sorgente attivo.

## Dipendenze solo dev/test

Queste risultano coerenti con l'uso attuale e non sono candidate a rimozione in questo audit:

- root: `concurrently`, `dotenv-cli`
- backend: `typescript`, `ts-node-dev`, `eslint`, plugin/parser TypeScript, `@types/*`
- frontend: `@testing-library/react`, `eslint`, `@types/react`, `@types/react-dom`

## Dipendenze mancanti o da chiarire

| Dipendenza | Evidenza | Raccomandazione |
| --- | --- | --- |
| `eslint-config-react-app` | `depcheck` la segnala missing per `frontend/.eslintrc.cjs`; oggi arriva transitivamente da `react-scripts` e infatti il lint passa | `keep/refactor`. Meglio renderla esplicita solo se si vuole scollegare il lint dalla dipendenza transitiva di CRA |

## Import e variabili inutilizzate

L'analisi ESLint ad-hoc ha trovato import/variabili inutilizzati. Non sono stati modificati in questo audit per evitare un refactor rumoroso.

### Backend

- `backend/src/api/routes.ts`
  - `err`
  - `getOddsEventTimeoutMs`
  - `getOddsProviderMatchTimeoutMs`
  - `shouldRetryOddsFallbackMarkets`
  - `getCompetitionOdds`
  - `getEurobetCompetitionOdds`
  - `mergeOddsMatchMarkets`
- `backend/src/index.ts`
  - `_next`
- `backend/src/models/BacktestingEngine.ts`
  - `BetOpportunity`
- `backend/src/models/CardsModel.ts`
  - `rTotal`
- `backend/src/models/SpecializedModels.ts`
  - `rHome`
  - `rAway`
- `backend/src/services/EurobetOddsService.ts`
  - `normalizedCompetition`
- `backend/src/services/OddsApiService.ts`
  - `competition`
- `backend/src/services/SystemObservabilityService.ts`
  - `SystemRunType`
- `backend/src/services/odds-provider/OddsApiProvider.ts`
  - `OddsProviderFixture`
  - `_request`
- `backend/src/services/odds-provider/OddsProviderCoordinator.ts`
  - `matchFixturesToMatches`

### Frontend

- `frontend/src/pages/DataManager.tsx`
  - `fitLoading`
  - `recomputeLoading`
  - `recomputeResult`
  - `fitResult`
  - `setFitForm`
  - `handleFitModel`
  - `handleRecompute`
  - `selectedTeamStats`
- `frontend/src/pages/Predictions.tsx`
  - `parseOdds`

### Raccomandazione

- `refactor` mirato in task separato.
- Non mischiare questa pulizia con cambiamenti di logica prediction/odds.

## Cicli di dipendenza

Risultato:

- backend: nessun ciclo rilevato
- frontend: nessun ciclo rilevato

## File segnalati da `knip` ma non affidabili senza config

`knip` ha segnalato molti file attivi, inclusi entrypoint, route, test, pagine React e script usati da workflow o npm scripts.

Esempi di falsi positivi confermati con `git grep`:

- `backend/scripts/smoke-eurobet.ts`
  - usato da `backend/package.json` (`npm run smoke:eurobet`)
  - usato da `.github/workflows/eurobet-smoke.yml`
- `backend/scripts/run-eurobet-headed.js`
  - usato da `backend/package.json` (`npm run dev:eurobet-headed`)
- `frontend/src/utils/systemObservability.test.ts`
  - test entrypoint, non importato dal runtime per definizione
- `frontend/src/components/predictions/predictions.test.tsx`
  - test entrypoint, non importato dal runtime per definizione

Conclusione: `knip` va tenuto come segnale preliminare, non come prova sufficiente di rimozione in questo repo senza `knip.json`.

## Azioni eseguite in questo audit

- aggiornato `.gitignore` per bloccare artifact runtime
- rimosso dal versionamento `backend/artifacts/eurobet-smoke-report.json`
- aggiunto sample documentale `docs/examples/eurobet-smoke-report.example.json`
- nessun file algoritmo, scraper, backtest o test e stato cancellato

## Raccomandazione finale

### Keep

- tutti i file attivi nel grafo runtime
- tutti i test
- `backend/src/models/CardsModel.ts`
- `backend/src/models/ShotsModel.ts`
- `@types/jest` finche non viene chiarita la strategia type-only del frontend test

### Remove

- solo output runtime e artifact locali, mai il sample documentale

### Refactor

1. creare `knip.json` con entry esplicite (`backend/src/index.ts`, `frontend/src/index.tsx`, test e script)
2. aprire task dedicato per ripulire le variabili/import inutilizzati emersi da ESLint
3. aggiungere test di regressione per shots/cards legacy
4. dopo i test, decidere se `CardsModel.ts` e `ShotsModel.ts` vadano eliminati o assorbiti formalmente in `SpecializedModels.ts`
