# Modello C

Questa guida descrive il meccanismo implementato e i suoi default. Il modello realmente usato dipende da registro e artefatti persistenti: non viene accertato leggendo solo il repository. Le procedure sono in [Research](../research-platform.md); esperimenti e relativi NO-GO sono nel [catalogo delle scelte scartate](../FORMULARIO-scelte-scartate.md).

## Identità e scelta del deployment

C è un ibrido fra una baseline statistica cronologica costruita con i componenti correnti di A e modelli CatBoost. La ricostruzione non replica l’intero `PredictionService`, il suo stato o la sua calibrazione: il confronto non misura tutto A operativo.

La release locale dichiarata in [CurrentChallengerRelease](../../backend/src/research/CurrentChallengerRelease.ts) e nel relativo [artefatto](../../backend/current-models/challenger.json) è:

| Campo | Default |
|---|---|
| Modello | `C-99ec096b068bb360` |
| Baseline | `A-c6c759d111a7734a` |
| Selettore | `canonical-binary-v1` |

La release è stata addestrata localmente; non risulta registrata, distribuita o attiva per questo solo fatto. Il registro di adozione può scegliere un altro deployment con artefatto, configurazione probabilistica e selettore espliciti. Nightly e anteprima risolvono questa identità; la Nightly la congela per l'esecuzione. Una nuova candidata, un champion research o il successo del training non sostituiscono da soli C.

Se il registro non è leggibile il percorso C viene sospeso; un modello mancante o incompatibile produce indisponibilità/astensione, senza usare A al suo posto. L'assenza dello schema di adozione conserva il fallback, non prova che l'artefatto sia presente o valido.

La nuova release usa il descrittore v3 anche nel fallback. Il descrittore v2 rimane soltanto per interpretare le registrazioni storiche del vecchio deployment. Identità e pacchetti già salvati non vengono aggiornati retroattivamente quando cambia il modello.

Fonti: [policy](../../backend/src/research/ResearchRecommendationPolicy.ts), [registro](../../backend/src/research/ChallengerAdoption.ts), [runtime](../../backend/src/research/ResearchRuntime.ts), [Nightly](../../backend/src/research/ResearchRecommendationNightly.ts).

## Input, cronologia e qualità dei dati

`ForecastCore` prepara baseline e 40 feature numeriche legacy: forza delle squadre, Elo, campioni, xG, forma e contesto disponibile prima del forecast. Quote bookmaker e statistiche del singolo giocatore non sono feature CatBoost di questo schema. Le quote possono intervenire nel post-processing e nella scelta.

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

Fonti: [CatBoost](../../backend/src/research/CatBoostModel.ts), [pipeline coerente](../../backend/src/research/CoherentProbabilityPipeline.ts), [configurazione](../../backend/src/research/ProbabilityConfiguration.ts). Le formule complete restano nel [formulario](../FORMULARIO-sistema-scommesse.md).

## Mercati e due selettori

Il feed corrente di C richiede `h2h`, `totals`, `spreads`: 1X2, over/under gol e handicap asiatico. Servono una quota reale ammissibile e uno stato consentito per mercato/versione nel registry. Calcolare BTTS, DNB o doppia chance non rende disponibili le quote mancanti. Gli altri mercati di A non vengono trasferiti automaticamente a C.

Il default `canonical-binary-v1`, chiamato `legacy-c906` nel builder, esclude quote con possibile rimborso o mezzo esito. Passa le probabilità C al `ValueBettingEngine` e al picker canonico, con seconda calibrazione e blending disabilitati. Confidenza e percentuale suggerita provengono dallo stesso motore di A, applicato alle probabilità proprie di C. La nuova Nightly dinamica conserva tale percentuale prima dell'override storico all'1%: non usa probabilità o stake di A per C. EV positivo da solo non supera necessariamente i filtri legacy.

La causale globale `non_binary_payout_not_supported_by_canonical_engine` può comparire quando alcune quote sono state escluse e non emerge un consiglio: non prova che una giocata valida sia stata bloccata dalla Nightly.

Il candidato `payout-aware-v1` valuta direttamente la distribuzione dei ritorni, compresi rimborsi, mezze vittorie e mezze perdite. Il percorso ordinario richiede EV e crescita logaritmica positivi e ordina secondo crescita, EV, rischio e parità deterministica. La raccolta delle opportunità con stake di esecuzione separato non usa il veto sulla crescita logaritmica del precedente stake fisso; mantiene EV e gli altri criteri. Non usa il motore value o il picker di A. La varianza dei ritorni secondo il modello non è una stima dell'incertezza parametrica: confidenza e incertezza non disponibili restano esplicite, senza valori inventati. La percentuale candidata resta distinta dallo stake del percorso legacy e deve rispettare i controlli della policy di esecuzione.

Il selettore candidato è operativo solo quando è quello del deployment risolto dal registro. Esclusioni e pacchetto congelato servono a distinguere assenza di consiglio, quote inadeguate e fallimenti tecnici.

Fonti: [raccomandazione](../../backend/src/research/ChallengerRecommendation.ts), [selettore candidato](../../backend/src/research/ChallengerSelection.ts), [liquidazione gol](../../backend/src/research/GoalSettlement.ts).

## Esecuzione, anteprima e importo

La Nightly considera tutte le selezioni C qualificate, senza limite di una giocata per partita o top N. La policy `funded-dynamic-stake-v1` applica la percentuale suggerita dal motore di C al patrimonio C iniziale del gruppo, disponibile più impegnato. Il saldo disponibile deve coprire gli importi completi, con priorità HIGH, MEDIUM, LOW, poi EV decrescente e chiave, senza tetto cumulativo del 5%. Una percentuale mancante o invalida non finanzia una giocata. Quote reali entro cinque minuti, kickoff, saldo, mercati liquidabili e duplicati vengono ricontrollati. Non invia puntate a bookmaker e non registra dopo il kickoff. Il vecchio percorso automatico C usava l'1% fisso: la percentuale dinamica C è un nuovo uso dell'output già calcolato dal motore, non il ripristino di un precedente comportamento operativo C.

L'anteprima su richiesta usa lo stesso deployment e selettore C con orario corrente, ma il suo servizio usa solo quote in cache. Non registra puntate o evidenze prospettiche e cede precedenza all'archivio Nightly anche quando questo compare durante il calcolo. La scheda Giocate può acquisire quote tramite una richiesta distinta dell'app.

Una puntata manuale confermata ha origine e prova proprie, usa l'importo scelto dall'utente e il medesimo portafoglio C. Il server ricostruisce il consiglio e verifica prezzo/bookmaker, freschezza, saldo disponibile e deduplicazione con le giocate Nightly, senza tetto cumulativo del 5%. Le percentuali automatiche non limitano l'importo manuale. Archiviare una proposta non impegna capitale.

Fonti: [anteprima](../../backend/src/research/ChallengerPreviewService.ts), [esecuzione](../../backend/src/research/ResearchRecommendationRuntime.ts), [store](../../backend/src/research/ResearchRecommendationStore.ts), [manuale](../../backend/src/services/ManualModelBetService.ts).

## Valutazione, adozione e limiti

Il trainer controllato distingue varianti fisse e quattro fasi cronologiche: training, selezione, calibrazione e test. Le etichette di una fase devono essere disponibili prima della successiva. Repliche riaddestrate e controlli di ricetta sono diagnostici: non sono l'artefatto C906 retrodatato e non diventano candidati operativi grazie alle sole metriche storiche.

La release locale usa 6.573 righe pulite, escludendo 745 target protetti e la quarantena. La ricetta fissa usa 120 iterazioni, profondità 5, learning rate 0,05 e seed 20261027; le fasi contano 5.293 training, 317 selezione, 358 calibrazione e 595 test, con calibrazione isotonica coerente. Sul test, il controllo diagnostico contro il fold 5 della precedente ricetta pulita ha scarto massimo 0, Log Loss 0,9956929835 e Brier 0,59412743: non è una conferma indipendente.

Una candidatura valida congela artefatto, incumbent, configurazione, selettore e manifesto del training. Il gate di adozione usa le prime 500 previsioni ammissibili FUTURE_TEST congelate prima degli esiti, in ordine cronologico. Attende tutti i risultati e registra un solo giudizio. Richiede almeno quattro leghe, quattro mesi, quattro periodi, intervalli appaiati settimanali favorevoli su Log Loss e Brier, ECE non peggiore e stabilità della Log Loss in almeno quattro leghe. Non si sostituisce un test negativo con nuove partite nello stesso dossier.

La review può adottare il deployment solo superando quel gate; training o iscrizione nel registry non costituiscono adozione. Il rollback tecnico richiede tre fallimenti indipendenti del deployment adottato su partite e snapshot distinti nella finestra prevista e ripristina il deployment C precedente. Non modifica A o decisioni storiche.

Metriche probabilistiche, simulazioni virtuali e profitto sono evidenze diverse. Senza quote reali prepartita idonee all'ora della decisione non si deducono ROI o CLV. Riuso esplorativo dello storico, proxy di disponibilità e copertura incompleta limitano una ricostruzione offline. Una nuova prova indipendente richiede previsioni realmente salvate prima dei risultati.

Fonti: [trainer](../../backend/ml/train.py), [sviluppo controllato](../../backend/src/research/ChallengerDevelopment.ts), [adozione](../../backend/src/research/ChallengerAdoption.ts), [evidenza prospettica](../../backend/src/research/ResearchProspectiveEvidence.ts).
