# Modello A operativo

Questa guida descrive il percorso di `PredictionService`. I valori predefiniti sono distinti da variabili d'ambiente, parametri salvati e dati effettivamente caricati. Non attesta disponibilità o prestazioni di un deploy.

## Identità e confini

A produce l'analisi dell'app, le opportunità squadra, un consiglio principale e la percentuale di puntata. Il pacchetto canonico è identificato come `APP-A-…`, con hash distinti di codice, configurazione e stato.

La baseline research `A-80cb25df5552621e` di C è un'altra identità: non rappresenta ogni configurazione, dato, calibrazione o correzione dell'A operativo. Le sue metriche non devono essere attribuite a `PredictionService`.

La Nightly consuma il consiglio A senza restringerne il catalogo a quello di C. Le procedure candidate di C non sostituiscono matematica, ranking o stake A. Questa documentazione non modifica sorgenti, parametri o previsioni operative.

Fonti: [PredictionService](../../backend/src/services/PredictionService.ts), [pacchetto canonico](../../backend/src/services/CanonicalBetRecommendation.ts), [esecuzione A/C](../../backend/src/research/ResearchRecommendationRuntime.ts).

## Dati, fit e contesto

Understat è la fonte primaria. `football-data.co.uk` integra campi mancanti senza sostituire quelli Understat già presenti. Copertura statistica e disponibilità arbitrale non sono uniformi fra campionati e stagioni.

`PredictionContextBuilder` prepara medie, copertura, forma, avversario e contesto disponibile: riposo, calendario, disciplina, arbitro e, se abilitati, dati sui giocatori. I prior per neopromosse gestiscono passaggi fra competizioni. L'assenza di un dato non equivale a un valore osservato pari a zero.

Il fit per competizione usa partite concluse e salva i parametri Dixon-Coles e Poisson-xG. La previsione li carica e li riusa; non esegue il fit completo a ogni apertura. Parametri mancanti possono condurre a valori di base; un partner Poisson incompatibile non entra nel blend. Ricevere una previsione non prova che fit o copertura siano adeguati per quella partita.

Fonti: [contesto](../../backend/src/services/PredictionContextBuilder.ts), [supplemento](../../backend/src/services/FootballDataService.ts), [neopromosse](../../backend/src/services/PromotedTeamPriorService.ts).

## Calcolo delle probabilità

Dixon-Coles stima attacco, difesa e vantaggio di casa, con pesi temporali, contributo xG e correzione dei punteggi bassi. Dalla distribuzione dei gol ricava 1X2, over/under, BTTS e handicap. Il partner Poisson-xG fornisce una seconda stima; l'ensemble combina i mercati gol compatibili prima della calibrazione.

Tiri, tiri in porta e cartellini hanno modelli statistici dedicati e controlli di campione. Non sono una semplice conversione della probabilità 1X2. Per i cartellini totali il valore confrontabile con il mercato è gialli + 2 × rossi, distinto dal numero di soli gialli.

La calibrazione usa replay cronologici e curve isotoniche, cioè correzioni monotone fra probabilità e frequenze osservate. I profili per famiglia richiedono campione sufficiente; esistono fallback e cache con controlli di compatibilità. Campione scarso o sconosciuto può ridurre la confidenza, senza implicare da solo un veto universale su tutte le giocate.

Il motore confronta probabilità calibrate e quote reali, rimuove il margine dai gruppi bookmaker completi e applica il blending con il mercato dove previsto. Questo passaggio è distinto dall'ensemble fra Dixon-Coles e Poisson-xG. Soglie, controlli di fragilità, qualità dei dati e tuning possono incidere sulla decisione. Le learning review sono interne e non dimostrano un miglioramento automatico.

Le formule complete appartengono al [formulario](../FORMULARIO-sistema-scommesse.md). Fonti del meccanismo: [Dixon-Coles](../../backend/src/models/core/DixonColesModel.ts), [Poisson-xG](../../backend/src/models/core/PoissonXgModel.ts), [ensemble](../../backend/src/services/ProbabilityEnsembleService.ts), [modelli statistici](../../backend/src/models/markets/SpecializedModels.ts), [value](../../backend/src/models/value/ValueBettingEngine.ts), [analisi calibrata](../../backend/src/models/value/EnhancedMarketAnalysis.ts), [configurazione](../../backend/src/config/PredictionEngineConfig.ts).

## Mercati e consiglio canonico

Il catalogo squadra comprende 1X2, doppia chance, draw no bet, goal/over-under, BTTS, handicap e, con dati sufficienti e quote ammesse, tiri, tiri in porta e cartellini totali. Una probabilità calcolabile non garantisce un prezzo bookmaker reale per mercato e linea richiesti.

Corner e falli restano esclusi dalle giocate. Il risultato esatto serve alle probabilità e alle analisi interne: non si richiede il mercato bookmaker `correct_score`. Le player props sono un percorso distinto, con dati abilitati, campione sufficiente e matching non ambiguo per giocatore, mercato e linea. Nei default forniti giocatori e disponibilità sono in pausa.

Il consiglio consumato dall'app e dalla Nightly è `canonicalRecommendation`. Il picker scarta player props, opportunità speculative e quote sintetiche, dà precedenza a HIGH/MEDIUM e ammette LOW solo con i requisiti positivi previsti. Può astenersi. Il suo ordinamento non coincide necessariamente con il distinto punteggio interno di `selectBestSingleMatchBet`.

Lo stake consigliato deriva dai controlli Kelly/rischio e dai limiti del motore. La Nightly usa quella percentuale e verifica poi saldo, esposizione, kickoff, quota e duplicati. Non sostituisce lo stake A con l'1% previsto per C. Nella registrazione manuale l'utente sceglie invece l'importo e il server verifica selezione, quota e controlli contabili.

Un prezzo sintetico o completato dal modello non è un prezzo bookmaker e non rende eseguibile un consiglio. Senza quota reale si può mostrare analisi sportiva, ma non presentare un vantaggio contro un prezzo che il bookmaker non ha espresso.

Fonti: [picker](../../backend/src/services/CanonicalBetRecommendation.ts), [player props](../../backend/src/services/playerProps.ts), [campioni](../../backend/src/config/predictionConfig.ts), [azioni manuali](../../backend/src/services/ManualModelBetService.ts).

## Trasporto, archivio e verifica

Il dettaglio usa un job temporaneo che invoca lo stesso servizio A. Polling, scadenza o annullamento della schermata non definiscono un altro algoritmo; interrompere il recupero non annulla necessariamente il calcolo già partito. I consigli archiviati conservano la loro identità e non vengono riscritti come nuove decisioni Nightly da una consultazione successiva.

L'analisi iniziale legge quote in cache. La scheda Giocate può avviare una richiesta dedicata di quote reali; calcolare un consiglio e acquisire prezzi non registrano automaticamente una puntata. [Architettura](../SYSTEM-DESIGN.md) e [Nightly](../github-actions-nightly-sync.md) descrivono questi flussi.

Per verificare A si controllano sorgenti, configurazione, parametri e dati della specifica esecuzione, pacchetto canonico e regressioni del servizio. Le metriche research, un test unitario o una risposta HTTP non certificano profitto o superiorità predittiva dell'A operativo.


## Ordine degli stadi e validazione Over 2,5

La Fase 4 dispone di recorder e collector indipendente, entrambi spenti per default. Il collector invoca A senza quote nella finestra T−24h/T−60min, entro scope e manifest fissati, con un solo tentativo per protocollo/partita/kickoff e conferma nel database. Gli snapshot degli input attuali restano `technical_only`, con `rigorousEligible=false` e disponibilità temporale completa non dimostrata: l'export tecnico è distinto da quello rigoroso. Refresh degli esiti e monitor sono opt-in; un monitor tecnico verde non certifica validità scientifica. Preparazione locale, raccolta attiva e validazione restano distinte: stato, prove e limiti nel [passaggio di consegne](MODEL-A-FASE-4-HANDOFF.md), metodo e contratti nel [protocollo prospettico](MODEL-A-VALIDAZIONE-PROSPETTICA.md). Nessuna attivazione o nuova variante A/C è implicita.

Nel percorso operativo A, i parametri Dixon–Coles e l’eventuale Poisson-xG sono caricati per competizione; `PredictionContextBuilder` prepara il contesto squadra. Se abilitato e richiesto, l’aggiustamento assenze modifica gli xG contestuali. `computeFullProbabilities` calcola lambda, matrice Dixon–Coles, eventuali moltiplicatori contestuali e probabilità grezze; il partner Poisson-xG contribuisce all’ensemble solo se abilitato e disponibile. Le probabilità dei mercati goal vengono miscelate prima della calibrazione. Le impostazioni predefinite nel repository abilitano ensemble, calibrazione per famiglia e apprendimento dei pesi di blending, ma la loro effettiva applicazione dipende da parametri, campioni, quote e stato disponibili nel singolo run.

Nell’analisi delle opportunità, il motore applica la calibrazione disponibile e, quando le condizioni di mercato sono soddisfatte, il blending con probabilità implicite da quote reali. L’output `probabilities.raw` rappresenta i valori sportivi grezzi dopo l’ensemble; `probabilities.decision` raccoglie le probabilità usate nelle opportunità/ranking, e non garantisce un valore decisionale per ogni mercato o partita. Non equiparare una probabilità sportiva a un prezzo bookmaker. Fonti: `PredictionService.predict`, `ValueBettingEngine.applyMarketCalibration`, `blendWithMarketProbability`, `ProbabilityEnsembleService`.

### Fase 2 — Analisi storica conclusa nei limiti dei dati disponibili

**Fase 2 — Analisi storica conclusa entro i limiti dei dati disponibili. Validazione della probabilità finale operativa ancora aperta e trasferita alla Fase 4.** La chiusura riguarda l'indagine storica effettuabile, non attesta validazione operativa o redditività.

Il replay appaiato su 6.022 partite confronta l’ensemble grezzo precedente con un’ulteriore ricostruzione che usa `BacktestingEngine.buildAsOfPredictionContext` e la scala del vantaggio casa del servizio. I risultati sono in `artifacts/model-a-context-replay/report.md`, `summary.json` e `predictions.jsonl`; strumento separato `backend/experiments/model-a-venue/context-replay.js`. Questi artefatti locali non sono automaticamente versionati. La stima contestuale usa solo i campi risultati/xG disponibili nell’esportazione: non riproduce fedelmente tutte le informazioni storiche dell’app. Contesto e scala casa cambiano insieme, quindi il confronto non isola il solo contesto.

Sulle stesse 6.022 partite il Poisson base ha Brier 0,24230 e Log Loss 0,67772, mentre l'ensemble grezzo ha 0,24065 e 0,67412. Il confronto con la curva proxy usa invece le 5.417 partite della tabella successiva: non confrontare direttamente le metriche fra le due coorti. Contesto ricostruito e calibrazione proxy non hanno mostrato un miglioramento aggregato statisticamente convincente.

| Coorte | N | Brier ensemble grezzo | Brier con contesto parziale | Log Loss grezza | Log Loss con contesto parziale |
|---|---:|---:|---:|---:|---:|
| Cinque campionati | 6.022 | 0,24065 | 0,24104 | 0,67412 | 0,67494 |

Bootstrap appaiato per campionato-settimana: IC95% della differenza Brier contesto meno grezzo [−0,00045; +0,00126], 1.000 repliche. Non dimostra una differenza complessiva affidabile. Calibrazione completa, probabilità dopo blending e probabilità decisionale non sono ricostruite: sono registrate come non disponibili, non sostituite con la stima grezza. La loro verifica prospettica appartiene alla Fase 4.

Limiti: risultati disponibili tramite proxy kickoff + 2 ore; tempi di pubblicazione e revisioni storiche degli xG non verificabili; configurazione corrente applicata retrospettivamente; mancano ricostruzione storica affidabile di giocatori, arbitro, neopromosse e eventuali cambi di parametri. Un controllo in sola lettura ha individuato 254 partite della coorte con quote Over/Under complete in snapshot reali acquisiti prima del kickoff (Serie A 79, Premier 64, La Liga 43, Bundesliga 24, Ligue 1 44; 57 nella stagione 2025/26 e 197 nella 2026/27). Il kickoff non certifica la disponibilità all’effettivo orario decisionale: la copertura non equivale a 254 decisioni ricostruibili.

Per completare la validazione occorre ricostruire le previsioni dei periodi precedenti, le curve isotone e i pesi di blending as-of, preservare gli stessi ID e usare quote realmente disponibili prima dell’orario decisionale; quindi confrontare il sottoinsieme con quote separatamente. Servono inoltre verifiche su kickoff contemporanei, neopromosse e identità dei parametri effettivamente utilizzati.

### Confini delle dipendenze research

Il percorso research usa `ForecastCore` per costruire `baselineProbabilities` e una matrice proxy con Dixon–Coles e Poisson-xG; il manifest include hash dei componenti matematici, di `PredictionContextBuilder` e dell’ensemble. `ResearchRecommendationRuntime` usa `PredictionService` per il pacchetto A; la calibrazione research riutilizza l’implementazione isotonica e le soglie condivise. Cambiare queste interfacce o funzioni può cambiare identità o input delle procedure che consumano la baseline; gli script di questo replay non sono collegati a tali percorsi e non modificano C. Fonti: `research/ForecastCore.ts`, `research/ResearchRecommendationRuntime.ts`, `research/ResearchProbabilityPipeline.ts`.

### Esperimento cronologico sulla calibrazione Over 2,5

Il nuovo esperimento separato `backend/experiments/model-a-calibration/replay.js` usa le previsioni fuori campione del replay contestuale precedente, per campionato, e le ultime 450 partite precedenti con risultato assunto disponibile due ore dopo il kickoff; richiede almeno 120 osservazioni. Applica il codice isotonico e lo shrinkage di `ValueBettingEngine.fitIsotonicCalibration` e `calibrate`. Il momento della previsione è approssimato al kickoff, non all'effettiva decisione. Confronta gli stessi casi in ogni colonna: 5.417 partite su 6.022, escluse le 605 senza curva disponibile. I campioni sono fuori campione rispetto ai fit che li hanno generati, ma la disponibilità storica degli xG non è dimostrabile.

**La curva è un'approssimazione, non la curva operativa**: include soltanto Over 2,5; il profilo operativo usa anche le altre soglie della famiglia Over (tra cui 1,5 e 3,5), un eventuale fallback globale e un replay con finestre e frequenza di refit proprie. Mancano dati di contesto e configurazioni storiche complete, l'eventuale calibrazione di mercato e la probabilità decisionale finale. Vedi `PredictionService.loadCalibrationProfile`, `ChronologicalForecastService`, `EnhancedMarketAnalysis` e `ValueBettingEngine.applyMarketCalibration`. Il contesto parziale e la scala casa cambiano insieme rispetto al grezzo.

| Coorte appaiata | N | Brier grezzo | Brier contesto | Brier curva proxy | Log Loss grezzo | Log Loss contesto | Log Loss curva proxy |
|---|---:|---:|---:|---:|---:|---:|---:|
| Cinque campionati | 5.417 | 0,24145 | 0,24213 | 0,24187 | 0,67578 | 0,67721 | 0,67664 |

Il bootstrap appaiato per campionato-settimana (1.000 repliche) stima Δ Brier proxy − contesto −0,00027, IC95% [−0,00066; +0,00016], e Δ Log Loss −0,00058, IC95% [−0,00140; +0,00033]. Entrambi includono zero: questo esperimento non dimostra un miglioramento complessivo. Intervalli, fasce per campionato e tutti i valori sono in `artifacts/model-a-calibration/report.md` e `summary.json`, con previsioni in `predictions.jsonl`; gli artefatti locali potrebbero non essere versionati. Le fasce 50–60% e 60–70% della curva proxy mostrano rispettivamente 55,0% previsto contro 51,7% osservato e 64,5% contro 61,0% nel campione: indicazioni descrittive, non una prova di calibrazione operativa difettosa.

Degli snapshot Over/Under completi pre-kickoff già individuati in 254 partite, quattro partite coincidono con decisioni research A registrate dopo l'acquisizione dello snapshot e prima del kickoff; gli snapshot erano reali, non sintetici, ma risalgono a circa sei giorni prima della decisione. Non risultano decisioni Over 2,5 tra queste: non è dimostrato che quel prezzo fosse effettivamente usato o accettabile al momento decisionale. Inoltre la probabilità del replay è stimata al kickoff, dopo l'istante decisionale. Pertanto non si esegue un confronto di blending attribuendogli informazioni non dimostrate; quattro casi non permetterebbero comunque inferenze attendibili. La verifica prospettica richiede istante della previsione, quote effettive e freschezza, profili e pesi disponibili a quell'istante; il protocollo è in [Fase 4](MODEL-A-VALIDAZIONE-PROSPETTICA.md).

La Fase 1 ha corretto gli xG mancanti; la Fase 2 storica è conclusa nei limiti disponibili; la variante di Fase 3 non è stata adottata. La Fase 4 rimane aperta: [protocollo](MODEL-A-VALIDAZIONE-PROSPETTICA.md) e [passaggio di consegne](MODEL-A-FASE-4-HANDOFF.md).
