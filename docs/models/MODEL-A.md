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
