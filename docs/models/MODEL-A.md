# Modello A operativo: dati, probabilità e consiglio

Questa guida descrive il codice del modello A operativo al 30 ottobre 2026.
I valori indicati sono quelli predefiniti nei sorgenti: variabili d'ambiente,
parametri salvati e dati disponibili possono cambiare una singola analisi.
Non è una verifica della configurazione o delle prestazioni del deploy.

## Identità e confini

**A è il `PredictionService` già usato dalla pagina Partite.** Produce
probabilità, opportunità, consiglio principale e percentuale di puntata.
L'identità del pacchetto è `APP-A-…`, con hash distinti di codice,
configurazione e stato del modello.

La **Research A80**, baseline interna del candidato C e dei benchmark,
è un'altra identità. `ForecastCore` ricostruisce quella baseline in modo
ripetibile dal passato ammissibile; non rappresenta ogni stato del servizio
operativo A, dei suoi dati, della calibrazione o del tuning adattivo.
Le metriche di A80 non vanno attribuite ad APP-A.

L'automazione riceve il pacchetto di A e lo registra dopo controlli tecnici
e contabili. Non riordina i suoi consigli, non ne limita i mercati a quelli
di C e non crea un terzo motore. A e C riusano utility, provider, cache e
ledger. C usa anche `ValueBettingEngine` per valutazione/filtri/confidenza
e il picker canonico con le proprie probabilità, senza una seconda
calibrazione/blend in quello stadio. Le previsioni e le classifiche dei due
percorsi restano distinte; il riuso non riguarda solo la presentazione.

Sorgenti: [PredictionService](../../backend/src/services/PredictionService.ts),
[pacchetto e picker canonico](../../backend/src/services/CanonicalBetRecommendation.ts),
[ForecastCore](../../backend/src/research/ForecastCore.ts),
[esecuzione A/C](../../backend/src/research/ResearchRecommendationRuntime.ts).
Per regole e cronologia operative vedere la
[guida dell'esecuzione](../operations/recommendation-execution-2026-10-30.md).

## Dati, addestramento e previsione

Understat è la fonte primaria di partite, squadre, giocatori, gol, xG e tiri.
`football-data.co.uk` integra le statistiche mancanti e le quote storiche
previste dal progetto, senza sostituire valori Understat già presenti.
La disponibilità effettiva dipende da competizione, stagione e campo: un
modulo implementato non prova che il dato esista per una certa partita.

`PredictionContextBuilder` prepara medie e copertura storica, forma, forza
dell'avversario e contesto disponibile: riposo, calendario, motivazione,
disciplina, arbitro, giocatori e disponibilità. Il servizio applica anche
le correzioni per squadre neopromosse e, quando richieste e supportate dai
dati, per le assenze nominali dei giocatori.

Il fit per competizione usa partite concluse, richiede almeno 20 partite e
stima separatamente Dixon-Coles e il partner Poisson-xG. Salva i loro
parametri nel database. La previsione carica i parametri e li riusa in
memoria; non rifà il fit completo per ogni partita. Se i parametri mancano,
sono possibili valori di base; se manca il partner Poisson compatibile,
il blend dell'ensemble non viene applicato. Una risposta ottenuta in queste
condizioni non dimostra un addestramento valido per quella competizione.

Sorgenti: [servizio previsioni](../../backend/src/services/PredictionService.ts),
[contesto](../../backend/src/services/PredictionContextBuilder.ts),
[fonte supplementare](../../backend/src/services/FootballDataService.ts),
[prior neopromosse](../../backend/src/services/PromotedTeamPriorService.ts).

## Probabilità dei gol

Il nucleo Dixon-Coles stima le intensità dei gol delle due squadre. In forma
essenziale, prima delle correzioni di livello e contesto:

```text
lambda_casa = exp(attacco_casa - difesa_ospite + vantaggio_casa)
lambda_ospite = exp(attacco_ospite - difesa_casa)
```

La matrice dei punteggi combina le due distribuzioni Poisson e la correzione
Dixon-Coles per i punteggi bassi. Dal totale delle celle pertinenti ricava
1X2, over/under, BTTS e handicap. Il fit usa pesi temporali e, quando ci sono
xG validi, una combinazione di gol e xG: il peso xG predefinito è 0,80.
Correzioni salvate del livello gol, xG pre-partita e contesto possono
modificare le intensità effettivamente usate.

Il partner Poisson-xG stima i gol da tassi di xG fatti e concessi, corretti
per avversario e vantaggio di casa. Prima della calibrazione, l'ensemble
combina le probabilità dei mercati gol supportati:

```text
p_ensemble = (1 - w) * p_DixonColes + w * p_PoissonXg
```

Il peso predefinito è `w = 0,5` per 1X2, over/under e BTTS. Questo passaggio
non trasforma tiri e cartellini in mercati gol e non usa il modello C.

Sorgenti: [Dixon-Coles](../../backend/src/models/core/DixonColesModel.ts),
[Poisson-xG](../../backend/src/models/core/PoissonXgModel.ts),
[ensemble](../../backend/src/services/ProbabilityEnsembleService.ts),
[configurazione](../../backend/src/config/PredictionEngineConfig.ts).

## Tiri, tiri in porta e cartellini

I modelli statistici sono distinti dal modello gol. Per tiri e tiri in porta
usano distribuzioni di conteggio con dispersione stimata e regolarizzata
verso valori di riferimento. Il percorso squadra dei tiri impiega una
binomiale negativa, che permette una varianza superiore alla media.
Le intensità dipendono da medie, sede, capacità dell'avversario di concedere
tiri e contesto. La stima dei tiri incorpora anche una componente legata
ai gol attesi; non coincide con la sola conversione gol → tiri.

I cartellini usano medie e dispersione delle squadre, campione, competitività
e fattori dell'arbitro quando disponibili. I rossi hanno una stima separata.
Il totale confrontabile con `alternate_totals_cards` è:

```text
cartellini_totali = gialli + 2 * rossi
```

Gialli e cartellini totali sono quindi unità diverse. L'assenza o la debolezza
dei dati arbitrali influisce sulla qualità della stima; non implica che un
arbitro sia noto. Non è prevista copertura uniforme dell'arbitro fuori
dalla Premier League.

I mercati statistici squadra vengono rimossi quando non si raggiungono le
soglie configurate: di default almeno 8 osservazioni per ciascuna squadra e
20 complessive. Queste soglie sono un requisito di disponibilità, non una
prova di redditività del mercato.

Sorgenti: [modelli statistici](../../backend/src/models/markets/SpecializedModels.ts),
[collegamento ai gol e al contesto](../../backend/src/models/core/DixonColesModel.ts),
[gate campione](../../backend/src/services/PredictionService.ts),
[configurazione dei campioni](../../backend/src/config/predictionConfig.ts).

## Calibrazione e confronto con le quote

La calibrazione corregge gli scostamenti sistematici tra probabilità stimate
e frequenze osservate. `PredictionService` costruisce replay storici in ordine
temporale e adatta curve isotoniche: curve monotone che non invertono
l'ordinamento delle probabilità. Usa curve per famiglia quando hanno campione
sufficiente, con fallback globale; il minimo predefinito per famiglia è 120.
I profili possono essere riusati solo se compatibili con dati e configurazione.

Un ulteriore controllo prudenziale abbassa la confidenza a LOW quando il
campione di calibrazione è ignoto, insufficiente o sotto il minimo
`PREDICTION_MIN_CALIBRATION_SAMPLE` (default 30). Non impone automaticamente
`NO_BET`: restano applicabili i criteri più restrittivi per LOW. Un EV sopra
`PREDICTION_ANOMALOUS_EV_PERCENT` (default 15%) aggiunge un avviso interno,
senza costituire da solo un veto automatico.

Il motore ricava anche la probabilità del mercato senza margine, usando gli
esiti complementari del medesimo gruppo bookmaker:

```text
p_mercato_senza_margine = (1 / quota) / somma(1 / quote_del_gruppo)
p_decisione = peso_modello * p_calibrata + (1 - peso_modello) * p_mercato
EV = p_decisione * quota - 1
```

Il peso del modello dipende da qualità dei dati, categoria e completezza
delle quote. Pesi appresi possono correggerlo entro limiti configurati:
di default servono 80 campioni e lo spostamento massimo è 0,18. Il blending
col mercato non è il precedente ensemble tra due modelli statistici.

Le soglie EV effettive non sono un unico numero: dipendono da categoria,
margine bookmaker, tuning e controlli di fragilità. Sono valutati anche
incertezza, copertura, coerenza con il mercato e quote complementari.
La calibrazione di A opera sulle famiglie di probabilità; non va descritta
come il protocollo di riproiezione congiunta dei gol usato nel percorso C.

Sorgenti: [profili e replay](../../backend/src/services/PredictionService.ts),
[analisi calibrata](../../backend/src/models/value/EnhancedMarketAnalysis.ts),
[value e blending](../../backend/src/models/value/ValueBettingEngine.ts),
[pesi appresi](../../backend/src/services/MarketBlendLearningService.ts),
[cache profili](../../backend/src/services/CalibrationProfileCache.ts).

## Consiglio principale e astensione

Il motore produce opportunità e una spiegazione della scelta migliore.
Il consiglio esposto e consumato dall'automazione è poi il pacchetto
`canonicalRecommendation`, costruito dal picker canonico della pagina.
Non bisogna confondere il suo ordinamento con il distinto punteggio interno
del metodo `selectBestSingleMatchBet`.

Il picker esclude player props, opportunità speculative e quote sintetiche.
Dà precedenza alle opportunità HIGH/MEDIUM. Una LOW è ammissibile soltanto
con quota valida, valore, edge senza margine, Kelly e stake positivi, senza
flag speculativi o esclusione dal value. A parità di fascia ordina per:

```text
score = 0,55 * EV_percentuale + 0,30 * edge_percentuale
        + 8 * probabilita_in_0_1 + 4 * livello_confidenza
livello_confidenza: HIGH=3, MEDIUM=2, LOW=1
```

Il pacchetto conserva fino a tre alternative ordinate e una sola selezione
principale. Se non rimangono candidati restituisce `NO_BET`: non impone una
giocata per ogni partita. Anche un consiglio valido può non essere registrato
se falliscono i controlli tecnici o contabili dell'esecuzione.

Sorgenti: [picker canonico](../../backend/src/services/CanonicalBetRecommendation.ts),
[composizione del pacchetto](../../backend/src/services/PredictionService.ts).

## Percentuale di puntata

A mantiene lo stake del proprio motore, distinto dall'1% fisso deciso per C.
Il punto di partenza è Kelly frazionale, con default Quarter Kelly:

```text
Kelly_intero = (p * (quota - 1) - (1 - p)) / (quota - 1)
Quarter_Kelly = max(0, Kelly_intero) * 0,25
```

Il motore applica confidenza, incertezza e limiti prudenziali; copertura,
categoria e cap di correlazione possono modificare il risultato finale.
Il limite massimo di base è il 4% e il minimo interno di base è lo 0,25%:
non sono una garanzia che ogni opportunità passi gli ulteriori controlli.
La modalità Kelly dinamica esiste ma è opt-in; il default è `quarter`.

L'esecutore usa l'esatto `suggestedStakePercent` finale rispetto al patrimonio
del portafoglio A. Non applica un secondo moltiplicatore di confidenza o un
minimo automatico di un euro. Verifica saldo, esposizione aperta massima del
5% e una sola puntata per partita e portafoglio. Se il consiglio supera i
limiti si astiene; non ne riduce silenziosamente l'importo.

Sorgenti: [Kelly, confidenza e limiti](../../backend/src/models/value/ValueBettingEngine.ts),
[cap tra opportunità](../../backend/src/models/value/EnhancedMarketAnalysis.ts),
[registrazione contabile](../../backend/src/research/ResearchRecommendationStore.ts).

## Mercati e quote operative

| Percorso | Comportamento |
| --- | --- |
| Squadra A | 1X2, doppia chance, DNB, over/under gol, BTTS, handicap europeo/asiatico; tiri, tiri in porta e cartellini quando dati, linea, quota e controlli lo consentono |
| Player props | Sezione separata: tiri, tiri in porta, gialli e marcatore anytime; non diventano la puntata automatica principale |
| Corner e falli | Restano bloccati nella selezione operativa |
| Risultato esatto | Probabilità e analisi interne; non è un mercato bookmaker operativo richiesto |

Le player props richiedono flag dati abilitato, campione sufficiente,
identificazione non ambigua e quota reale per giocatore, mercato e linea.
I tiri giocatore usano il percorso aggregato di `SpecializedModels`; i gialli
usano `PlayerCardsModel`; l'anytime usa il tasso xG e i minuti attesi.
La presenza di `ShotsModel.ts` non significa che quel modello alternativo
sia collegato al runtime. I dati giocatore sono disabilitati per default.

Per l'esecuzione di A, `AppPredictionOddsService` raccoglie feed principale e
mercati evento già configurati nell'app. Conserva bookmaker, prezzo, cattura
e aggiornamento di ciascuna quota e mantiene gli esiti complementari sullo
stesso listino. I mercati extra rispettano l'opt-in di rete separato, cache
e budget persistente. Supportare un mercato non garantisce che il provider
offra la quota per quella partita: le chiavi generiche `shots` e `cards`
non vanno inventate per superare un'assenza di copertura.

La registrazione richiede prezzi reali pre-match freschi entro cinque minuti.
Le quote sintetiche o completate dal modello non autorizzano value, giocate
o dimostrazioni di ROI/CLV. Per chiudere una puntata statistica A servono i
campi reali richiesti: i mancanti lasciano l'esito aperto, non valgono zero.

Sorgenti: [quote A](../../backend/src/services/AppPredictionOddsService.ts),
[catalogo evento](../../backend/src/services/OddsMarketPolicy.ts),
[selezione bookmaker](../../backend/src/services/BookmakerOddsSelectionService.ts),
[player props](../../backend/src/services/playerProps.ts),
[flag giocatori](../../backend/src/services/PlayerDataConfig.ts),
[liquidazione A](../../backend/src/research/AppRecommendationQuotes.ts).

## Limiti e verifica della descrizione

Questa guida documenta struttura e comportamento del codice. Non attesta
copertura corrente dei dati, calibrazione sufficiente di ogni famiglia,
disponibilità delle quote, redditività o puntate presso bookmaker reali.
L'esecuzione descritta qui registra importi virtuali. Le performance dei
report datati restano risultati dei rispettivi esperimenti.

Per una verifica ripetibile confrontare i moduli collegati e le configurazioni
con i test di [selezione canonica](../../backend/test/canonical-bet-recommendation.test.js),
[quote A](../../backend/test/app-prediction-odds-service.test.js),
[motore value](../../backend/test/value-betting-engine.test.js) e
[esecuzione separata](../../backend/test/research-recommendation-runtime.test.js).
La stesura di questa guida ha usato letture dei sorgenti; non ha eseguito
nuove chiamate provider, query al database, build o test applicativi.
