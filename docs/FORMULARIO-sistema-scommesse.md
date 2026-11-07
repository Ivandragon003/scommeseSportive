# Formulario del sistema di previsione

Questo documento descrive le formule e i confini principali presenti nel codice. I valori indicati come default possono essere modificati dalla configurazione o dai parametri effettivamente caricati; non descrivono da soli lo stato di un'installazione. Per i percorsi completi vedere [modello A](models/MODEL-A.md), [modello C](models/MODEL-C.md) e [scelte scartate](FORMULARIO-scelte-scartate.md).

## Dati e percorsi

Understat è la fonte primaria dei dati calcistici. `FootballDataService` integra i campi mancanti con football-data.co.uk senza sovrascrivere valori esistenti; le quote storiche hanno provenienza distinta dalle statistiche. Le quote usate per decisioni e valutazioni economiche devono essere reali e attribuite al bookmaker effettivo: completamenti sintetici del modello non sono evidenza di value, ROI o CLV.

A operativo usa `PredictionService`, contesto, modelli statistici, calibrazione e selezione. Research A80 è una baseline cronologica separata: le sue metriche e probabilità non sono quelle di A operativo. C usa la baseline research e un artefatto CatBoost. Il percorso C906 legacy è un riferimento predefinito del codice, non una conferma della versione effettivamente attiva nel registro: questa richiede una lettura dell'installazione. Il selettore legacy C riusa il motore value e il selettore canonico; il selettore `payout-aware-v1` è un percorso distinto, usato operativamente solo quando l'adozione lo specifica.

Sorgenti: `backend/src/services/FootballDataService.ts`, `backend/src/services/PredictionService.ts`, `backend/src/research/ForecastCore.ts`, `backend/src/research/ResearchRuntime.ts`, `backend/src/research/ResearchRecommendationRuntime.ts`, `backend/src/research/ChallengerRecommendation.ts`.

## Gol: Dixon–Coles e ensemble

Nel fit di Dixon–Coles, se gli xG sono validi, il bersaglio della componente Poisson combina gol e xG:

```text
pseudo_gol = (1 - peso_xg) * gol + peso_xg * xG
```

Il default `xgWeight` è 0,80; la dipendenza per i risultati bassi resta stimata sui gol interi. Questo peso riguarda il **fit**, non l'ensemble successivo. Le intensità strutturali usano attacco, difesa avversaria e vantaggio casa. Se entrambi gli xG di contesto sono positivi, il calcolo delle intensità li combina con le intensità strutturali con pesi rispettivamente 0,4 e 0,6; applica poi l'eventuale `levelCorrection` e i limiti numerici.

Per il punteggio casa `h` e ospite `a`, la matrice usa il prodotto delle probabilità Poisson e la correzione Dixon–Coles, quindi normalizza sul supporto finito:

```text
M[h,a] ∝ Poisson(h; λ_home) * Poisson(a; λ_away) * τ(h,a)
τ(0,0) = 1 - λ_home * λ_away * ρ
τ(1,0) = 1 + λ_away * ρ
τ(0,1) = 1 + λ_home * ρ
τ(1,1) = 1 - ρ;  τ = 1 negli altri casi
```

Il contesto può modificare le intensità prima della matrice usata per le probabilità complete. Se disponibile e abilitato, il modello Poisson-xG indipendente viene combinato con Dixon–Coles **prima della calibrazione** per le famiglie goal:

```text
p_ensemble = (1 - w_famiglia) * p_DC + w_famiglia * p_PoissonXg
```

Il default configurato è 0,5 per 1X2, over/under e BTTS. In assenza dei parametri Poisson-xG il blend è un no-op. L'ensemble fra modelli è distinto dal successivo blend con le quote.

Research A80 usa anch'essa il blend delle probabilità per famiglia. Per C costruisce inoltre una matrice proxy con il peso di ensemble `default`; se i pesi delle famiglie differiscono, la matrice non coincide necessariamente con ogni probabilità piatta della baseline. `fitBaseline` chiama `fitModel`, che stima anche `levelCorrection`; nella ricostruzione della matrice si imposta la correzione a `undefined` perché le intensità `full.lambdaHome/ Away` la incorporano già, evitando di applicarla due volte.

Sorgenti: `backend/src/models/core/DixonColesModel.ts`, `backend/src/models/core/PoissonXgModel.ts`, `backend/src/services/ProbabilityEnsembleService.ts`, `backend/src/config/PredictionEngineConfig.ts`, `backend/src/research/ForecastCore.ts`.

## Statistiche squadra e giocatori

I modelli specializzati stimano distribuzioni per tiri, cartellini, corner e falli. Per conteggi sovradispersi è usata anche la binomiale negativa, con media μ e parametro di dispersione r:

```text
Var[X] = μ + μ² / r
```

La selezione e la stima della dispersione dipendono dai dati e dalla configurazione. Per i cartellini totali confrontabili con `alternate_totals_cards`, modello e settlement usano **booking points**: `gialli + 2 * rossi`. Understat rappresenta ogni espulsione come 0 gialli e 1 rosso. Corner e falli restano esclusi dalle giocate dal blocco `DISABLED_CATEGORIES` e dai filtri pertinenti, anche se sono calcolate statistiche interne.

I mercati statistici squadra richiedono per default almeno 8 osservazioni per squadra e 20 complessive. Per le player props servono dati giocatore abilitati, quota valida per giocatore, mercato e linea, associazione non ambigua, almeno 5 partite e 45 minuti attesi. Panchina confermata, indisponibilità e formazione incerta sono esclusi; un campione sotto 8, minuti sotto 65, titolarità non confermata o quota complementare mancante producono avvisi e incidono sulla confidenza. Altri controlli e filtri possono impedire la selezione.

Per marcatore anytime, con xG/90 positivo:

```text
λ = xG_per90 * clamp(minuti_attesi / 90, 0, 1,1) * xgShrink
P(almeno un gol) = 1 - exp(-λ)
```

`xgShrink` è 0,88 di default. Le stime tiri giocatore usano la distribuzione implementata in `SpecializedModels`, quelle gialli `PlayerCardsModel`; consultare il codice per dettagli, fallback e linee superiori.

Sorgenti: `backend/src/models/markets/SpecializedModels.ts`, `backend/src/models/markets/PlayerCardsModel.ts`, `backend/src/utils/dataHelpers.ts`, `backend/src/models/backtesting/BacktestingEngine.ts`, `backend/src/services/PredictionService.ts`, `backend/src/services/playerProps.ts`, `backend/src/config/predictionConfig.ts`, `backend/src/models/value/ValueBettingEngine.ts`.

## Research C: feature e matrice

Lo schema base `prematch-numeric-v1` contiene 40 feature: 16 per ciascuna squadra (Elo, campione, gol, xG e copertura, tiri, punti e differenza reti recenti, statistiche in casa/trasferta, riposo e gol stagionali), differenza Elo, due intensità A e cinque indicatori di lega. Forma recente e riposo sono già presenti nello schema base. Quote e dati giocatore non sono feature CatBoost. I blocchi aggiuntivi versionati sono distinti dallo schema base e disponibili secondo l'artefatto.

Lo storico è filtrato alla data della previsione, con ritardo prudenziale di disponibilità, esclusione del target e dei duplicati; il ritardo è un proxy, non prova dell'istante di pubblicazione. Il fit della baseline richiede almeno 30 partite ammissibili della competizione.

L'artefatto può correggere le intensità, stimarle direttamente, correggere 1X2 o usare il controllo senza ML. Per `intensity_correction`:

```text
λ_C = clamp(exp(log(λ_baseline) + output_albero), 0,05, 8)
M_mix = (1 - weight) * M_baseline + weight * M_ML
M_raw = normalize(max(1e-15, M_mix) ^ (1 / temperature))
```

`weight`, `temperature` e tipo dipendono dall'artefatto. La temperatura dell'artefatto è distinta da quella eventuale della calibrazione successiva.

Sorgenti: `backend/src/research/ForecastCore.ts`, `backend/src/research/ChallengerFeatures.ts`, `backend/src/research/CatBoostModel.ts`.

## Calibrazione, quote e decisione

A operativo calibra per famiglia con curve isotoniche ricavate da replay cronologici e fallback globale; il minimo predefinito per una curva di famiglia è 120. Un campione di calibrazione ignoto o sotto `PREDICTION_MIN_CALIBRATION_SAMPLE` (default 30) abbassa la confidenza a LOW, senza imporre automaticamente `NO_BET`.

Il protocollo research `joint-goal-coherent-v2` applica alla matrice C una modalità compatibile (`identity`, `isotonic_1x2` o `temperature`), poi può combinare 1X2 con una terna valida dello stesso bookmaker e snapshot e riproiettare la matrice. Le probabilità dei mercati goal derivano dalla stessa matrice finale. Versione, profilo, hash e disponibilità temporale devono essere compatibili; senza tali requisiti non si può assumere una previsione disponibile. La calibrazione A per famiglia non garantisce questa coerenza congiunta.

Nel value engine, per un gruppo completo di quote compatibili, la probabilità senza margine e il confronto assumono la forma:

```text
p_no_vig = (1 / quota) / somma(1 / quote_del_gruppo)
p_decisione = peso_modello * p_calibrata + (1 - peso_modello) * p_no_vig
EV = p_decisione * quota - 1
```

La disponibilità di quote complementari, categoria, qualità dei dati, soglie effettive, rischio e calibrazione influenzano la decisione. Il peso può essere appreso entro i limiti configurati. Il percorso legacy C riceve probabilità già elaborate dalla pipeline research, evitando una seconda calibrazione o un secondo market blend nel motore value. Soglie o probabilità non garantiscono redditività.

Sorgenti: `backend/src/models/value/EnhancedMarketAnalysis.ts`, `backend/src/models/value/ValueBettingEngine.ts`, `backend/src/services/MarketBlendLearningService.ts`, `backend/src/research/ResearchProbabilityPipeline.ts`, `backend/src/research/ResearchRuntime.ts`, `backend/src/research/ChallengerRecommendation.ts`.

## Importi dell'esecuzione automatica

La policy `funded-confidence-v1` usa i saldi in euro dei portafogli A/C esistenti e separati. Per ciascuna famiglia legge il saldo disponibile `B` in centesimi all'inizio del gruppo registrato nella transazione:

```text
percentuale(LOW) = 1; percentuale(MEDIUM) = 3; percentuale(HIGH) = 5
stake_centesimi = floor(B * percentuale(confidenza) / 100)
```

Tutte le selezioni del gruppo usano la stessa base `B`. Il residuo deve coprire lo stake intero; altrimenti la selezione resta non finanziata, senza ridimensionamento proporzionale. La priorità è confidenza HIGH/MEDIUM/LOW, EV decrescente e chiave crescente. Confidenza mancante/non valida, SPECULATIVE e importi nulli non finanziano una giocata. Non c'è un tetto cumulativo del 5%, top N o limite di una giocata per partita. Restano i controlli di mercato, quota reale fresca, kickoff e duplicati.

Questo calcolo è distinto dalla percentuale Kelly interna del modello e non modifica probabilità o qualificazione delle opportunità. I dettagli contabili e la conservazione dello storico sono nella [guida operativa](operations/README.md). Sorgenti: `backend/src/research/ConfidenceStake.ts`, `backend/src/research/ResearchRecommendationPolicy.ts`, `backend/src/research/ResearchRecommendationStore.ts`.
