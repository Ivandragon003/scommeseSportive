# FootPredictor: piattaforma sperimentale A/C

Stato del codice e del rilascio: 29 ottobre 2026. Questo documento descrive il repository;
non certifica un deploy remoto, la copertura dei provider o la redditività.
Tutti gli importi sono virtuali. Non esiste un collegamento per piazzare
scommesse presso gli operatori.

Il [benchmark reale del 27 ottobre](performance/research-ac-2026-10-27.md)
comprende 7.323 osservazioni ammissibili e 2.168 previsioni fuori campione,
con holdout finale di 745 match. L'esito dopo calibrazione è **inconcludente**:
C non viene promosso, i mercati restano sperimentali e non esiste evidenza
economica A/C perché nel run non sono state caricate quote. Avvio Docker,
health e overview sono stati verificati localmente in ambiente isolato.
Anche il caricamento del candidato reale nel container e il backup/ripristino
SQLite locale sono verificati. Il 29 ottobre è stato completato anche il backup
Turso remoto, con ripristino isolato integro e prova delle migrazioni `015–019`.
L’anteprima su `http://localhost:3000/research` usa un database isolato,
due portafogli da 1.000 EUR e nessun job automatico attivo.
Il 29 ottobre backend e frontend `122fd360` sono distribuiti su Hostless.
Login, sessione persistente, calendario e dashboard A/C funzionano; health `200`,
route legacy `410` e API research anonima `401` sono verificati. La nightly di
manutenzione è riuscita senza nuove giocate. Le migrazioni `015–019` sono
applicate al Turso esistente e A/C sono nel registry, senza Champion C.
L'inferenza C reale dal registry è stata provata su Hostless con 1.000 inferenze
su input sintetico: probabilità valide, senza scritture o chiamate provider. Non è un
ciclo pre-match reale né una validazione della qualità predittiva.
I due portafogli shadow sono inizializzati a 1.000 EUR ciascuno, senza puntate;
i 26 mercati `EXPERIMENTAL` restano esclusi dalle registrazioni anche shadow.
Il worker embedded resta non operativo (`missing`, ambiente `404`). Dopo
l'autorizzazione GitHub del proprietario è stato creato lo standalone gratuito
`footpredictor-t15-standalone`: una replica, CPU 0,01–0,1 vCPU, RAM 128–256 MiB,
22 variabili protette, rilascio automatico disabilitato. Dopo la lunga coda,
entrambi i deployment `ed9e58ad`/`cc842005` sono falliti: `Deployment waited
too long in the queue`. Nessun heartbeat, processo o avvio build verificato. Il comando
iniziale conserva collaudi isolati e attesa inattiva con scheduler `false`.
Il cron standalone watchdog è creato a 0,1 vCPU/128 MiB ogni cinque minuti UTC,
con due deployment `cc842005` riusciti e 14 check reali `ok` nei Logs dalle
14:10:21 alle 15:15:13 CET, ogni cinque minuti. Runs resta vuoto e gli stati
UI oscillano: non descrivono le esecuzioni effettive. Il comando SELECT-only
è operativo su Hostless con `expectedEnabled=false`, coerente con il worker
intenzionalmente spento. Non sono attesi allarmi per questo stop; consegna
notifiche e canale esterno gratuito non sono collaudati. I timestamp di output
sono 7–21 s dopo l'intervallo cron, non misure del runtime o della puntualità
T−15. Lo script è passato anche separatamente in Docker sul Turso reale,
senza scritture/provider, con worker `UNOBSERVED`. Nessun job o puntata shadow.
La correzione nativa locale `cc842005` è pubblicata con CI verde; il web resta
LIVE `122fd360`. La correzione dei falsi errori cache-only `60a6baac` è
pubblicata con 66/66 mirati e revisione finale senza blocchi. CI riuscita:
777 test backend, 776 passati e un opzionale saltato; calibrazione riuscita,
web non ancora aggiornato a tale revisione. Il gate SELECT-only dall'immagine
di produzione `60a6baac` al Turso reale è passato: 40 profili per passaggio,
80 hit validi, 100 SELECT, zero fit/scritture/provider, cinque leghe e due
istanze fresche di PredictionService. Il deployment backend manuale è in coda
dalle 15:18 CET; al checkpoint 15:21 il web resta `122fd360`, senza nuovo
deploy frontend. Questa prova locale non certifica il fix quote su Hostless. Il gate Windows completo
non è passato per un crash nativo; Linux QA è riuscito: 777 test, 776 passati,
un opzionale CatBoost saltato, zero fallimenti. Nessuna quota o validazione
inventata. L'audit quote reale separato ha consumato 15 crediti in cinque
richieste (residuo 205): 89 eventi futuri, 3.539 record di mercato freschi al
controllo e 46 obsoleti esclusi, zero timestamp mancanti, Eurobet assente. Le
otto tabelle protette sono invariate. Scheduler T−15 e nuove registrazioni
shadow restano disabilitati; nightly di manutenzione e cron watchdog sono
attivi. Non è un ciclo T−15 Hostless. Il supporto ha confermato ricezione del report autorizzato,
senza diagnosi o correzione.
Non creare altri worker per superare la coda; completare i collaudi
e i gate di mercato dopo un deployment realmente pronto.
Dettagli nello [stato operativo](operations/production-status-2026-10-29.md) e
nella [scheda del blocco Hostless](operations/hostless-blocker-2026-10-29.md).

Il [follow-up tecnico A–I](performance/research-followup-2026-10-27.md)
documenta i difetti successivamente individuati, gli esperimenti di sviluppo e
il protocollo coerente V2. Il report originale e il suo JSON restano immutabili:
sono uno snapshot storico, non una validazione della pipeline modificata.

## Audit e scelte architetturali

Il sistema resta un monolite modulare React/Capacitor + Express/TypeScript,
con un solo database condiviso libSQL/Turso. Non sono introdotti un servizio
Python di produzione, un database parallelo o un portafoglio B.

| Area verificata | Comportamento e scelta |
|---|---|
| `PredictionService`, `PredictionContextBuilder` | Conservare modelli, contesto, calibrazione, blending e percorso UI esistenti; distinguere la ricostruzione storica dall'analisi live |
| `DixonColesModel`, `PoissonXgModel` | Riutilizzare il nucleo statistico A e versionare configurazione, parametri di fitting e impronta del codice |
| `ValueBettingEngine` | Conservare calcolo EV e regole legacy; usare un protocollo comparativo comune A/C con soglie esplicite e stima prudenziale |
| `OddsProviderCoordinator`, `BookmakerOddsSelectionService` | Conservare provider e provenienza; condividere il recupero A/C; non completare prezzi mancanti con quote del modello |
| Understat e `FootballDataService` | Conservare priorità Understat e supplemento `COALESCE`; nessuna riattivazione di scraper legacy |
| `ChronologicalForecastService`, `BacktestingEngine` | Conservare disponibilità risultati a kickoff + due ore e contesto ricostruito dal passato; estendere il confronto con ML e test separati |
| `HeavyJobService` | Conservare worker e limite per processo per il backtest legacy; il training CatBoost è un comando separato |
| Replay e learning review | Conservare le analisi; non usare tuning attuale o replay come evidenza di previsione prepartita |
| `AutomatedBetPlanningService` e route legacy | Conservare compatibilità dello storico; ritirare la route capace di registrare nuove puntate notturne |
| `DatabaseService` e migrazioni | Aggiungere `015_research_platform.sql`; non cancellare o riscrivere giocate, saldi, snapshot e preferenze precedenti |
| Budget | Tenere il budget legacy separato da `shadow_A`, `shadow_C` e dall'eventuale `main` della ricerca |
| GitHub Actions | Nightly per manutenzione; processo remoto persistente distinto per T−15; training distinto dalle decisioni |
| React/Capacitor | Estendere con la sezione Confronto A/C e lo stesso client autenticato; il telefono non esegue lo scheduler |

Le migrazioni sono additive. Le tabelle `research_*` conservano artefatti,
benchmark, promozioni, mercati, job, input, decisioni, puntate e movimenti.
I trigger impediscono UPDATE/DELETE sulle evidenze immutabili. Solo lo stato
del job, il puntatore Champion e lo stato corrente del mercato sono mutabili;
i cambi di modello/mercato hanno eventi separati. I lock locali non sono
sufficienti per più processi: la registrazione usa transazioni e unicità
persistente `(portfolio_id, match_id)`.

Il monitoraggio aggiunge incidenti e notifiche persistenti nella migrazione
`016_research_monitoring.sql`: leggere lo stato non crea portafogli, job o allarmi. Il backup deve
comprendere anche queste tabelle, oltre alla migrazione ricerca iniziale.

La migrazione `017_research_experiments.sql` aggiunge una corsia separata per
metadati diagnostici e risultati di sviluppo. Ogni esperimento conserva hash
del dataset e del report originale, configurazione, metriche e motivi di
esclusione. È marcato `runtimeCompatible=false` ed `eligibleForPromotion=false`:
un modello con maschere diagnostiche non può entrare nella scelta runtime.
La scheda Esperimenti dell'interfaccia legge questi record, distinti da modelli,
benchmark ufficiali e portafogli.

La migrazione `018_smart_odds.sql` aggiunge budget, cache e lease condivisi,
oltre al registro immutabile di richieste, risposte e blocchi del provider.
`DatabaseService.oddsRequests` è il solo gestore persistente del trasporto
The Odds API: normalizza le richieste, prenota atomicamente i crediti, evita
richieste contemporanee equivalenti e riconcilia gli header effettivi. Il costo
stimato di una richiesta fallita senza header rimane addebitato prudenzialmente;
un retry non presume che il primo tentativo fosse gratuito. Il backup deve
includere anche queste tabelle. Non si aggiunge un database o un microservizio.

## Modello A e candidato ibrido C

`ForecastCore` costruisce dati prepartita da tutte le partite ammissibili delle
cinque leghe, non dalle sole giocate consigliate. L'export conserva esclusioni,
schema delle feature, cutoff e manifest A. Il manifest comprende configurazioni,
versioni e hash dei moduli; i parametri sono ristimati soltanto sui precedenti
ammissibili. La stessa pipeline produce gli input di training, backtest e T−15.

Le feature comprendono Elo, campioni, gol/xG fatti e subiti, copertura xG, tiri,
forma recente, split casa/trasferta, riposo e statistiche stagionali. Le quote
non sono feature CatBoost: l'effetto del mercato resta distinguibile nel
successivo blending/Decision Engine. Aggiungere quote al training sarebbe un
nuovo esperimento da valutare sullo stesso test indipendente.

Il target non può fornire risultato, xG realizzati, tiri o cartellini futuri.
Si richiedono almeno trenta partite precedenti per competizione e un ritardo
minimo di due ore per rendere disponibile il risultato storico. Un timestamp
`availableAt` può posticiparlo. Questo è un protocollo prudenziale, non una prova
di quando il provider avesse pubblicato ogni dato: correzioni retroattive e
fonti prive di snapshot temporali restano un limite dello storico disponibile.

CatBoost è addestrato realmente da [backend/ml/train.py](../backend/ml/train.py),
con dipendenze fissate in [requirements.txt](../backend/ml/requirements.txt).
Le tre configurazioni C confrontate sono correzione delle intensità A,
correzione delle probabilità 1X2 A e ensemble statistico/ML calibrato. Pesi,
temperatura e configurazione vengono scelti sulla validazione cronologica;
il test successivo non decide i pesi. CatBoost standalone è un componente
sperimentale interno, senza motore operativo o portafoglio distinto.

Gli alberi numerici sono esportati JSON e letti da `CatBoostModel` in TypeScript;
Python non è necessario per l'inferenza del container web. Schema feature,
baseline e cutoff incompatibili causano un rifiuto. `ResearchProbabilityPipeline`
conserva il protocollo V1 per leggere e riprodurre le evidenze precedenti:
la correzione indipendente delle marginali non garantiva coerenza congiunta.
Il percorso decisionale corrente usa `CoherentProbabilityPipeline`, protocollo
`joint-goal-coherent-v2`: calibra una partizione 1X2 normalizzata, riproietta
la matrice dei gol e deriva da questa tutte le marginali usate anche nell'EV.
Conserva separati `raw`, `calibrated`, `decision` e probabilità bookmaker.
Le modalità sono identità, isotonica 1X2 e temperatura. Il blending usa una
partizione 1X2 completa di un solo operatore/snapshot e la riproiezione finale.
Il runtime richiede calibratori V2 e hash pipeline compatibili; un artefatto V1
non viene rietichettato o riattivato automaticamente. La baseline A ricostruita
è il nucleo cronologico del profilo di calibrazione: non è un'identità con ogni
stato del servizio live mutabile. Il modello C produce una
matrice congiunta normalizzata da cui derivare i mercati goal. Il troncamento
della griglia e le differenze tra marginali A legacy e matrice comune devono
restare visibili nel manifest: una proxy non va presentata come identità
matematica di tutta la pipeline live. La descrizione puntuale del protocollo
applicato e i limiti sono in [ML README](../backend/ml/README.md).

## Benchmark cronologico e Decision Engine

Il confronto ufficiale comprende soltanto A e C, con gli stessi match, cutoff,
snapshot di prezzo, mercati comuni, regole decisionali e bankroll iniziali.
Training crescente, selezione, calibrazione e test sono finestre cronologiche
separate. I kickoff simultanei restano nello stesso intervallo. L'ultimo test resta fuori dalla
selezione del candidato. Riutilizzare ripetutamente lo stesso test per scegliere
nuove configurazioni ne compromette l'indipendenza: conservare run, input e hash.

Le 745 partite finali già consultate sono protette per ID nella policy
`original-holdout-policy.json`, anche se un chiamante ne cambiasse la data.
Un nuovo test indipendente deve avere previsioni successive al congelamento
`2026-10-27T10:12:56Z`; la policy locale non è una certificazione esterna
dell'istante di preregistrazione. Gli esperimenti di sviluppo sono ammessi
fuori dai 745 ID, senza considerarli un nuovo test promozionale.

`ResearchEvaluation` separa metriche di tutte le previsioni dalle giocate
selezionate. Calcola log loss, Brier, calibrazione/ECE, differenze appaiate e
intervalli bootstrap, anche per blocchi settimanali; rende disponibili breakdown
per lega, stagione e mercato. Per il confronto bookmaker richiede esiti completi
e coerenti dello stesso operatore prima di rimuovere il margine.

Nel protocollo V2 score e Decision Engine usano la medesima distribuzione
congiunta finale: una marginale fornita esternamente in conflitto con questa
non può sostituire la probabilità nell'EV. Le simulazioni economiche mantengono
contabilità in centesimi, stake arrotondato per difetto e ritorni arrotondati
come il ledger persistente. V1 rimane consultabile come evidenza storica,
senza retrocedere queste correzioni sul report originale.

La selezione comune usa EV centrale almeno +4% ed EV prudenziale almeno +1%.
La prudenza usa residui di rendimento su una coorte di validazione pregressa,
un'osservazione per match nel bucket e un limite unilaterale Hoeffding al 95%.
Non è una sottrazione arbitraria fissa. Il limite dipende dall'ipotesi di unità
match indipendenti e dalla stabilità del bucket; non dimostra copertura esatta
per il futuro. Se manca evidenza sufficiente o il limite non supera la soglia,
la decisione è astensione. La coorte usata per stimare calibrazione/blending non
è riutilizzata come evidenza prudenziale indipendente; senza un'ulteriore coorte
con quote ammissibili il sistema si astiene. Queste sono soglie sperimentali,
non ottimi dimostrati.

`GoalSettlement` tratta DNB, push, linee intere, mezze e quarti di handicap/totali
con rimborsi e mezze vincite/perdite. L'EV considera la quota di stake davvero
a rischio. Gli score probabilistici binari non devono trasformare un push in
una sconfitta; i casi non binari sono esclusi esplicitamente dove necessario.

I report economici includono stake, capitale, P/L, ROI, win rate, drawdown,
curva patrimonio, fasce quota e CLV quando esiste una chiusura ammissibile.
Le differenze decisionali distinguono stessa scelta, scelte diverse, solo A,
solo C e nessuna. Un ROI su poche puntate o un mese di attività non promuove
automaticamente un modello.

Si distinguono tre evidenze:

1. **Backtest probabilistico:** risultati osservati, senza bisogno di quote.
2. **Backtest economico:** soltanto prezzi reali con bookmaker, provenienza e
   cronologia sufficienti. Apertura e chiusura restano tali; medie aggregate
   non provano un prezzo eseguibile presso un operatore.
3. **Shadow prospettico T−15:** input e prezzi congelati realmente prima del match,
   con target e ritardo misurato. Un prezzo storico senza timestamp non diventa
   T−15 attribuendogli un orario.

## Mercati e ciclo del modello

Gli stati sono specifici per famiglia/versione/mercato: `EXPERIMENTAL` produce
probabilità/backtest; `SHADOW` ammette il portafoglio sperimentale; `ACTIVE`
ammette il principale; `SUSPENDED` blocca nuove giocate. La promozione del
modello non promuove automaticamente tutti i suoi mercati.

I mercati goal prioritari hanno probabilità e settlement: 1X2, doppia chance,
DNB, over/under, team totals, BTTS e handicap europeo/asiatico. Restano soggetti
a disponibilità reale delle quote e validazione separata. Tiri, tiri in porta
e cartellini sono conservati nel percorso legacy ma inizialmente sperimentali
nel confronto A/C. Per cartellini totali vale gialli + 2 × tutti i rossi.
Corner/falli e relativi blocchi esistenti non sono sbloccati dal nuovo ML.

L'adattatore T−15 iniziale richiede al provider soltanto `h2h`, `totals` e
`spreads`: quindi il suo recupero diretto copre 1X2, totali e handicap asiatico.
La disponibilità matematica degli altri mercati non implica già una quota
reale nel processo prospettico. Ampliare la raccolta richiede mapping, verifica
dei consumi gratuiti e validazione del mercato; i percorsi legacy restano
conservati.

Il registry conserva artefatti, configurazione, feature, cutoff, metriche,
benchmark collegato e motivi di promozione/rollback. La promozione richiede
evidenza indipendente e controlli operativi; il passare del tempo o ROI positivo
non sono criteri sufficienti. Il rollback punta a una versione precedentemente
promossa e non riscrive decisioni o puntate precedenti. Un modello registrato
è un candidato: non equivale a un Champion validato.

`ResearchLifecycle` applica la regola `research-promotion-v1` sull'ultimo holdout
del candidato: almeno 500 osservazioni appaiate, quattro leghe e quattro periodi,
intervalli settimanali di log loss e Brier favorevoli, calibrazione e stabilità
nelle leghe, più tre controlli operativi misurati compatibili. Il primo C si
confronta con A; i successivi devono confrontarsi con il Champion corrente.
Un test riutilizzato da un'altra versione registrata blocca la promozione.
I numeri sono gate sperimentali prestabiliti, non prova universale di validità.
In presenza di un Champion il runtime può eseguire una prova limitata del
Challenger sullo stesso snapshot e registrare controlli di inferenza, senza
puntate o portafogli aggiuntivi. Questi controlli alimentano il gate operativo;
non sostituiscono il confronto probabilistico finale.

I tre controlli operativi devono riguardare partite e hash snapshot distinti,
essere eseguiti dopo la pipeline completa e includere compatibilità della
calibrazione, protocollo e hash correnti. Tre retry dello stesso input non
sono tre prove indipendenti. Anche il rollback distingue i fallimenti reali
di configurazione dai retry duplicati. Nessun candidato V2 ha al momento un
nuovo test futuro indipendente sufficiente a giustificare una promozione.
Report del lifecycle e prove operative conservano anche modalità e temperatura
effettive: un campo mancante non deve cambiare implicitamente il calibratore.
I controlli del Challenger richiedono lo stesso hash di configurazione
dell'artefatto osservato, oltre a protocollo, codice, partita e snapshot.
I report di mercato devono essere persistiti e collegati a famiglia/versione;
booleani dichiarati dal chiamante non bastano a promuovere un mercato.

[`ProbabilityConfiguration`](../backend/src/research/ProbabilityConfiguration.ts)
lega tale evidenza al post-processing effettivo: protocollo, hash pipeline,
modalità, temperatura e hash del calibratore o dei pesi di blending usati.
La versione raw A può restare uguale durante la ristima cronologica prevista;
non autorizza però a riusare un'approvazione dopo aver cambiato calibratore
o modalità. Runtime e store verificano il descrittore/hash approvato, altrimenti
si astengono con `probability_configuration_not_validated`. Il valutatore di
mercato richiede lo stesso hash per piano e osservazioni e rifiuta coorti miste.
Nessuna approvazione viene ricostruita retroattivamente per dati che ne sono privi.

La registrazione automatica inizializza i mercati C come `EXPERIMENTAL`.
Il report di confronto del modello non costruisce automaticamente evidenze
specialistiche o prospettiche per ciascun mercato. Senza queste evidenze nessun
mercato viene aperto per generare puntate. Il portafoglio `main` è facoltativo
e non viene creato dal normale avvio shadow.

`MarketValidationEngine` è il valutatore puro delle osservazioni di mercato:
non promuove un mercato dal tempo trascorso o da un ROI positivo. Gli input
sono definiti nei tipi [`MarketValidationInput`, `MarketValidationPlan` e
`MarketValidationObservation`](../backend/src/research/MarketValidationEngine.ts).
Il piano dichiara famiglia/versione/riferimento, baseline e feature, cutoff e
identità di training/selezione/calibrazione, finestra holdout. Ogni osservazione
conserva matrici candidato/riferimento, snapshot condiviso con hash, quota
reale completa, risultato confermato e settlement registrato indipendentemente.
Piano e osservazioni conservano anche `probabilityConfigurationHash`; il piano
contiene il descrittore corrispondente. L'assenza o la discordanza bloccano
l'abilitazione senza convertire una vecchia evidenza in una nuova approvazione.
Il valutatore verifica cronologia, assenza di sovrapposizioni, equivalenza
temporale e corrispondenza del settlement. Un piano con campi temporali non
prova da solo che la preregistrazione sia avvenuta prima di vedere gli esiti.

La regola `research-market-eligibility-v1` usa soglie sperimentali definite
nel codice, da fissare prima delle valutazioni future:

| Controllo | Gate iniziale |
|---|---|
| Campione per fase valutata | Almeno 200 match, quattro leghe e quattro settimane |
| Copertura dati e quote | Almeno 95% per fase |
| Calibrazione | ECE ≤ 0,08; estremi dell'IC del bias assoluto ≤ 0,10 |
| Regressione contro riferimento e bookmaker senza margine | Estremo superiore IC Brier ≤ +0,02 e log loss ≤ +0,05 |
| Stabilità | Almeno quattro leghe entro limite Brier; almeno 75% delle settimane con regressione Brier ≤ +0,05 |
| Incertezza | Bootstrap per settimane, 1.000 ricampionamenti, IC 95% |
| Prospettico | T−15 entro +60 s, quote al massimo cinque minuti, stesso snapshot/riferimento |
| Settlement | Nessuna discrepanza con esito registrato; push esclusi dallo scoring condizionale, mezzi esiti pesati |

Holdout idoneo consente `SHADOW`; per `ACTIVE` servono anche la fase prospettica
idonea e un Champion approvato verificabile dal registry persistito. Una
regressione di evidenze precedentemente ammesse produce `SUSPENDED`; senza
evidenze iniziali lo stato è `EXPERIMENTAL`. La regola non è dimostrata ottimale
e non è stata usata per aprire mercati sul run probabilistico senza quote.

## Portafogli virtuali e contabilità

`shadow_A` e `shadow_C` iniziano ciascuno con 100.000 centesimi virtuali.
Ogni stake è l'1% del patrimonio contabile, arrotondato per difetto ai centesimi; esposizione
aperta massima 5%. Il patrimonio è disponibile + impegnato. Nessuna ricarica
automatica, Martingala o puntata manuale è prevista per questi portafogli.
Il ledger registra apertura, impegno e liquidazione in modo atomico e
idempotente. I saldi sono ricostruibili sommando i movimenti.

Con 1.000 € iniziali, stake 10 € e quota 1,90: aperta = 990 € disponibili + 10 €
impegnati; vinta = 1.009 €; persa = 990 €; rimborsata = 1.000 €.
Le liquidazioni accettano soltanto moltiplicatori coerenti con esito e quota.
Una ripetizione dello stesso settlement non accredita due volte il ritorno.
Le partite senza risultato sufficiente restano irrisolte.

I budget legacy non sono importati nei portafogli shadow. Un eventuale `main`
ha ledger distinto e segue il Champion ammesso. Non sommare i tre patrimoni
come se fossero un unico capitale dell'utente.

## Automazioni e finestra T−15

| Processo | Responsabilità |
|---|---|
| Nightly, circa 03:00 Roma | Import/normalizzazione, risultati, integrità, calibrazione, learning e liquidazione; nessuna nuova puntata futura |
| `ResearchRuntime` + `T15Scheduler` | Job persistenti, recupero unico quote, decisioni A/C e registrazione virtuale nella finestra |
| Liquidazione | Esiti confermati del DB, settlement e movimenti dei portafogli |
| Training/validazione | Nuovi candidati e report; il training da solo non autorizza promozioni o mercati |

Per un match alle 20:45 il target è 20:30. La finestra ammessa è
`[target, target + 60 secondi]`, sempre prima del kickoff. Polling ogni 15 secondi.
Si registra come mancata una decisione oltre la finestra, anche dopo un riavvio.
Il controllo viene ripetuto al commit con l'orologio reale del processo;
passare un vecchio timestamp non consente un recupero retroattivo.

Kickoff e target sono memorizzati in UTC con timezone esplicita. I cambi di
ora legale sono conversioni di visualizzazione, senza sottrazioni su orari
locali ambigui. Prima del claim si aggiornano i job; rinvii, cancellazioni e
cambi d'orario invalidano o riprogrammano quelli ancora privi di evidenze.
Non si modifica una puntata congelata per cambiare retroattivamente il kickoff.

Il runtime condivide il recupero quote fra A/C e partite contemporanee dello
stesso campionato tramite il gestore persistente comune. Richiede soltanto
`h2h`, `totals` e `spreads` in una regione; altri mercati non sono inclusi nella
stima base. Il polling dei job non equivale a una richiesta provider ogni 15
secondi. Il calendario usa il feed eventi gratuito, senza consumare quote o
scores per conoscere l'orario. Sia `capturedAt` sia `updatedAt` provider devono essere
non futuri e vecchi al massimo cinque minuti. Quota assente, sintetica,
aggregata, obsoleta o senza bookmaker/timestamp valido provoca astensione.
Lease persistenti e vincoli SQL proteggono retry e job concorrenti; l'ordine
di allocazione per portafoglio è deterministico prima di impegnare il capitale.

Le letture UI sono cache-only per default; cache informativa fino a trenta
minuti non estende il limite T−15 di cinque minuti. `RUN_ODDS_SYNC=false` evita
la raccolta notturna; `ODDS_INFORMATIONAL_NETWORK_ENABLED=false` e
`ODDS_EXTRA_EVENT_NETWORK_ENABLED=false` evitano richieste informative ed
extra a consumo involontario. Cache e risposte mantengono i timestamp originari:
leggere un prezzo memorizzato non lo rende fresco. Crediti insufficienti,
reset mensile non confermato o quote assenti sono motivi tracciati di astensione.
`GET /api/research/odds-status` espone contatori osservati e pianificati separati,
costi incerti, cache e blocchi; la lettura non interroga il provider.

`RESEARCH_T15_SCHEDULER_ENABLED=false` è il default. Per eseguirlo su un host
remoto persistente usare il comando dedicato `npm run research:worker` e `true`
solo dopo i gate di modello, mercati e runtime. Il web non avvia lo scheduler.
Turso coordina lease globali e dei job; l'ammissione finale ricontrolla anche
kickoff/risultato aggiornati dalla nightly nella stessa transazione di scrittura.
Il runner nightly mantiene sempre `false`. Il vecchio endpoint
`POST /api/automation/place-valid-bets` risponde `410` anche se vecchi flag
o token restano configurati. La versione già pubblicata cambia soltanto dopo
un deploy: la rimozione nel repository non disabilita un processo remoto vecchio.

Lo stato è consultabile in `GET /api/research/overview`, con il medesimo accesso
amministratore dell'app. L'attività del worker deriva dalla lease e
dall'heartbeat persistenti in `research_worker_state`, letti senza inizializzare
portafogli o modificare il coordinamento. Il flag dell'ambiente web non descrive
il worker separato. Lo stato distingue attivo, fermo, segnale scaduto e non
verificato; un vecchio run dello scheduler non sostituisce l'heartbeat corrente.
Il runtime registra separatamente esiti e anomalie dei job.
Un healthcheck HTTP positivo non prova la puntualità, la freschezza
delle quote o il successo della nightly. Il monitoraggio da un processo spento
richiede un osservatore esterno: non dichiararlo attivo senza configurazione.

`ResearchMonitoring` conserva nell'app un riepilogo del giorno precedente in
Europe/Rome, dalla prima riconciliazione stabile dalle 09:00 e distinto per
portafoglio, e un incidente tecnico per ogni errore
persistente. Riavvii e polling non duplicano lo stesso incidente; una risoluzione
seguita da un nuovo errore apre una nuova generazione. Non genera notifiche per
ogni puntata. Il canale disponibile è `in_app`; l'invio esterno non è configurato.

Il [workflow settimanale](../.github/workflows/research-training.yml) tenta il
training ogni martedì alle 04:30 UTC, esporta i dati, prepara le feature,
addestra e conserva artefatti per trenta giorni. Produce una copia coerente V2
con modalità `identity` dichiarata esplicitamente, poi sottopone soltanto quella
ai gate di registrazione. È una configurazione iniziale senza ulteriore
calibrazione, non una scelta ottima dimostrata. Il trigger GitHub può ritardare;
per il training ciò non cambia il target T−15. La variabile repository
`RESEARCH_REGISTRY_WRITES_ENABLED=true` abilita separatamente la registrazione
del candidato e i gate di promozione/rollback sul DB configurato. Per default
il workflow produce soltanto artefatti e non abilita mercati o scheduler.
Il controllo rollback richiede tre fallimenti operativi consecutivi del
Champion e una versione precedentemente approvata; senza tali evidenze conserva
il modello corrente. L'esecuzione remota del workflow richiede pubblicazione,
secrets e verifica di un run effettivo.

L'ultimo fold storico prodotto da run settimanali può sovrapporsi ai precedenti;
il lifecycle non lo considera una nuova evidenza per un altro candidato.
La pianificazione di coorti future disgiunte e confronti fissati in anticipo
resta un gate prima dell'autopromozione remota. Il tentativo periodico di
training non è una garanzia di promozione né un sostituto di quel protocollo.

## Esecuzione riproducibile

Dalla cartella `backend`, dopo `npm ci` e `npm run build`:

```powershell
node scripts/research.js export --out ../artifacts/research/matches.json
node scripts/research.js dataset --input ../artifacts/research/matches.json --out ../artifacts/research/dataset.json --asof 2026-10-27T00:00:00Z
python -m pip install -r ml/requirements.txt
node scripts/research.js train --input ../artifacts/research/dataset.json --out ../artifacts/research/run-001 --folds 3 --iterations 120 --depth 5
node scripts/research.js evaluate --input ../artifacts/research/evaluation-rows.json --out ../artifacts/research/economic-report.json
node scripts/research-lifecycle.js finalize-coherent --artifact ../artifacts/research/run-001/artifact.json --report ../artifacts/research/run-001/report.json --out ../artifacts/research/run-001-coherent --mode isotonic_1x2
node scripts/research.js validate-market --input ../artifacts/research/market-evidence.json --out ../artifacts/research/market-report.json
```

`export` usa un collegamento SELECT-only autonomo: richiede le credenziali già
in ambiente e non avvia migrazioni o import. I passi successivi lavorano sui
file locali. `evaluate` richiede righe conformi a `EvaluationRow`, con fasi
validation/test e prezzi verificabili; non inventa quote dall'export risultati.
Conservare gli artefatti fuori da Git insieme a hash, configurazione e report;
non includere secrets. Gli esempi non implicano che il training sia stato eseguito
o che il run sia stato importato e promosso nel database operativo.

Il comando esplicito `research-lifecycle.js register --artifact PATH --report PATH
--dataset PATH` scrive nel database configurato e applica i gate. Non eseguirlo
contro il DB condiviso come semplice prova di lettura. `rollback-health`
valuta le evidenze operative registrate e può cambiare il Champion, senza
riscrivere lo storico. `finalize-coherent` clona artefatto e report in una
directory nuova, collega `parentVersion`, cambia identità/hash/protocollo e
prepara calibratori V2: non sovrascrive gli originali né rende valido un vecchio
holdout. Le modalità ammesse sono `identity`, `isotonic_1x2` e `temperature`
(con `--temperature` esplicita). Il comando `finalize` precedente resta un
percorso V1 diagnostico e non abilita il nuovo runtime.

`validate-market` è puro e non scrive nel database. `register-market`, con gli
stessi argomenti `--input`/`--out`, ricalcola le metriche, legge l'approvazione
dal registry effettivo e persiste benchmark/stato: è una scrittura esplicita,
non una verifica di sola lettura. Non accetta un semplice flag `approved`
del file per promuovere il mercato. Nessuno dei due comandi è stato eseguito
per attivare mercati nel database condiviso.

Controlli applicativi: backend `npm test` (include build), `npm run typecheck`,
`npm run lint`; frontend `npm run test:ci`, `npm run typecheck`, `npm run lint`,
`npm run build`. I test `research-forecast`, `research-catboost`,
`research-evaluation`, `research-store`, `research-scheduler`,
`research-settlement` e `nightly-maintenance` coprono le invarianti pertinenti;
i test di runtime, lifecycle, monitoraggio e DTO verificano i collegamenti.
Il test CatBoost reale può essere saltato se Python/CatBoost non è disponibile:
in quel caso un test JSON isolato non prova un addestramento reale.

La CLI dedicata agli esperimenti accetta obbligatoriamente un percorso SQLite
locale e non legge `TURSO_DATABASE_URL`:

```powershell
node scripts/research-experiments.js import --input artifacts/research/diagnostics-20261027/diagnostics.json --local-db artifacts/research/experiments-local.db
node scripts/research-experiments.js export --out artifacts/research/experiments-export.json --local-db artifacts/research/experiments-local.db
```

L'import scrive soltanto metadati nel DB locale, con identità e hash immutabili;
non registra un candidato in `research_models` e non può promuoverlo. I comandi
di scrittura sul registry operativo restano separati e non vengono eseguiti
sul remoto nella consegna locale.

## Deployment, quote gratuite e costi

La soluzione prevista riusa Hostless, il container Node e Turso condiviso;
non affida le decisioni a browser, Android o GitHub Scheduled Workflows.
La [guida Hostless](operations/hostless-deployment.md) descrive worker dedicato,
configurazione manuale, collaudo e rollback. La precedente guida Oracle è
un'alternativa storica, non la destinazione richiesta né una migrazione necessaria.
Non viene creato automaticamente alcun account, VM o servizio a pagamento.

I riferimenti ad altri host sotto restano confronti storici; per limiti correnti
e verifiche dell'account usare il [report operativo corrente](operations/production-status-2026-10-29.md).

Riferimenti del precedente audit del 27 ottobre 2026:

- [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm):
  A1 fino a 2 OCPU/12 GB complessivi (1.500 OCPUh e 9.000 GBh/mese), capacità
  regionale non garantita e possibile recupero delle VM inattive. Non è uno SLA.
- [Cloudflare Workers Free](https://developers.cloudflare.com/workers/platform/limits/):
  128 MB e 10 ms CPU per invocazione/cron; non è un sostituto compatibile del
  monolite di training/inferenza. Un trigger esterno non elimina il bisogno
  di un backend tempestivo e non è implementato come secondo scheduler.
- [GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule):
  può subire ritardi e job persi; resta adatto alla manutenzione periodica.
- [The Odds API Starter](https://the-odds-api.com/): 500 crediti mensili,
  quote correnti; [storico solo paid](https://the-odds-api.com/historical-odds-data/).
  Nessun acquisto viene introdotto per recuperarlo. La quota effettiva dell'account
  va letta dai suoi header, non desunta dalla pagina commerciale.

Il [costo documentato API](https://the-odds-api.com/liveapi/guides/v4/) dipende
da mercati e regioni; il runtime deve controllare crediti usati/rimanenti.
Esempio di capacità, non consumo misurato: tre mercati × una regione × 180
richieste costano 540 crediti, oltre il piano Starter. Cinque leghe e molte
finestre di kickoff possono dunque superare il gratuito anche con caching.
Se finiscono i crediti si salta la giocata; non si passa a un piano pagato.

Il vecchio esempio **855** era 135 gruppi × tre mercati + cinque leghe × tre
mercati × trenta notti: non un consumo osservato o un conteggio HTTP completo.
Il nuovo default locale spegne le quote notturne e le richieste informative.
La [simulazione ripetibile](performance/odds-demand-2026-10-27.md) calcola per
il calendario disponibile di ottobre 2026 447 crediti e 149 HTTP, includendo
un margine di retry del 10%: è uno scenario condizionato, senza prezzi misurati.
Nel mese storico più oneroso disponibile la domanda sale a 654 crediti;
quindi l'ottimizzazione non dimostra copertura integrale gratuita delle cinque
leghe in ogni mese. Il budget limita il consumo e conserva le decisioni saltate.

`ODDS_API_MONTHLY_CREDITS=500` e `ODDS_API_RESERVE_CREDITS=50` sono limiti di
pianificazione; T−15 può usare la riserva, le richieste informative la preservano.
Il residuo dell'account è sconosciuto fino agli header effettivi e non va
confuso con la capacità nominale. Il mese UTC è una convenzione locale: il
fuso esatto del reset del provider non è confermato; le richieste a consumo
del nuovo mese restano bloccate fino alla conferma tramite verifica gratuita.
La [gestione quote A–H](operations/smart-odds-2026-10-27.md) descrive dettagli e
limiti. Nessun cambiamento alle probabilità, al benchmark A/C o ai suoi artefatti
deriva da questa ottimizzazione.

La [lista ufficiale bookmaker](https://the-odds-api.com/sports-odds-data/bookmaker-apis.html)
non elenca Eurobet nella verifica corrente; non è stata provata una fonte
Eurobet autorizzata gratuita. La preferenza si applica solo a un prezzo reale
effettivamente ricevuto. Altri operatori mantengono il loro nome. Copertura
dei [mercati](https://the-odds-api.com/sports-odds-data/betting-markets.html) e
freschezza si verificano nel payload dell'evento, non dalla sola esistenza
di una chiave nella documentazione. Non si riattiva scraping bookmaker.
L'[audit dei provider](operations/odds-provider-audit-2026-10-27.md) non ha trovato
un fallback nuovo account gratuito già dimostrato con diritti, copertura e
freschezza richiesti. Non è stato attivato un nuovo provider.

L'obiettivo è costo ricorrente software/infrastruttura zero entro quote
disponibili. Non si può certificare costo zero o continuità T−15 senza account,
risorse, crediti e misure reali. Database/Actions conservano i limiti del piano
già configurato; il training settimanale deve rientrare nei minuti e nelle
risorse dell'host scelto.

## Backup e rollback

Prima di una migrazione o attivazione remota:

1. Fermare nuove decisioni disabilitando il processo T−15; attendere le transazioni
   aperte. Conservare separatamente codice/versione deploy e configurazione
   privata senza stamparne i secrets.
2. Esportare un backup consistente del database attraverso lo strumento Turso
   dell'account o un export SQLite in una transazione di lettura coerente.
   Una sequenza di query indipendenti durante scritture concorrenti non basta.
   Salvare anche migrazioni, artefatti e report con SHA-256.
3. Ripristinare in un file libSQL locale o in un ambiente di prova isolato;
   verificare integrità, conteggi, vincoli, riferimenti e ricostruzione di ogni
   portfolio da `research_ledger`. Non collegare il restore di prova al runtime
   operativo o ai provider.
4. Annotare data del backup e ultimo record incluso; soltanto un restore riuscito
   prova che il backup è utilizzabile. Non cancellare lo storico per liberare quota.

In caso di regressione: disabilitare nuove decisioni, conservare il DB, ritornare
all'immagine precedente compatibile con la migrazione additiva e ripristinare
il puntatore a una versione già validata. Non eseguire down-migration distruttive,
non cancellare i ledger e non riaccreditare manualmente stake già liquidati.
Le puntate aperte mantengono versione e snapshot originari; la liquidazione
prosegue indipendentemente dal modello attualmente attivo.

## Limiti di accettazione da controllare sul deploy

Non sono dimostrati dal solo codice: disponibilità Eurobet, sufficienza mensile
dei crediti gratuiti, puntualità cloud, notifiche esterne, backup ripristinabile,
superiorità C, validazione di ciascun mercato e assenza di regressioni nel tempo.
Il percorso reale previsione → registrazione prepartita → liquidazione deve
essere verificato con input autentici prima di dichiarare il progetto operativo.
Una verifica end-to-end su fixture prova i collegamenti tecnici; non sostituisce
un periodo prospettico remoto né un benchmark su partite reali.
