# Piattaforma di confronto A/C

**Nuova policy richiesta il 30 ottobre: implementata solo localmente, non
pubblicata né attivata.** A riproduce il consiglio della pagina Partite e la
sua percentuale di stake; C mantiene stake 1%. Due portafogli da 1.000 euro,
esposizione 5% e massimo una puntata per partita/modello. Il flag
`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` resta `false`. Backend `01320941`
e frontend `fb0e30f8` LIVE continuano sulla release precedente: i collaudi
remoti descritti sotto non attestano questa nuova policy. CI remota, preview
senza scritture finanziarie e attivazione restano pendenti.
[Specifica e avanzamento](operations/recommendation-execution-2026-10-30.md).


Direzione operativa aggiornata al 30 ottobre 2026: **Nightly Pre-Match Virtual
Betting**. La [guida canonica](operations/nightly-pre-match-2026-10-29.md)
sostituisce i requisiti di worker persistente, polling e decisione T−15 dei
precedenti report. Questi restano evidenze storiche: non sono riscritti e non
attestano l'attivazione della nuova nightly.

## Stato e confini

Il percorso e la dashboard sono pubblicati: frontend `fb0e30f8` e backend
`01320941` LIVE sul database personale. Il cutover è effettivo; health HTTP 200,
route legacy POST HTTP 410, login, sessione e vista 30 giorni A/C sono verificati.
Il 30 ottobre la registrazione A/C è riattivata dalle 10:04 UTC, dopo deploy
backend `01320941` e riconciliazione quota. Il run `41038096151` SUCCESS ha
verificato quattro incontri reali, otto decisioni e inferenze A/C, quattro
snapshot condivisi con quote fresche (massimo 205,314 secondi). Distribuzioni
valide e diverse, zero errori/API errori e zero BET: valore sotto soglia o
evidenza prudenziale insufficiente hanno prodotto astensioni corrette.
Sono congelate 58 osservazioni, 29 per modello, tutte CALIBRATION, su quattro
incontri indipendenti; nessun FUTURE_TEST o campione prudenziale completato.
Non sono 58 incontri o prova di superiorità/profitto. Wallet 1.000 euro ciascuno,
zero impegnati, 258 giocate legacy e modelli preservati; C Challenger.
Tre fetch reali consumano 9 crediti: 304 usati/196 residui, limite 500/riserva 50.
Duplicato fermato prima di npm/build e DB/provider; audit RO del duplicato PASS alle 10:22:18 UTC, senza nuovi run DB
o record provider. Watchdog `41039066641` e `41039490287` SUCCESS. Frontend
`fb0e30f8` Deployed LIVE, Site Running, deployment `6ae46ff81a67b8db20fa2f2e`;
CI `41039799271` SUCCESS. Puntualità del 31 ottobre 03:07 e ciclo fino alla
liquidazione restano da osservare. [Riscontri](operations/nightly-recovery-2026-10-30.md).

Verifica browser dopo il LIVE: sessione autenticata conservata, Sistema
mostra Riuscita alle 11:12 Roma, quattro partite e zero errori/API errori.
Prossimo run 31 ottobre 03:07 e testo «Orario di riferimento: 03:07 Europe/Rome»
verificati; quota 196 residui/304 usati e database raggiungibile. Le prove
restano private; questa è verifica dell'app effettiva, oltre al badge Hostless.

Il database canonico è la copia personale del dump 15:17 UTC, adottata con
approvazione del punto di ripristino e dei delta successivi non verificabili.
Non è una parità live con la sorgente bloccata. Il primo ciclo con partita
reale e liquidazione rimane da osservare; una corretta astensione è valida.

Per la nuova policy locale A usa PredictionService e il consiglio Partite
`APP-A` con hash/versione di stato, distinto da A research 80. C906 conserva
la sua baseline A80, integra CatBoost e resta Challenger. Il benchmark
statistico A80/C906 non viene riscritto per rappresentare questa nuova A. Non
vengono ottimizzati nuovamente i modelli né riutilizzato il test finale per
migliorare artificialmente i risultati economici. Registry, benchmark,
calibratori, tracciabilità e lifecycle restano conservati. La sola presenza
di codice o una suite locale verde non prova copertura quote, redditività o
un ciclo reale concluso sul cloud.

| Componente | Responsabilità corrente |
| --- | --- |
| Understat e supplemento HTTP/CSV consentito | Calendari, risultati e statistiche, con provenienza e campi esistenti preservati |
| `ForecastCore` e pipeline coerente V2 | Feature prepartita e probabilità A/C sul passato ammissibile |
| CatBoost JSON | Inferenza nel processo Node; training Python separato |
| Decision Engine | Stesse soglie e controlli per A/C; al massimo una puntata o astensione |
| `ResearchNightly` | Job finito sul runner GitHub, finestra reale e commit persistenti |
| Turso | Portafogli, ledger, quote, versioni, job e decisioni condivisi |
| Hostless web e React/Capacitor | API, dashboard e consultazione; nessun timer di puntata nel browser |
| Backtest in `HeavyJobService` | Thread interno per il calcolo storico, distinto dal worker cloud dismesso |

## Modello A e candidato ibrido C

`ForecastCore` costruisce dati prepartita da tutte le partite ammissibili delle
cinque leghe, non dalle sole giocate consigliate. L'export conserva esclusioni,
schema delle feature, cutoff e manifest A. Il manifest comprende configurazioni,
versioni e hash dei moduli; i parametri sono ristimati soltanto sui precedenti
ammissibili. La stessa pipeline produce gli input di training, backtest e decisioni prepartita.

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

La selezione comune del benchmark `ResearchEvaluation` usa EV centrale almeno
+4% ed EV prudenziale almeno +1%: non è la nuova esecuzione virtuale Partite.
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
3. **Puntate virtuali nightly:** snapshot e timestamp realmente osservati durante
   il job, prima della partita. Non si inventano quote notturne retroattive e
   non si equiparano ai precedenti esperimenti teorici T−15.

## Idoneità tecnica e validazione statistica

Le puntate virtuali servono anche a raccogliere evidenze su mercati ancora
`EXPERIMENTAL`. Il percorso nightly ammette questo stato solo con dati
sufficienti, probabilità coerenti, quota reale non sintetica, bookmaker e
linea identificati, timestamp valido prima del kickoff, liquidazione
implementata e controlli contabili superati. `SUSPENDED` resta escluso; i blocchi
corner/falli non vengono rimossi. La disponibilità matematica di un mercato
non dimostra disponibilità della relativa quota.

Gli stati e le approvazioni esistenti restano specifici per famiglia, versione
ed effettiva configurazione probabilistica. `SHADOW` rimane un valore storico
del registry, non una nuova modalità o un terzo portafoglio. La raccolta
virtuale non trasforma un mercato sperimentale in `ACTIVE` e non dichiara
C statisticamente superiore. I gate di promozione e il
[Market Validation Engine](../backend/src/research/MarketValidationEngine.ts)
restano distinti dall'idoneità tecnica per questa simulazione.

Il lifecycle conserva selezione cronologica, holdout indipendente, intervalli
appaiati, calibrazione e stabilità. Il test finale già consultato resta
protetto; per una nuova promozione serve nuova evidenza indipendente.
`ProbabilityConfiguration` lega l'evidenza a modalità, temperatura, protocollo
e hash effettivi. Non si ricostruisce un'approvazione assente dai vecchi record.
Le soglie della diagnosi/benchmark restano configurabili: EV centrale 4% ed EV
prudenziale 1%, senza dichiararle ottimali né usarle come veto della nuova
policy virtuale basata sul consiglio Partite.

## Evidenza prospettica e diagnosi del benchmark

L'[audit runtime e l'assemblatore](operations/nightly-model-runtime-2026-10-29.md)
distinguono inferenza CatBoost e decisione diagnostica del protocollo precedente.
Senza campioni prudenziali, le dieci origini già osservate sono ABSTAIN;
restano immutabili. La nuova esecuzione virtuale non eredita il veto 50/Hoeffding
e non modifica queste origini: eventuali BET hanno record e policy separati.

La migrazione additiva `021_research_prospective.sql` prepara osservazioni e
risultati append-only. La stessa transazione prepartita congela quota reale,
bookmaker, probabilità ed EV, versione, hash e fascia anche sull'astensione.
Nessuna finta puntata o modifica del ledger. Quando il risultato ufficiale è
realmente disponibile viene aggiunto il payout con il clock osservato: non si
retrodata e non si ricalcola una previsione usando il risultato.

Il protocollo assegna le partite tramite hash a un 80% nominale `CALIBRATION`
e 20% `FUTURE_TEST`, con la stessa partizione per A/C e mercati. Le proporzioni
su piccoli campioni possono differire; il futuro test e gli ID storici
protetti non entrano mai nei residui prudenziali. Le decisioni diagnostiche leggono
soltanto osservazioni già risolte e disponibili a quel timestamp, con stessa
famiglia, versione e identità dell'artefatto/configurazione.

Il minimo di 50 partite per mercato/fascia e Hoeffding restano nel benchmark
e nelle decisioni diagnostiche; non sono il veto della nuova esecuzione
virtuale. Non si trasformano 50 osservazioni in una validazione del modello. L'assemblatore non esegue
training, refit o promozioni e non inventa calibratori. Il nome `CALIBRATION`
identifica qui i residui prudenziali, non un nuovo fit dei calibratori. La raccolta richiede
comunque prezzi reali e rispetta il budget quote. Il percorso è verificato
localmente; 020/021 sono ora applicate sul target personale. La nightly
remota è riattivata al 30 ottobre dopo il recupero. Il primo job SUCCESS
del 29 ottobre ha registrato zero osservazioni
prospettiche e zero BET: nessun evento eleggibile nella finestra restante,
senza puntate retroattive o evidenze inventate.

## Nuova policy di esecuzione — solo locale

Il picker backend canonico conserva selezione e percentuale stake della pagina
Partite. A usa il pacchetto PredictionService `APP-A` effettivo, con versione
ed hash di stato tracciabili; C `C-906371b0b3a1e2c8` e baseline A80 sono immutati.
Il confronto economico include politiche di stake diverse: non isola da solo
la superiorità probabilistica di un modello. C rimane Challenger.

La nightly locale conserva prima origini DIAGNOSTIC a zero stake; solo il nuovo
opt-in `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` può creare esecuzioni con
nuove quote reali ≤300 secondi e record separati, senza riscrivere i dieci ABSTAIN.
023 prepara quattro tabelle `research_execution_policies`,
`research_execution_jobs`, `research_execution_inputs`, `research_execution_decisions`
e il nullable `research_bets.execution_decision_id`. Il ledger esistente è
riusato e l'unicità resta globale per partita/modello/portafoglio.

Il frontend locale usa il pacchetto congelato e gli euro effettivi, con stato
e timestamp della quota storica, senza presentarla come prezzo live. Un ABSTAIN
tecnico non viene coperto da un nuovo consiglio live. Replay senza pacchetto,
risposte tecniche 503 e confronti troncati sono ancora in review locale.
C scarta push/quarti non supportati e cerca un altro candidato idoneo; A
mantiene i quarti supportati da GoalSettlement. Mercati EXPERIMENTAL ammessi
se tecnicamente idonei, senza promessa di copertura totale, profitto o promozione.

Il flag è `false`; release, 023 in produzione, CI remota e preview senza
scritture finanziarie restano pendenti. Il backup ufficiale personale di circa
530 MB è verificato con due restore, integrità/FK0; rehearsal 023 e crash-resume
preservano 57 tabelle precedenti. Rollback: spegnere il nuovo flag mantenendo
settlement e nuove viste; non attribuire BET eseguite alle origini diagnostiche a stake zero.

## Due portafogli e contabilità

Si riutilizzano `research_portfolios`, `research_bets` e `research_ledger`.
Gli ID esistenti `shadow_A` e `shadow_C` identificano i portafogli A/C: non
vengono rinominati distruttivamente o duplicati. Capitale iniziale 100.000
centesimi ciascuno. Nella nuova policy locale lo stake A è esattamente la
percentuale del consiglio Partite, C usa 1%; esposizione aperta massima 5%,
una puntata per partita/modello. Nessun `main` aggiuntivo, reset,
ricarica automatica, Martingala o puntata manuale A/C.

Il patrimonio è disponibile più impegnato. Ledger, impegno e liquidazione sono
atomici e idempotenti; i vincoli persistenti evitano duplicazioni fra retry e
job concorrenti. Più partite nella stessa notte non possono oltrepassare il
5%. La nuova policy replica livelli Low/Medium/High e ranking effettivi della
pagina tramite picker backend canonico; la UI non riordina autonomamente.
Esiti rimborsati e mezzi esiti mantengono la propria regola di liquidazione.
Saldi legacy e A/C restano distinti, senza sommare i due patrimoni.

La dashboard confronta periodo 7/30/60/90 giorni, intera simulazione o date
personalizzate inclusive in Europe/Rome. Il backend calcola le metriche
complete prima di limitare le liste a 500 righe. Puntate e stake registrati
sono conteggiati per piazzamento; profitto, ROI ed esiti per liquidazione nel
periodo, anche su puntate precedenti. Il ROI usa lo stake liquidato e resta
non disponibile senza liquidazioni. La curva deriva dal ledger, il drawdown
dalla discesa rispetto al massimo del periodo. Il leader economico non è una
promozione statistica. I record vecchi conservano il protocollo delle quote.

## Elaborazione notturna

Il job GitHub esistente continua import, controlli e liquidazioni. Dopo i gate
dati e la preparazione delle feature/calibrazione richiama lo script finito
`backend/scripts/research-nightly.js`, senza route legacy di piazzamento.
Il programma pubblicato usa 03:07 Europe/Rome, con recuperi 04:17 e 05:27
e timezone nativa. La finestra predefinita parte dal
timestamp effettivo del job e finisce alla prossima esecuzione prevista;
`RESEARCH_NIGHTLY_WINDOW_HOURS` può fissare una durata tra 1 e 48 ore.

Prima di npm/build, il guard legge soltanto GitHub API. Il passo `Run nightly
sync` e il marker `Confirm enabled A/C completion` devono riuscire nello stesso
job e nella giornata Roma: solo allora un secondo ciclo con scritture/provider
viene impedito. Una manutenzione con A/C disabilitate o uno stato verde/cancellato
senza questi passi non consuma la giornata. Timestamp incoerenti o API incerte
bloccano il gate. I recuperi dopo failure non promettono un solo tentativo o
un orario preciso. Produzione, monitor e dashboard ricevono minuto 7; il default
locale resta 0.

`research_nightly_runs` e i job persistenti conservano finestra e policy per
retry; la migrazione additiva `020_research_nightly.sql` prepara questo stato.
Un'esecuzione ripresa non sposta arbitrariamente la finestra originaria.
La registrazione ricontrolla kickoff e capitale nella transazione. Partite
già iniziate, salti o ritardi non generano puntate retroattive.

A/C ricevono gli stessi snapshot, con versione del modello, selezione,
probabilità, EV, quota, bookmaker, timestamp, motivazione e distanza dal kickoff.
La freschezza predefinita massima è 300 secondi **alla decisione notturna**, sia
per l'acquisizione sia per l'aggiornamento originario della quota. Non serve
un recupero a cinque minuti dal kickoff o una chiamata a ogni polling.

Il web non esegue decisioni periodiche. `RESEARCH_T15_SCHEDULER_ENABLED=false`
resta impostato; le classi del vecchio percorso conservate per compatibilità
non sono un requisito del nuovo sistema. La route
`/api/automation/place-valid-bets` resta `410`; la nightly non chiama
`/bets/place` né legge `AUTO_BET_ENABLED` per abilitare il nuovo percorso.

Il monitoraggio riguarda ultima nightly, esito, partite analizzate/saltate,
registrazioni, crediti, liquidazioni ed errori contabili. Distingue flag
dichiarato nel web da `enabled` realmente osservato nel job. Il watchdog GitHub
può controllare esecuzioni e ritardi senza dipendere dal processo monitorato;
il monitor GitHub e il controllo DB RO rimangono distinti dal flag BET.
L’allineamento runtime al nuovo orario 03:07 è caricato; resta da osservare
il trigger programmato del 31 ottobre. L'opt-in delle attese è separato dal flag delle puntate; contabilità,
quota, errori e stalli recenti oltre quattro ore sono controllati anche
indipendentemente dall'aspettativa programmata. Audit finanziario RO del 29 ottobre 20:07 UTC
PASS; il watchdog con attese attive `40946558140` è SUCCESS, tutti i passi GitHub e DB RO completati in 26 secondi. Il monitor `4dff28f4` è il riscontro storico del 29 ottobre.
Nessun falso allarme per il vecchio worker intenzionalmente dismesso.
La generazione del riepilogo richiede nightly abilitata e reconcile: viene
preparata la riga con `publishAfter` alle 09:00 Europe/Rome. Il GET filtra
soltanto la visibilità, senza scritture o invio esterno.

## Quote e consumi

The Odds API e Smart Odds Manager restano invariati come infrastruttura:
cache condivisa, deduplicazione, prenotazione atomica, limite 500 e riserva 50
per le richieste informative. La nightly usa richieste essenziali, può usare
la riserva entro il limite totale e riutilizza la raccolta per lega/finestra
fra A/C. Mercati essenziali `h2h`, `totals`, `spreads`, una regione; gli altri
richiedono una quota autentica specifica. Eurobet è prioritario solo se
realmente restituito, senza rietichettare quote di altri operatori.

`forecastRemainingNightlyOddsDemand` raggruppa per lega/finestra notturna,
gestisce DST e mese contabile UTC ed esclude leghe senza partite previste.
È una stima condizionata al calendario, non consumo o copertura misurati.
Con cinque leghe ogni notte per 31 giorni: 465 crediti; ipotizzare 16 retry
aggiunge 48 e porta a 513, oltre il limite. Il gestore deve quindi saltare
richieste quando necessario. I vecchi 447/654 crediti nei report T−15 restano
scenari storici e non sono ricalcoli nightly. Vedi la
[gestione quote](operations/smart-odds-2026-10-27.md).

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

## Deployment, database e verifiche

Si mantengono Hostless, Turso e GitHub Actions. Il worker T−15 non è più
necessario e non vengono richieste nuove VM. Il vecchio cron Hostless
`footpredictor-watchdog` è `PAUSED`; una richiesta di pausa dello standalone
è stata accettata, ma lo stato `Sleeping`/`scaledDown=false` non prova la pausa
completata. Nessun servizio è eliminato. La
[guida Hostless](operations/hostless-deployment.md) descrive il nuovo perimetro.

Il personale è ora l'unico database canonico di web e GitHub. L'export finale
delle 18:58 UTC e la parità delle 19:00 UTC sono riusciti dopo 020/021: 57 tabelle,
133 oggetti di schema, storico 52 tabelle preservato. I due portafogli osservati
nel browser mantengono 1.000 euro ciascuno, zero puntate e zero impegnato.
Configurazione locale produzione e secret GitHub RW/RO sono aggiornati al
personale; la precedente configurazione resta in archivio privato.

L'adozione usa il dump 15:17 UTC / 16:17 Roma, con il limite di recupero e i
delta sorgente successivi non verificabili autorizzati dall'utente. Non si
presenta il confronto target come recupero di questi delta. L'originale non
è eliminato: la CLI disponibile gestisce solo il personale e serve il
proprietario per la dismissione autorizzata. Vedi la
[guida di migrazione](operations/turso-personal-migration-2026-10-29.md).

Hostless ha distribuito il backend `01320941`, con 0,1 vCPU/256 MiB
invariati. Warmup `40937894463`, probe C `40936914212` e verifica contabile RO
`40945351072` sono riusciti. Il probe reale ha eseguito 100 inferenze solo in
RAM, zero scritture/provider (p95 circa 0,532 ms, RSS 156,98 MiB); non è una
prova di puntualità della nightly o di throttling risolto. Il primo run storico del 29 ottobre
manuale `40944747548`, creato alle 19:57:46 UTC, è SUCCESS; job finito
alle 20:04:35 UTC. Il ciclo completo su evento reale resta pendente. L'
[audit Turso/CPU](operations/turso-cpu-audit-2026-10-29.md) conserva le misure
precedenti distinte da questi riscontri.

Le [prove runtime](operations/nightly-model-runtime-2026-10-29.md) descrivono
parità numerica dell'inferenza e accumulo prospettico su Linux. Per i conteggi
dei gate finali backend, frontend e Python il riferimento è la guida canonica
e la revisione effettivamente verificata dopo l’integrazione dell’assemblatore.
Un gate precedente non certifica l’intera release aggiornata. Test sintetici e controlli locali non attestano
un ciclo reale remoto.

## Backup e rollback

Nel caso ordinario, prima di una migrazione si sospendono i writer e si
verifica un backup finale coerente. In questa adozione il nuovo dump sorgente
è impossibile: l’utente ha approvato come base il dump delle 15:17 UTC con il suo
limite di recupero. La verifica finale deve riguardare il target preparato,
senza dichiarare recuperati o riconciliati delta sorgente non leggibili.

Per fermare nuove decisioni disabilitare `RESEARCH_NIGHTLY_ENABLED`, conservando
liquidazioni e storico. Il rollback del codice non deve ripristinare il
vecchio auto-betting legacy. Non cancellare ledger, reimpostare portafogli o
sovrascrivere un database con un backup vecchio. Il rollback deve coordinare
Hostless, nightly, calibrazione, training e monitoraggio sul nuovo canonico;
non riapre collegamenti all’originale bloccato né ricostruisce delta ignoti.

Il 30 ottobre sono verificati dati, probabilità A/C, quote reali e astensioni
congelate su quattro partite. Restano futuri risultato ufficiale e liquidazione,
oltre all’osservazione del trigger programmato: il ciclo completo non è concluso. Un'astensione corretta è un esito valido. Nessun
test sintetico dimostra redditività, superiorità C, consegna notifiche,
sostenibilità mensile o copertura bookmaker continua.
