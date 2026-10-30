# Modello C: probabilità, selezione e puntata

Questa guida descrive il percorso C presente nei sorgenti al 30 ottobre 2026.
Il suo scopo è distinguere il modello che stima i gol, il codice che sceglie
una giocata e l'automazione che la registra. Non attesta la disponibilità del
provider, lo stato del database remoto o la redditività del modello.

## 1. C rispetto ad A

A operativo usa `PredictionService`, con i suoi modelli, mercati squadra,
calibrazione, filtri e stake. C usa una baseline research e un artefatto
ibrido CatBoost per produrre probabilità proprie sui gol. **La baseline
research A80 non è il motore A operativo della pagina Partite.**

I due percorsi riusano componenti decisionali: `ValueBettingEngine` e
`pickCanonicalBetRecommendation`. C non usa le probabilità prodotte in quel
momento da `PredictionService`, ma non possiede un selettore completamente
indipendente da quello di A. Il riuso comprende calcoli EV, filtri, rischio e
confidenza; il picker ordina poi le opportunità ammissibili. Non si limita
alla presentazione grafica.

La Nightly coordina i due percorsi e registra i rispettivi consigli nei
portafogli A e C. Non confronta i consigli in una classifica comune e non
trasferisce a C i mercati aggiuntivi di A.

Fonti: [runtime dei consigli](../../backend/src/research/ResearchRecommendationRuntime.ts),
[adattatore C](../../backend/src/research/ChallengerRecommendation.ts),
[selettore canonico](../../backend/src/services/CanonicalBetRecommendation.ts).

## 2. Input e baseline research

`ForecastCore` costruisce gli input usando solo partite concluse i cui
risultati sono ammissibili prima del timestamp della previsione. Esclude la
partita bersaglio e i duplicati. Per la disponibilità dei risultati applica
anche il ritardo prudenziale previsto dal progetto.

La baseline ricostruisce Dixon-Coles e Poisson-xG per la competizione;
richiede almeno 30 partite precedenti. Il suo manifest identifica codice,
configurazione, protocollo temporale e schema delle feature. La matrice
congiunta della baseline è un'approssimazione coerente dei risultati:
non va identificata con ogni probabilità piatta dell'A operativo.

Le feature numeriche comprendono, per entrambe le squadre: Elo, dimensione
del campione, gol fatti/subiti, xG fatti/subiti e relativa copertura, tiri
fatti/subiti, punti e differenza reti recenti, rendimento nella sede della
partita, riposo e statistiche della stagione. Si aggiungono differenza Elo,
intensità gol della baseline e indicatori delle cinque leghe.

Quote bookmaker e dati giocatore non sono feature di questo modello. Le
quote possono intervenire successivamente nel post-processing e nella scelta
della giocata: questo è distinto dall'usarle come input CatBoost.

Fonte: [ForecastCore](../../backend/src/research/ForecastCore.ts), in particolare
`FEATURE_NAMES`, `BASELINE_DETAILS` e `buildForecastInput`.

## 3. Artefatto CatBoost e matrice dei gol

L'inferenza legge alberi numerici esportati in JSON e li valuta in TypeScript.
Non richiede Python né un microservizio durante la previsione. Prima verifica
schema e ordine delle feature, dimensioni dei modelli, date di addestramento e
validazione e compatibilità della baseline.

Il caricatore supporta tre tipi di artefatto. Il tipo effettivo e i parametri
`weight` e `temperature` appartengono all'artefatto registrato, non si ricavano
dal solo nome della versione.

| Tipo | Come produce la componente ML |
| --- | --- |
| `intensity_correction` | Due modelli correggono il logaritmo delle intensità gol della baseline, uno per squadra. |
| `calibrated_ensemble` | Due modelli stimano direttamente le intensità gol, uno per squadra. |
| `probability_correction` | Un modello corregge i tre logaritmi delle probabilità 1X2 e ripartisce la massa sulla matrice della baseline. |

Per la correzione delle intensità, indicando con `r` l'uscita dell'albero:

```text
lambda_C_home = clamp(exp(log(lambda_baseline_home) + r_home), 0.05, 8)
lambda_C_away = clamp(exp(log(lambda_baseline_away) + r_away), 0.05, 8)
```

Le due intensità generano una matrice Poisson indipendente, normalizzata sul
supporto della baseline. Nel tipo `calibrated_ensemble` manca il termine
`log(lambda_baseline)` nelle due formule. Per `probability_correction` si usa
invece la correzione 1X2 descritta nella tabella.

In tutti i casi il caricatore combina le matrici e applica la temperatura
dell'artefatto:

```text
M_mix = (1 - weight) * M_baseline + weight * M_ML
M_raw[h,a] = normalize(max(1e-15, M_mix[h,a]) ** (1 / temperature))
```

Questo primo parametro `temperature` è distinto dall'eventuale temperatura
del successivo protocollo di calibrazione. Non attribuire valori numerici a
questi parametri senza leggere l'artefatto pertinente.

Fonte: [CatBoostModel](../../backend/src/research/CatBoostModel.ts),
`validateArtifact`, `predictCatBoostJson` e `predictHybrid`.

## 4. Calibrazione e blending effettivamente applicati

`ResearchRuntime` passa la matrice C al protocollo `joint-goal-coherent-v2`.
Il runtime legge la configurazione compatibile dal benchmark registrato, se
presente con quel protocollo; altrimenti usa l'artefatto. Verifica hash della
pipeline, baseline e disponibilità temporale della configurazione.

Il protocollo ammette tre modalità:

| Modalità | Operazione |
| --- | --- |
| `identity` | Conserva la matrice normalizzata senza una correzione di calibrazione. |
| `isotonic_1x2` | Corregge la partizione 1X2, la normalizza e riproietta la matrice, conservando la distribuzione dei punteggi condizionata a ciascun esito. |
| `temperature` | Applica la temperatura del post-processing alla matrice e la normalizza. |

La modalità di default richiesta dal runtime è `isotonic_1x2`; senza il
profilo compatibile C non è tecnicamente disponibile. Questo non significa
che ogni versione registrata usi sempre quella modalità: va letto il suo
descrittore.

La pipeline può inoltre fare **market blending**: se trova una terna 1X2
completa e valida dello stesso bookmaker e snapshot, combina le probabilità
calibrate con quelle bookmaker senza margine e riproietta la matrice.
`ResearchRuntime` non passa `enableMarketBlending: false` a questo stadio;
quindi, con una terna valida, il blending è previsto dal percorso corrente.
In assenza di una terna idonea conserva la matrice calibrata.

Da quella stessa matrice finale deriva tutte le probabilità dei mercati
gol. Conserva gli stadi `raw`, `calibrated` e `decision`. Il descrittore di
configurazione identifica famiglia, baseline, protocollo, hash della
pipeline, modalità, temperatura del post-processing e hash del calibratore.

In termini matematici, indicando con `r` uno dei tre esiti 1X2 e con `T_r`
la sua probabilità obiettivo normalizzata, la riproiezione usa:

```text
M_finale[h,a] = M_precedente[h,a] * T_r / P_precedente(r)
P(1) = somma delle celle M_finale[h,a] con h > a
P(X) = somma delle celle M_finale[h,a] con h = a
P(2) = somma delle celle M_finale[h,a] con h < a
P(over linea) = somma delle celle con h + a > linea
```

`T_r` può provenire dalla calibrazione o dal successivo confronto con la
terna bookmaker. La trasformazione conserva, dentro ciascun esito, le
proporzioni tra i punteggi. Le linee con rimborso o mezzo esito richiedono
anche la distribuzione dei rendimenti, non soltanto una probabilità over.

**Non c'è una seconda calibrazione o un secondo blending nell'adattatore di
selezione C.** I flag `marketCalibration: false` e `marketBlending: false`
della policy descrivono quel passaggio finale, non l'assenza di queste
operazioni nell'intera pipeline C.

Fonti: [ResearchRuntime](../../backend/src/research/ResearchRuntime.ts),
[CoherentProbabilityPipeline](../../backend/src/research/CoherentProbabilityPipeline.ts),
[ProbabilityConfiguration](../../backend/src/research/ProbabilityConfiguration.ts),
[policy](../../backend/src/research/ResearchRecommendationPolicy.ts).

## 5. Versione e mercati

La policy di esecuzione corrente fissa C a `C-906371b0b3a1e2c8` e la sua
baseline research a `A-80cb25df5552621e`. Nuove candidate settimanali o una
promozione del champion non sostituiscono automaticamente questa versione
nel percorso dei consigli. Un artefatto mancante o incompatibile produce
astensione C; non autorizza una sostituzione silenziosa con APP-A.

Il calcolo della matrice può descrivere più mercati di quelli eseguibili.
La raccolta quote corrente di C richiede solo `h2h`, `totals` e `spreads`:

| Quote ricevute | Mercato C |
| --- | --- |
| `h2h` | 1X2 |
| `totals` | Over/under gol |
| `spreads` | Handicap asiatico |

Occorre anche uno stato di mercato ammesso per quella versione nel registry
(`EXPERIMENTAL`, `SHADOW` o `ACTIVE` nel percorso virtuale). Calcolare una
probabilità di BTTS, DNB o doppia chance non basta a rendere disponibile una
giocata: nel feed C corrente manca la corrispondente quota reale.

Fonti: [policy](../../backend/src/research/ResearchRecommendationPolicy.ts),
`sharedOdds` e `researchQuotesFromEvent` in
[ResearchRuntime](../../backend/src/research/ResearchRuntime.ts).

## 6. Dal forecast al consiglio C

`ChallengerRecommendation` verifica identità e coerenza della matrice finale,
poi esamina le quote consentite. Richiede prezzi reali prepartita, timestamp
validi e freschezza entro cinque minuti. Per la rimozione del margine
richiede gli esiti complementari dello stesso bookmaker e foglio quote.

`quoteForecast` calcola probabilità e rendimento dalla matrice. L'adattatore
corrente ammette soltanto quote con `activeStake` uguale a uno entro tolleranza
`1e-8`: tutta la puntata deve vincere o perdere. Esclude quindi linee con
possibile rimborso o mezzo esito. È un limite del passaggio al motore
decisionale binario; il motore di liquidazione dei gol sa già rappresentare
push e mezze vincite/perdite.

Per le quote rimaste, `ValueBettingEngine.analyzeMarketsWithVigRemoval`
calcola EV, margine, rischio, confidenza e opportunità con le probabilità C
già finali, disabilitando ulteriori calibrazione e blending. Il picker
canonico esclude opportunità speculative o sintetiche, preferisce
HIGH/MEDIUM a LOW e usa le condizioni operative previste per LOW. Ordina le
candidate e restituisce il consiglio principale oppure `NO_BET`.

Per una selezione binaria ammessa, con probabilità finale `p`, il valore
atteso per unità puntata è `EV = p * quota - 1`. La probabilità del bookmaker
senza margine è `(1 / quota) / somma(1 / quote_del_gruppo)`. Un EV positivo
non basta: restano i filtri per rischio, soglie di categoria, quota e
confidenza. Il ranking finale è quello descritto nella [guida A](MODEL-A.md),
applicato esclusivamente alle opportunità C.

Fonti: [ChallengerRecommendation](../../backend/src/research/ChallengerRecommendation.ts),
[quoteForecast](../../backend/src/research/ResearchEvaluation.ts),
[ValueBettingEngine](../../backend/src/models/value/ValueBettingEngine.ts),
[picker canonico](../../backend/src/services/CanonicalBetRecommendation.ts).

### Limite attuale della motivazione di astensione

Il pacchetto C conserva un conteggio `exclusions` dei rifiuti avvenuti prima
del motore value. Non contiene però un dettaglio completo di tutti i rifiuti
dei filtri value e del picker.

Se non c'è una selezione, `ResearchRecommendationRuntime` registra
`non_binary_payout_not_supported_by_canonical_engine` quando **almeno una**
quota è stata esclusa per payout non binario. Questo motivo può apparire
anche se altre quote binarie sono state valutate e poi non hanno superato i
filtri. Non dimostra che tutti i mercati C fossero non binari, né che quello
fosse l'unico ostacolo. Se tale esclusione non è presente, il motivo generico
è `challenger_no_recommendation`; gli errori tecnici hanno motivi distinti.

Per ricostruire un caso specifico vanno letti insieme matrice/configurazione,
quote, opportunità rimaste e `exclusions` del pacchetto congelato. Non si deve
reinterpretare lo storico o attribuire una causa più precisa di quella
effettivamente registrata. Questa guida documenta il limite senza cambiare
l'algoritmo.

Fonte: gestione dell'astensione C in
[ResearchRecommendationRuntime](../../backend/src/research/ResearchRecommendationRuntime.ts).

## 7. Stake, registrazione e validazione

La puntata C è fissata all'**1% del patrimonio del suo portafoglio virtuale**.
L'adattatore conserva come diagnostica `engineSuggestedStakePercent`, ma
applica `suggestedStakePercent: 1`; non usa lo stake Kelly suggerito dal motore
come importo eseguito. Lo store converte l'importo in centesimi, controlla il
capitale disponibile e l'esposizione massima del 5%. Non riduce
silenziosamente la puntata e non forza una giocata quando il motore si astiene.
È ammessa una sola puntata per partita e portafoglio.

La diagnosi research resta distinta dall'esecuzione dei consigli. I suoi
minimi di campione prudenziale e la penalità Hoeffding possono produrre
astensione diagnostica senza impedire, da soli, un consiglio virtuale
tecnicamente valido. Il percorso dei consigli richiede comunque identità,
coerenza, quote reali, freschezza e controlli contabili. Le verifiche
economiche, la validazione dei mercati e la promozione del modello rimangono
processi separati: una puntata virtuale non è una promozione e non dimostra
redditività.

Fonti: [ResearchRecommendationStore](../../backend/src/research/ResearchRecommendationStore.ts),
[ResearchRuntime](../../backend/src/research/ResearchRuntime.ts),
[ResearchLifecycle](../../backend/src/research/ResearchLifecycle.ts),
[specifica dell'esecuzione](../operations/recommendation-execution-2026-10-30.md).
