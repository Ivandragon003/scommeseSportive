# Modello C: probabilità, selezione e puntata

Questa guida descrive i sorgenti verificati al 31 ottobre 2026. **C906 con il
selettore legacy resta il default.** Il selettore autonomo e le nuove feature
sono percorsi candidati: l'implementazione e un miglioramento offline non
autorizzano da soli un cambio del modello usato dalla Nightly.
Il suo scopo è distinguere il modello che stima i gol, il codice che sceglie
una giocata e l'automazione che la registra. Non attesta la disponibilità del
provider, lo stato del database remoto o la redditività del modello.

**Audit dei dati del 31 ottobre.** Il precedente benchmark di 1.975 target
conteneva cinque forecast post-evento e sei target con date contestate.
Il [nuovo audit](../performance/c-data-benchmark-audit-2026-10-31.md) distingue
conti corretti e calendario errato: C ricostruisce lo storico escludendo 22 ID,
con 1.969 test sugli stessi confini originali. Non certifica prima disponibilità
delle statistiche o un miglioramento indipendente.

I nuovi artefatti C richiedono `dataQualityPolicyHash` e baseline ricostruita
con lo storico filtrato. Il tag pulito indica esclusione dei casi noti,
non validità universale dei timestamp. Runtime, registrazione e adozione
verificano il contratto; C906 senza questi tag conserva il percorso legacy.
La precedente candidata `C-63f359b9e5cd3d89` non è qualificata dalla nuova
policy e non viene raccolta o adottata. I conflitti dei residui C producono
quarantene append-only, anche prima della prima label, senza modificare A,
forecast originali, puntate o ledger.

## 1. C rispetto ad A

A operativo usa `PredictionService`, con i suoi modelli, mercati squadra,
calibrazione, filtri e stake. C usa una baseline research e un artefatto
ibrido CatBoost per produrre probabilità proprie sui gol. **La baseline
research A80 non è il motore A operativo della pagina Partite.**

Il percorso **legacy C906** riusa `ValueBettingEngine` e
`pickCanonicalBetRecommendation`: comprende calcoli EV, filtri, rischio,
confidenza e ranking, non soltanto presentazione. C usa comunque probabilità
proprie, non quelle prodotte in quel momento da `PredictionService`.

Il nuovo selettore **`payout-aware-v1`** valuta direttamente la distribuzione
dei ritorni e non chiama né il motore value né il picker di A. È disponibile
per confronti controllati; nel percorso operativo si usa soltanto se una
adozione C approvata lo identifica esplicitamente. Non modifica A.

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

### Feature candidate versionate

`ChallengerFeatures` estende una copia degli input legacy senza cambiare
baseline, parametri o probabilità di A. Lo schema aggiuntivo è
`prematch-challenger-v2`, protocollo `asof-opponent-xg-calendar-v1`.

| Blocco | Informazione aggiunta per squadra |
| --- | --- |
| `recent_xg` | xG fatti/subiti delle ultime cinque partite ammissibili, versioni corrette per forza dell'avversario e copertura osservata. |
| `schedule` | Riposo osservato e numero di partite osservate negli ultimi 7 e 14 giorni. |

La forza dell'avversario per una partita storica è stimata prima di quella
partita, non usando gli eventi successivi. Sono ammessi solo risultati e
statistiche disponibili entro la previsione: si verifica il massimo fra
`kickoff + ritardo prudenziale` e `availableAt`, quando presente.

Le 745 partite finali già esposte sono escluse come target di training,
selezione e confronto; sono escluse anche dalle nuove feature aggiuntive.
Il nucleo legacy della baseline resta congelato: una partita protetta ormai
conclusa può far parte del suo normale storico as-of per una previsione
successiva. Questo non autorizza a riutilizzarla come target di ottimizzazione
o come nuova prova indipendente.

L'assenza di timestamp osservati usa il ritardo prudenziale come **proxy di
disponibilità**, non come prova dell'ora reale di pubblicazione di xG o
statistiche. Il calendario osservato non garantisce la copertura di tutte
le competizioni delle due squadre. Una media di fallback e la relativa
copertura non costituiscono una nuova osservazione.

Fonte: [ChallengerFeatures](../../backend/src/research/ChallengerFeatures.ts).

## 3. Artefatto CatBoost e matrice dei gol

L'inferenza legge alberi numerici esportati in JSON e li valuta in TypeScript.
Non richiede Python né un microservizio durante la previsione. Prima verifica
schema e ordine delle feature, dimensioni dei modelli, date di addestramento e
validazione e compatibilità della baseline.

Il caricatore supporta tre tipi ML e un controllo senza ML. Il tipo effettivo e i parametri
`weight` e `temperature` appartengono all'artefatto registrato, non si ricavano
dal solo nome della versione.

| Tipo | Come produce la componente ML |
| --- | --- |
| `intensity_correction` | Due modelli correggono il logaritmo delle intensità gol della baseline, uno per squadra. |
| `calibrated_ensemble` | Due modelli stimano direttamente le intensità gol, uno per squadra. |
| `probability_correction` | Un modello corregge i tre logaritmi delle probabilità 1X2 e ripartisce la massa sulla matrice della baseline. |
| `no_ml` | Controllo con la sola matrice della baseline, senza alberi, con peso 0 e temperatura 1. |

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
Nel default legacy il runtime legge la configurazione compatibile dal
benchmark registrato, se presente con quel protocollo; altrimenti usa
l'artefatto. Per un deployment adottato con hash della configurazione
esplicito usa invece la configurazione dell'artefatto approvato e verifica
che l'hash coincida: un benchmark successivo non la sostituisce. Controlla
anche hash della pipeline, baseline e disponibilità temporale.

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

Il fallback conserva `C-906371b0b3a1e2c8`, baseline
`A-80cb25df5552621e` e selettore `canonical-binary-v1` (chiamato
`legacy-c906` dal builder). Mantiene l'identità della policy storica v2.
Un artefatto mancante o incompatibile produce astensione C, senza sostituirlo
con APP-A.

Il registro di adozione può identificare un altro artefatto C, la baseline,
l'hash della configurazione probabilistica e il selettore da usare. La
Nightly congela questa identità per la propria esecuzione; il descrittore
di esecuzione adottato è versionato separatamente come v3. La semplice
registrazione di una candidate, una nuova versione settimanale o un cambio
del champion research non sostituiscono il deployment C.

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

## 6. Due selettori C, con adozione esplicita

Entrambi i percorsi verificano identità e coerenza della matrice finale,
mercati consentiti e quote reali prepartita aggiornate entro cinque minuti.
Non applicano una seconda calibrazione o un secondo market blending.

### Default legacy C906

`ChallengerRecommendation` conserva il comportamento precedente quando non
viene richiesta un'altra policy. Ammette quote con `activeStake` uguale a uno
entro tolleranza `1e-8`: esclude linee con possibile rimborso o mezzo esito.
Passa poi le probabilità C a `ValueBettingEngine` con calibrazione e blending
disabilitati; il picker canonico sceglie fra le opportunità ammesse. Per una
selezione binaria vale `EV = p * quota - 1`; EV positivo da solo non supera
necessariamente i filtri legacy di rischio, quota, categoria e confidenza.

Le classi LOW/MEDIUM/HIGH e `engineSuggestedStakePercent` appartengono a
questo percorso. Il builder conserva lo stake del motore come diagnostica,
ma l'esecuzione C applica comunque l'1% fisso.

La causale globale legacy `non_binary_payout_not_supported_by_canonical_engine`
può comparire se almeno una quota è stata esclusa per quel motivo e non c'è
una selezione finale. Non prova che tutte le quote fossero non binarie o che
quello fosse l'unico ostacolo. Per interpretare lo storico occorrono anche
`exclusions`, opportunità e pacchetto congelato.

### Candidato autonomo `payout-aware-v1`

[ChallengerSelection](../../backend/src/research/ChallengerSelection.ts) non
usa `ValueBettingEngine` né `pickCanonicalBetRecommendation`. Valuta la
matrice finale mediante gli stessi esiti di liquidazione dei gol:

| Esito | Moltiplicatore del ritorno lordo |
| --- | --- |
| Vittoria | `quota` |
| Perdita | `0` |
| Rimborso | `1` |
| Mezza vittoria | `(quota + 1) / 2` |
| Mezza perdita | `0.5` |

Indicando con `p_i` la probabilità di ciascun esito, `r_i` il relativo ritorno
lordo e `f = 0.01` la frazione di patrimonio puntata:

```text
EV = somma(p_i * r_i) - 1
varianza = somma(p_i * (r_i - ritorno_medio)^2)
crescita_log_attesa = somma(p_i * log(1 + f * (r_i - 1)))
```

Queste formule mantengono push, handicap asiatici e quarter lines senza
trasformarli in giocate binarie. Il selettore richiede EV e crescita
logaritmica positivi; ordina per crescita logaritmica, poi EV, rischio e
criterio deterministico di parità. Restano il catalogo C corrente e i gruppi
complementari coerenti per bookmaker, linea e timestamp. Non viene imposta
una nuova soglia ottimizzata sul campione di test.

La varianza misura il rischio dei ritorni **secondo il modello**, non
l'incertezza sui suoi parametri. Quest'ultima non viene stimata artificialmente:
`parameterUncertainty` resta `null`, `confidence` resta `null` e il pacchetto
dichiara che non applica un aggiustamento per un'incertezza non disponibile.
Conserva campioni storici e copertura xG delle squadre, date di disponibilità
e fit, quando realmente forniti da `ResearchRuntime`. I mancanti restano
`null`, non diventano zero; valori non finiti, campioni negativi, copertura
fuori da `[0,1]` o date future vengono rifiutati. Campione piccolo e probabilità
bassa non diventano automaticamente una classe di qualità inventata.

Il pacchetto candidato espone `abstentionReason`, `rejections` per quota,
`exclusions`, payout e qualità. I motivi distinguono quote mancanti, mercato
non ammesso, foglio incompleto, EV non positivo, crescita logaritmica non
positiva ed evidenza tecnica o temporale invalida. Il codice del registro
effettivo e il pacchetto salvato vanno comunque letti insieme; il nuovo
formato non riscrive le causali legacy.

L'opt-in del builder serve ai confronti controllati. In produzione il
runtime lo seleziona soltanto dall'identità C approvata nel registro di
adozione. **In assenza di evidenza sufficiente resta C906 legacy.**

Fonti: [ChallengerRecommendation](../../backend/src/research/ChallengerRecommendation.ts),
[GoalSettlement](../../backend/src/research/GoalSettlement.ts),
[ResearchRecommendationRuntime](../../backend/src/research/ResearchRecommendationRuntime.ts).

## 7. Orario della previsione e confronti controllati

Il miglioramento C deve essere valutato con gli input disponibili all'ora
della Nightly, non rinominando una previsione T−15. Il dataset locale usa
la precedente boundary programmata in `Europe/Rome` prima del kickoff
(default 03:07). La ricerca degli istanti reali gestisce anche i cambi DST,
cioè il passaggio tra ora solare e legale.

Una boundary nominale è un proxy riproducibile: non prova che un job storico
sia davvero partito in quell'istante. Dove esiste un timestamp osservato,
il confronto usa quello e ne verifica corrispondenza, ordine e posizione
prima del calcio d'inizio. Date, fit, feature e risultati successivi alla
previsione non sono ammessi come input.

Il trainer `controlled-challenger` contiene sei bracci dichiarati prima del
confronto, senza una ricerca libera di pesi o temperature:

| Braccio | Funzione nel confronto |
| --- | --- |
| `no_ml` | Controllo statistico senza ML, distinto dall'intero APP-A. |
| `development_current_replica` | Replica riaddestrata di sviluppo, non l'artefatto C906 congelato. |
| `intensity_legacy` | Correzione delle intensità con le sole feature legacy. |
| `intensity_recent_xg` | Aggiunge il solo blocco xG recente. |
| `intensity_schedule` | Aggiunge il solo blocco calendario. |
| `intensity_full` | Aggiunge entrambi i blocchi. |

Il trainer controllato usa per default tre fold cronologici e quattro
intervalli distinti per fold: **training, selection, calibration, test**. Le etichette di una
fase devono essere già disponibili prima dell'inizio della successiva. La
selezione della variante avviene sul periodo selection; calibrazione e test
non lo sostituiscono. Il report conserva schema, hash, intervalli e versioni.

`ChallengerDevelopment` confronta probabilità 1X2 su tutte le partite ammesse,
comprese le astensioni: log loss, Brier, calibrazione e confronti appaiati con
bootstrap per settimana, oltre a dettagli per lega e periodo. Distingue
sviluppo, periodo indipendente dichiarato e holdout già esposto. Una
ricostruzione offline, anche temporalmente corretta, resta una prova di
sviluppo; non è una previsione prospettica immutabile precedente al risultato.

Il confronto deve distinguere C906 realmente disponibile all'ora della
previsione da `development_current_replica` riaddestrata e da un'eventuale
`C906_reconstructed` di sviluppo. Usare gli stessi alberi congelati in una
ricostruzione non dimostra che fossero già registrati o operativi in quel
periodo. La data di disponibilità nel registro e la disponibilità della
configurazione compatibile limitano il campione del confronto operativo;
se mancano risultati ammissibili successivi, quel campione può essere zero.
Non si deve attribuire a C906 operativo l'intero campione della replica o
dei fold delle nuove candidate. I conteggi e le date dello snapshot concreto
restano nel report di esecuzione.

ROI, drawdown e simulazione delle puntate richiedono quote reali prepartita
idonee all'ora della Nightly. Senza tali prezzi il report dichiara la
mancanza, senza usare quote sintetiche o prezzi successivi. Le metriche
probabilistiche non dimostrano rendimento economico.

Fonti: [ForecastDecisionTime](../../backend/src/research/ForecastDecisionTime.ts),
[trainer](../../backend/ml/train.py),
[ChallengerDevelopment](../../backend/src/research/ChallengerDevelopment.ts),
[CLI locale](../../backend/scripts/research-challenger-development.js).
Risultati e comandi effettivamente eseguiti sono nel
[report del 31 ottobre](../performance/c-hybrid-improvements-2026-10-31.md):
questa guida non anticipa esiti o numerosità non verificati.

## 8. Adozione, futuro indipendente e rollback

[ChallengerAdoptionStore](../../backend/src/research/ChallengerAdoption.ts)
congela un dossier con artefatto candidato, incumbent di riferimento,
configurazione probabilistica, selettore e manifesto del training. Le
previsioni appaiate di candidato e riferimento vengono salvate prima dei
risultati; gli esiti sono registrati separatamente. Il processo non allena
di nuovo il candidato sui risultati raccolti e non scrive nei portafogli.

Il test è preregistrato: le prime **500** previsioni ammissibili
`FUTURE_TEST`, in ordine cronologico, diventano il campione fisso. Si aspetta
che tutti i risultati siano disponibili; il verdetto indipendente viene
registrato una sola volta. Non si ripete lo stesso test fino a ottenere un
esito favorevole né si sostituiscono le partite sfavorevoli.

Il gate richiede inoltre copertura di almeno quattro leghe, quattro mesi
di calendario distinti e quattro periodi,
confronti appaiati su log loss e Brier con intervalli di confidenza interamente
favorevoli al candidato, calibrazione non peggiore e stabilità su almeno
quattro leghe. Le 745 partite originali già esposte non valgono come nuova
evidenza. Questi requisiti sono regole del ciclo di adozione, non risultati
che il candidato avrebbe già raggiunto.

L'adozione identifica esattamente la nuova distribuzione C e il suo selettore;
non promuove APP-A e non dimostra ROI bookmaker. Una valutazione insufficiente
o negativa lascia il deployment precedente. Il rollback automatico richiede
tre fallimenti tecnici indipendenti del deployment adottato, su partite e
snapshot distinti nella finestra prevista; tre retry dello stesso evento non
bastano. Ripristina il deployment C precedente registrato, senza toccare A.

La migrazione additiva
[025_challenger_adoption.sql](../../backend/migrations/025_challenger_adoption.sql)
crea il registro append-only. `DatabaseService.runVersionedMigrations`
scopre le migrazioni nella directory: il relativo helper gestisce anche gli
statement con trigger. La presenza del file e la verifica locale non attestano
che lo schema sia stato applicato al database remoto. Se lo schema manca,
la lettura mantiene il fallback C906; le scritture di adozione richiedono la
migrazione.

Nella verifica iniziale del 31 ottobre, prima dell'audit dei dati, lo schema
025 e le dieci guardie sono verificati sul database
condiviso. La candidata `C-63f359b9e5cd3d89` è preregistrata, con zero prove
future raccolte e nessuna adozione; C906 resta attivo. Il ciclo settimanale
è abilitato e la prima raccolta Nightly resta da osservare. Il riscontro
datato e il controllo dei saldi sono nel
[report operativo](../performance/c-hybrid-improvements-2026-10-31.md).

Fonti: [ChallengerAdoption](../../backend/src/research/ChallengerAdoption.ts),
[policy di esecuzione](../../backend/src/research/ResearchRecommendationPolicy.ts),
[DatabaseService](../../backend/src/db/DatabaseService.ts).

## 9. Stake e limiti che restano

Ogni consiglio C eseguibile usa l'**1% del patrimonio del suo portafoglio
virtuale**, con esposizione massima 5% e una sola puntata per partita e
portafoglio. Lo store verifica capitale, quote, kickoff e duplicati senza
ridurre silenziosamente l'importo. Le astensioni diagnostiche e i minimi
prudenziali research restano distinti dall'autorizzazione della giocata.

La nuova architettura consente confronti controllati e futura adozione,
ma non rimuove i limiti delle prove disponibili: l'incertezza parametrica
non è stimata, la disponibilità delle fonti storiche può essere un proxy,
le quote Nightly storiche possono essere assenti e le ricostruzioni offline
non diventano test prospettici. Finché l'evidenza indipendente richiesta non
è disponibile e approvata, **C906 legacy resta il default e A conserva le sue
matematiche, output e decisioni**.

Fonti: [ResearchRecommendationStore](../../backend/src/research/ResearchRecommendationStore.ts),
[specifica dell'esecuzione](../operations/recommendation-execution-2026-10-30.md).
