# Modello C

Questa guida descrive il meccanismo implementato e i suoi default. Il modello realmente usato dipende da registro e artefatti persistenti: non viene accertato leggendo solo il repository. Le procedure sono in [Research](../research-platform.md); esperimenti e relativi NO-GO sono nel [catalogo delle scelte scartate](../FORMULARIO-scelte-scartate.md).

## Identità e scelta del deployment

C è un ibrido fra una baseline statistica cronologica costruita con i componenti correnti di A e modelli CatBoost. La ricostruzione non replica l’intero `PredictionService`, il suo stato o la sua calibrazione: il confronto non misura tutto A operativo.

La release operativa `C-271c9573ba485956` conserva alberi, probabilità e
calibratori della candidata di proiezione `C-f6d4ac23de48fbfa`; cambia l'identità
e il metadata di attivazione, con `productionValidated: false` e
`independentEvidence: false`. La release dichiarata in [CurrentChallengerRelease](../../backend/src/research/CurrentChallengerRelease.ts) e nel relativo [artefatto](../../backend/current-models/challenger.json) è:

| Campo | Default |
|---|---|
| Modello | `C-271c9573ba485956` |
| Baseline | `A-9227e65a047783bd` |
| Selettore | `canonical-binary-v1` |

La proiezione delle foglie è la scelta operativa autorizzata dall'utente. Questa scelta non certifica superiorità predittiva e non attesta il deployment remoto: registrazione e attivazione richiedono una verifica dell'installazione. Il registro di adozione conserva artefatto, configurazione probabilistica e selettore espliciti. Nightly e anteprima risolvono questa identità; la Nightly la congela per l'esecuzione. Una nuova candidata, un champion research o il successo del training non sostituiscono da soli C.

Se il registro non è leggibile il percorso C viene sospeso; un modello mancante o incompatibile produce indisponibilità/astensione, senza usare A al suo posto. Quando manca lo schema di adozione, il solo fallback previsto è la release corrente; ciò non prova che l'artefatto sia presente o valido. Un'identità precedente nel registro non autorizza l'esecuzione del vecchio C.

La release usa il descrittore v3 anche nel fallback. Il descrittore v2 resta supportato per interpretare gli archivi. Identità e pacchetti già salvati non vengono aggiornati retroattivamente quando cambia il modello.

Fonti: [policy](../../backend/src/research/ResearchRecommendationPolicy.ts), [registro](../../backend/src/research/ChallengerAdoption.ts), [runtime](../../backend/src/research/ResearchRuntime.ts), [Nightly](../../backend/src/research/ResearchRecommendationNightly.ts).

## Come C eredita le modifiche di A

`PredictionService`, la sua calibrazione storica, `BacktestingEngine` e
`ForecastCore` chiamano gli stessi due stadi di
[`SharedForecastCalculator`](../../backend/src/services/SharedForecastCalculator.ts).
Il primo calcola Dixon-Coles; il secondo combina il partner Poisson-xG.
Nella previsione A il primo stadio precede il caricamento asincrono del partner:
gli snapshot prospettici conservano le probabilità DC prima del blend.

C riceve la matrice contestuale effettiva di Dixon-Coles, compresa la dipendenza
dei punteggi: non ricostruisce un secondo modello dalle intensità. Matrice e
probabilità Poisson derivano dalla stessa griglia nel modello Poisson-xG,
senza una seconda formula PMF nell'adattatore. Cambiamenti a questi calcoli
arrivano quindi a entrambi i chiamanti nella stessa build.

L'adattatore prepara comunque fit e contesto cronologico propri. Non richiama
l'intero `PredictionService` con il suo stato operativo. Il protocollo della
matrice congiunta usa il peso ensemble `default`, mentre le probabilità flat
possono avere pesi distinti per famiglia: non promette parità di ogni mercato
con l'intero A operativo.

Il codice condiviso si aggiorna insieme ad A, mentre i pesi CatBoost restano
appresi su uno specifico contratto di input. Cambiare le feature, le probabilità
di base o la loro calibrazione può renderli incompatibili. Il fingerprint
della baseline è conservativo e comprende anche file interi: una sua variazione
blocca il riuso silenzioso dell'artefatto. Non si risolve sostituendo l'etichetta
della versione o dichiarando il modello aggiornato.

Il riuso di pesi esistenti richiede parità numerica su tutti gli input consumati
in training e calibrazione e verifiche sui replay; se gli input cambiano, o il
dataset originale non è disponibile per provarne l'identità, serve un nuovo
addestramento riproducibile e una nuova valutazione. Il passaggio dalla vecchia
ricostruzione alla matrice diretta cambia anche arrotondamenti numerici: non è
una ragione per disabilitare i controlli di baseline. Automatizzare la preparazione di una candidata è
compatibile con questi vincoli; adottarne automaticamente i vecchi pesi su
qualunque nuova A non è una garanzia di correttezza o di miglioramento.

## Input, cronologia e qualità dei dati

`ForecastCore` prepara baseline e 40 feature numeriche: forza delle squadre, Elo, campioni, xG, forma e contesto disponibile prima del forecast. Quote bookmaker e statistiche del singolo giocatore non sono feature CatBoost di questo schema. Le quote possono intervenire nel post-processing e nella scelta.

Lo schema candidato aggiunge blocchi versionati di xG recenti corretti per avversario e calendario osservato. Training e inferenza devono concordare schema, nomi, ordine e disponibilità delle feature. Valori di fallback e indicatori di copertura non diventano osservazioni reali.

Le candidature soggette alla policy di qualità escludono gli ID in quarantena da target e storia e richiedono una baseline ricostruita e marcata pulita. Il contratto viene verificato nel training, nella registrazione e nel runtime dei modelli interessati.

Gli ID del vecchio holdout protetto restano esclusi dai target di ottimizzazione e dalla storia delle feature aggiuntive. La baseline può usare normale passato ammissibile secondo il suo protocollo: ricostruire le feature non rende nuovo e indipendente un holdout già consultato.

Il confronto allineato alla Nightly usa l'orario effettivo registrato quando presente; altrimenti dichiara la boundary nominale precedente in Europe/Rome. La disponibilità di risultati e dati deve precedere il forecast. Un ritardo conservativo dopo il kickoff è un proxy storico, non la prova dell'istante di pubblicazione o dell'assenza di revisioni del provider.

Fonti: [baseline](../../backend/src/research/ForecastCore.ts), [feature](../../backend/src/research/ChallengerFeatures.ts), [qualità](../../backend/src/research/ChallengerDataQuality.ts), [quarantena](../../backend/src/research/challenger-data-quarantine.json), [holdout](../../backend/src/research/ResearchHoldoutPolicy.ts), [orario](../../backend/src/research/ForecastDecisionTime.ts).

## CatBoost e distribuzione coerente dei gol

Gli alberi numerici sono esportati in JSON e valutati in TypeScript: durante la previsione non servono Python o un servizio ML separato. Il caricatore verifica artefatto, schema delle feature, baseline e date di disponibilità.

| Tipo supportato | Componente ML |
|---|---|
| `intensity_correction` | Correzione del logaritmo delle intensità gol della baseline |
| `calibrated_ensemble` | Stima diretta delle intensità gol con due regressori |
| `probability_correction` | Correzione 1X2 e ripartizione della massa sulla matrice della baseline |
| `no_ml` | Controllo senza alberi, con sola baseline |

Peso ML e temperatura appartengono all'artefatto, non si deducono dal nome della versione. Le matrici vengono combinate e normalizzate. Il protocollo `joint-goal-coherent-v2` applica poi la configurazione compatibile: identità, calibrazione isotonica 1X2 con riproiezione, oppure temperatura sulla matrice.

In assenza di un hash esplicito la configurazione può provenire dal benchmark compatibile registrato o dall'artefatto. Per un deployment adottato con hash esplicito si usa la configurazione approvata nell'artefatto: un benchmark successivo non la sostituisce. La modalità richiesta in assenza di un'altra dichiarazione è `isotonic_1x2`; senza il profilo compatibile C non è disponibile.

Con una terna 1X2 reale completa e valida dello stesso bookmaker/snapshot, la pipeline può applicare market blending e riproiettare la distribuzione. In assenza della terna conserva quella calibrata. Dalla stessa matrice finale derivano le probabilità dei mercati gol; gli stadi raw, calibrated e decision rimangono distinti.

Il selettore finale non applica una seconda calibrazione o un secondo blending. I flag disabilitati in quello stadio non significano che l'intera pipeline C sia priva di calibrazione o informazione bookmaker.

La calibrazione isotonica usa bin e interpola fra i centroidi dei blocchi uniti.
La rappresentazione con estremi dei plateau resta esclusa: il relativo confronto
non dimostra un beneficio stabile, come documentato nel
[catalogo](../FORMULARIO-scelte-scartate.md#varianti-c-non-adottate).

Fonti: [CatBoost](../../backend/src/research/CatBoostModel.ts), [pipeline coerente](../../backend/src/research/CoherentProbabilityPipeline.ts), [configurazione](../../backend/src/research/ProbabilityConfiguration.ts). Le formule complete restano nel [formulario](../FORMULARIO-sistema-scommesse.md).

## Mercati squadra e selettori

Per la release corrente con selettore `canonical-binary-v1`, la composizione
`c-team-markets-v1` estende i mercati squadra a 1X2, doppia chance, DNB,
BTTS, totali gol, totali squadra, handicap europeo e asiatico, tiri, tiri in
porta, gialli e cartellini totali. Questa copertura dipende dal deployment
risolto e non modifica i deployment precedenti né le decisioni salvate.

Per i mercati gol C usa la propria matrice finale coerente. Il rendimento è
calcolato sui possibili risultati, inclusi rimborso, mezza vittoria e mezza
perdita degli handicap: non si approssimano questi esiti come binari. La
valutazione usa i filtri e il picker canonico; EV positivo da solo non basta.

Per tiri, tiri in porta e cartellini la composizione usa invece le opportunità
dello specialista A, qualificate con le stesse regole operative A, compresi
campioni, calibrazione, qualità e quote. L'identità della configurazione
`c-team-probability-configuration-v1` lega l'hash della configurazione gol C
alla versione e agli hash di codice e configurazione dello specialista; la
singola opportunità conserva anche l'hash del suo stato. Questa composizione
non cambia l'artefatto, le feature o la calibrazione gol di C e non dimostra che
le statistiche siano state apprese da C.

Servono quote prepartita reali, fresche al massimo cinque minuti, e un mercato
supportato dalla release corrente nel codice. Le nuove policy identificano
questa regola con `code-supported-markets-v1`: l'operatività C corrente non
dipende da etichette qualitative nel registro. Per i mercati gol il confronto usa
una scheda completa e coerente dello stesso bookmaker e snapshot; non si
inventano quote mancanti. Restano necessari identità del modello, calibrazione,
campioni e dati adeguati: togliere le etichette non elimina questi controlli.
Per i cartellini totali il settlement usa gialli + 2 × rossi; se mancano le
osservazioni necessarie resta irrisolto. La copertura di un mercato non prova
redditività. Corner e
falli restano bloccati; correct score non entra nella selezione operativa e i
player props seguono il percorso distinto già previsto per l'app.

Il codice conserva il selettore `payout-aware-v1` per ricerca e interpretazione
delle policy archiviate. La release operativa usa `canonical-binary-v1`; le
evidenze precedenti conservano il significato del selettore con cui furono
prodotte, senza rendere eseguibili i vecchi deployment.

Fonti: [composizione](../../backend/src/research/ChallengerTeamRecommendation.ts),
[copertura](../../backend/src/research/ChallengerMarketCoverage.ts),
[selettori](../../backend/src/research/ChallengerSelection.ts),
[liquidazione](../../backend/src/research/AppRecommendationQuotes.ts).

## Esecuzione, anteprima e importo

La Nightly considera tutte le selezioni C qualificate, senza limite di una giocata per partita o top N. La policy `funded-dynamic-stake-v1` applica la percentuale dell'opportunità qualificata al patrimonio C iniziale del gruppo, disponibile più impegnato. Il saldo disponibile deve coprire gli importi completi, con priorità HIGH, MEDIUM, LOW, poi EV decrescente e chiave, senza tetto cumulativo del 5%. Una percentuale mancante o invalida non finanzia una giocata. Quote reali entro cinque minuti, kickoff, saldo, mercati liquidabili e duplicati vengono ricontrollati. Non invia puntate a bookmaker e non registra dopo il kickoff. Per i mercati statistici la percentuale proviene dallo specialista condiviso; per i mercati gol dal motore applicato alla distribuzione C.

L'anteprima su richiesta usa lo stesso deployment e selettore C con orario corrente, ma il suo servizio usa solo quote in cache. Non registra puntate o evidenze prospettiche e cede precedenza all'archivio Nightly anche quando questo compare durante il calcolo. La scheda Giocate può acquisire quote tramite una richiesta distinta dell'app.

Una puntata manuale confermata ha origine e prova proprie, usa l'importo scelto dall'utente e il medesimo portafoglio C. Il server ricostruisce il consiglio e verifica prezzo/bookmaker, freschezza, saldo disponibile e deduplicazione con le giocate Nightly, senza tetto cumulativo del 5%. Le percentuali automatiche non limitano l'importo manuale. Archiviare una proposta non impegna capitale.

Fonti: [anteprima](../../backend/src/research/ChallengerPreviewService.ts), [esecuzione](../../backend/src/research/ResearchRecommendationRuntime.ts), [store](../../backend/src/research/ResearchRecommendationStore.ts), [manuale](../../backend/src/services/ManualModelBetService.ts).

## Parametri e proiezione delle foglie

La release è un `calibrated_ensemble` con due regressori Poisson, uno per i gol
casa e uno per i gol ospite. Ogni regressore ha 120 alberi di profondità 5,
learning rate 0,05, seed 20261027, boosting Plain e 10 iterazioni Newton per
stimare le foglie. Il peso ML è 0,75 e la temperatura 0,8. Le 40 feature e le
strutture degli alberi restano quelle della ricetta; il dataset di riferimento
ha 5.293 righe di training, 317 di selezione riservata, 358 di calibrazione e
595 di test storico, tutti con esclusioni holdout e qualità applicate.

Per ogni albero, la proiezione raggruppa le foglie che coincidono in tutte le
condizioni di split diverse da `home_sample` e `away_sample`. Ogni gruppo riceve
la media dei valori originari pesata dai supporti delle sole 5.293 righe di
training. I supporti sono verificati contro il routing CatBoost nativo e
`leaf_weights`. Un gruppo senza supporto può rimanere zero soltanto se tutti
i valori originali erano zero; altrimenti la preparazione si arresta.

Questa trasformazione elimina dagli alberi l'effetto diretto dei due contatori.
Non elimina il loro ruolo nel resto della baseline o nella qualità dei dati e
non dimostra che fossero feature errate. Conserva split, scala/bias e media
training del contributo di ogni albero; non conserva ogni previsione training.
La calibrazione coerente C è ristimata con lo stesso metodo sulle stesse 358
gare, usando le probabilità trasformate. Il profilo A rimane quello previsto
dal contratto e non viene sostituito dalla variante sperimentale dei plateau.

Preparazione e controlli sono descritti in
[Research](../research-platform.md#proiezione-delle-foglie-della-release-corrente).
Il runtime legge direttamente i valori già proiettati dal JSON canonico:
non ricalcola i supporti né addestra alberi durante le richieste.

## Valutazione, adozione e limiti

L'adozione operativa della proiezione è una decisione esplicita dell'utente,
separata dalla validazione scientifica. La prova retrospettiva confronta cinque
coppie di ricette riaddestrate annualmente, non retrodata il file della release.
Sulle 8.541 gare ammesse delle finestre 2021/22–2025/26, dopo calibrazione e
blending con le stesse quote reali Bet365 di chiusura, Log Loss passa da 0,976551
a 0,976116 e Brier da 0,581335 a 0,580939. Migliorano entrambe in 3/5 leghe,
4/5 finestre e 13/25 celle lega/stagione; ECE top-label peggiora da 0,007329 a
0,012342. Gli intervalli appaiati includono zero. Il campione 2025/26 termina
il 4 aprile 2026; non sono cinque calendari completi. Questi risultati non
soddisfano una prova di beneficio stabile nelle cinque leghe e non misurano
redditività. [Dati e limiti](../research-platform.md#evidenza-sulla-proiezione).

Per le candidature valutate tramite review scientifica, il registro congela
artefatto, riferimento, configurazione, selettore e manifesto del training.
Il gate usa le prime 500 previsioni ammissibili `FUTURE_TEST`, congelate prima
degli esiti e ordinate cronologicamente. Attende tutti i risultati e registra
un solo giudizio. Richiede almeno quattro leghe, quattro mesi, quattro periodi,
intervalli appaiati settimanali favorevoli su Log Loss e Brier, ECE non peggiore
e stabilità della Log Loss in almeno quattro leghe. Non si sostituisce un test
negativo con nuove partite nello stesso dossier. La scelta operativa esplicita
non equivale al superamento di questo gate.

Training o iscrizione nel registry non costituiscono adozione. La sostituzione
operativa esplicita usa `replace-current-challenger.js`, con piano, backup e
controlli di identità, distinta dalla review scientifica. Tre fallimenti tecnici
indipendenti su partite e snapshot distinti sospendono il nuovo deployment;
non riattivano il vecchio C. Lo storico nel database rimane immutabile per
giocate, liquidazioni ed evidenze. Il pacchetto include un solo modello C e
non contiene un modello di rollback. A rimane indipendente da questa scelta.

Metriche probabilistiche, simulazioni virtuali e profitto sono evidenze diverse.
Senza quote reali prepartita idonee all'ora della decisione non si deducono ROI
o CLV. Storico già consultato, proxy di disponibilità e copertura incompleta
limitano la ricostruzione offline. Una nuova prova indipendente richiede
previsioni realmente salvate prima dei risultati.

Fonti: [trainer](../../backend/ml/train.py),
[sviluppo controllato](../../backend/src/research/ChallengerDevelopment.ts),
[adozione](../../backend/src/research/ChallengerAdoption.ts),
[evidenza prospettica](../../backend/src/research/ResearchProspectiveEvidence.ts).
