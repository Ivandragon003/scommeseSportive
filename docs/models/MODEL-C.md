# Modello C

Questa guida descrive il meccanismo implementato e i suoi default. Il modello realmente usato dipende da registro e artefatti persistenti: non viene accertato leggendo solo il repository. Le procedure sono in [Research](../research-platform.md); esperimenti e relativi NO-GO sono nel [catalogo delle scelte scartate](../FORMULARIO-scelte-scartate.md).

## Identità e scelta del deployment

C è un ibrido fra una baseline statistica cronologica costruita con i componenti correnti di A e modelli CatBoost. La ricostruzione non replica l’intero `PredictionService`, il suo stato o la sua calibrazione: il confronto non misura tutto A operativo.

La release corrente applica la ricetta `opportunity_guard`, adottata per scelta
operativa esplicita dell'utente. Identità e hash sono fissati in
[CurrentChallengerRelease](../../backend/src/research/CurrentChallengerRelease.ts)
e nell'unico [artefatto C](../../backend/current-models/challenger.json).
`productionValidated: false` e `independentEvidence: false` restano tali:
la scelta non certifica superiorità predittiva o redditività futura.

| Campo | Contratto corrente |
|---|---|
| Baseline | `A-9227e65a047783bd` |
| Testa ML | Classificatore congiunto a sei esiti |
| Selettore | `c-resolved-engine-ranking-v1` |
| Mercati | `c-opportunity-guard-markets-v1` |

Il registro conserva artefatto, configurazione probabilistica e selettore.
Nightly e anteprima risolvono questa identità; la Nightly la congela per
l'esecuzione. Una candidata, un champion research o un training riuscito non
sostituiscono da soli C. La presenza del pacchetto non attesta l'adozione remota.

Se il registro non è leggibile il percorso C viene sospeso; un modello mancante o incompatibile produce indisponibilità/astensione, senza usare A al suo posto. Quando manca lo schema di adozione, il solo fallback previsto è la release corrente; ciò non prova che l'artefatto sia presente o valido. Un'identità precedente nel registro non autorizza l'esecuzione del vecchio C.

Il descrittore conserva esplicitamente identità, configurazione e selettore
del deployment. I formati precedenti restano interpretabili per gli archivi;
identità e pacchetti già salvati non vengono aggiornati retroattivamente
quando cambia il modello.

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

## Classificatore congiunto e distribuzione coerente dei gol

Gli alberi numerici JSON sono valutati in TypeScript: l'inferenza non richiede
Python, un servizio ML separato o un nuovo fit. Il caricatore verifica
artefatto, feature, baseline e disponibilità temporale dei profili.

La testa CatBoost stima sei masse: `H_U`, `H_O`, `D_U`, `D_O`, `A_U`, `A_O`,
cioè casa/pareggio/ospite incrociati con Under/Over 2,5. Le masse ridistribuiscono
la matrice A mantenendo la forma relativa dei punteggi dentro ciascuna delle
sei classi. La matrice ottenuta pesa 0,75 e la baseline 0,25; segue temperatura
0,8. La pipeline coerente applica la calibrazione isotonica 1X2 approvata e,
con una terna reale completa e valida dello stesso bookmaker/snapshot, il
blending con il mercato. Senza tale terna conserva la matrice calibrata.

Infine il ripristino condizionale della dispersione, con esponente 0,8,
normalizza i punteggi dentro ciascun risultato e ne conserva la massa 1X2.
Da questa matrice finale derivano tutte le probabilità C ammesse. Il motore
value non applica una seconda calibrazione o un secondo blending.

Il pacchetto riusa esattamente il classificatore e i profili 2026 già stimati:
la preparazione della release non riaddestra alberi né ricostruisce i profili.
Gli altri tipi di artefatto e selettori restano interpretabili per ricerca e
archivi; non sono fallback operativi della release corrente.

Fonti: [inferenza CatBoost](../../backend/src/research/CatBoostModel.ts),
[testa congiunta](../../backend/src/research/JointHeadProbability.ts),
[configurazione](../../backend/src/research/JointHeadConfiguration.ts),
[pipeline coerente](../../backend/src/research/CoherentProbabilityPipeline.ts).
Formule nel [formulario](../FORMULARIO-sistema-scommesse.md).

## Mercati squadra e filtro delle opportunità

Il contratto corrente `c-opportunity-guard-markets-v1` ammette soltanto 1X2,
Over/Under totale gol 2,5 e handicap asiatici. Non eredita le opportunità dello
specialista A per tiri, tiri in porta o cartellini. A conserva il proprio
catalogo, la propria matematica e tutte le opportunità qualificate.
Corner e falli restano bloccati; correct score resta interno e le player props
seguono il percorso separato dell'app.

Il selettore `c-resolved-engine-ranking-v1` usa il motore value condiviso su
istanze C dedicate, con affidabilità presequenziale e ranking nativo. La
percentuale dinamica conserva la formula A, applicata alle probabilità C.
Il payout degli AH considera rimborsi, mezze vincite e mezze perdite;
le coppie complementari hanno linee con segno opposto.

Il filtro `c-opportunity-value-guard-v1` valuta le opportunità 1X2 e totale
2,5 prima della scelta finale. Usa i coefficienti già stimati su errori
presequenziali precedenti al test, verificandone hash, supporto e cronologia.
Richiede un vantaggio conservativo positivo sulla quota reale, senza cambiare
le probabilità. Gli AH non vengono trattati come eventi binari. Dopo il filtro
si riordina l'intero insieme accettato con il ranking nativo, comprese le
opportunità oltre le tre mostrate in origine.

Nel replay la ricetta appresa respinge tutte le opportunità binarie e lascia
soltanto AH: è una conseguenza dei coefficienti, non un divieto manuale
aggiunto dopo gli esiti. Il contratto conserva 1X2 e totale 2,5, sottoposti al
filtro. L'affidabilità degli AH e la redditività futura non sono dimostrate.

Ogni selezione richiede quote prepartita reali, con provenienza veritiera,
fresche al massimo cinque minuti, fogli completi e coerenti, dati adeguati e
identità compatibile. `code-supported-markets-v1` definisce l'ammissibilità
nel codice; il registro qualitativo non abilita mercati ulteriori.

Fonti: [filtro e ranking](../../backend/src/research/COpportunityGuardRecommendation.ts),
[composizione](../../backend/src/research/ChallengerTeamRecommendation.ts),
[copertura](../../backend/src/research/ChallengerMarketCoverage.ts).

## Esecuzione, anteprima e importo

La Nightly C considera soltanto la giocata principale consigliata per partita.
Se non supera i controlli, non è finanziabile o la quota non è valida, si
astiene senza usare una secondaria. Può giocare più partite nello stesso gruppo.
La policy `funded-dynamic-stake-v1` applica la percentuale valida della
principale al patrimonio C iniziale del gruppo, disponibile più impegnato,
con importi completi e senza tetto cumulativo del 5%. Quote reali, kickoff,
saldo, payout liquidabile e duplicati sono ricontrollati nella transazione.

Il vincolo C sulla partita attraversa retry, versioni del modello, policy e
registri paper/finanziati: una giocata C già esistente, anche manuale, impedisce
una nuova registrazione automatica sulla partita. Le giocate annullate
logicamente non bloccano; le partite con più giocate storiche restano invariate.
A continua a considerare tutte le proprie opportunità qualificate.
Nessun percorso invia puntate a bookmaker o registra dopo il kickoff.

L'anteprima su richiesta usa lo stesso deployment e selettore C con orario corrente, ma il suo servizio usa solo quote in cache. Non registra puntate o evidenze prospettiche e cede precedenza all'archivio Nightly anche quando questo compare durante il calcolo. La scheda Giocate può acquisire quote tramite una richiesta distinta dell'app.

Una puntata manuale confermata ha origine e prova proprie, usa l'importo scelto dall'utente e il medesimo portafoglio C. Il server ricostruisce il consiglio e verifica prezzo/bookmaker, freschezza, saldo disponibile e deduplicazione con le giocate Nightly, senza tetto cumulativo del 5%. Le percentuali automatiche non limitano l'importo manuale. Archiviare una proposta non impegna capitale.

Fonti: [anteprima](../../backend/src/research/ChallengerPreviewService.ts), [esecuzione](../../backend/src/research/ResearchRecommendationRuntime.ts), [store](../../backend/src/research/ResearchRecommendationStore.ts), [manuale](../../backend/src/services/ManualModelBetService.ts).

## Valutazione, adozione e limiti

La scelta operativa adotta `opportunity_guard` senza trasformare lo studio in
un GO scientifico. Il ROI storico −1,62% è il rapporto tra profitto sommato
−937,56 euro e puntato sommato 58.027,96 euro, su 3.082 giocate in sei conti
stagionali indipendenti 2021/22–2026/27. Non è il rendimento sul capitale
iniziale. Il periodo 2026/27 parziale ha ROI +3,29%; il conto continuo da
1.000 euro termina a 245,38 euro. Il beneficio è parziale: peggiorano due leghe,
il 2025/26 peggiora e l'intervallo appaiato del miglioramento comprende zero.

Le sei stagioni usano i rispettivi fit e profili cronologici congelati: non
retrodatano l'unico file operativo 2026. Quote reali di chiusura, proxy di
disponibilità e storico già consultato non dimostrano prezzi eseguibili alle
03:07, CLV, superiorità indipendente o profitti futuri. La release operativa
riusa il solo componente 2026; la verifica di parità con il replay è distinta
dalla prova scientifica e dalla verifica dell'installazione remota.

Prove e riproduzione sono in
[Research](../research-platform.md#filtro-del-vantaggio-stimato-sulle-quote).
Gli esperimenti precedenti, inclusa la proiezione delle foglie e le varianti
non adottate, restano nel [catalogo](../FORMULARIO-scelte-scartate.md).

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
non riattivano il vecchio C. Nell'uso ordinario lo storico nel database rimane
immutabile. Una manutenzione esplicita può eliminare lo storico C obsoleto e
riaprire il portafoglio a 1.000 €, preservando la release adottata e A: vedere
la [procedura operativa](../operations/README.md#reset-esplicito-del-modello-c).
Il pacchetto include un solo modello C e
non contiene un modello di rollback. A rimane indipendente da questa scelta.

Metriche probabilistiche, simulazioni virtuali e profitto sono evidenze diverse.
Per una nuova prova indipendente servono previsioni realmente salvate prima
dei risultati. Dati e metodi dei replay precedenti restano in
[Research](../research-platform.md#replay-dinamico-delle-copie-c) e nel
[catalogo](../FORMULARIO-scelte-scartate.md), con identità e limiti originari.

Fonti: [trainer](../../backend/ml/train.py),
[sviluppo controllato](../../backend/src/research/ChallengerDevelopment.ts),
[adozione](../../backend/src/research/ChallengerAdoption.ts),
[evidenza prospettica](../../backend/src/research/ResearchProspectiveEvidence.ts).
