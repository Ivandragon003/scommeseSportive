# Operazioni dell'applicazione

## Reset esplicito del modello C

`backend/scripts/reset-challenger-production.js` è una manutenzione distruttiva,
separata dall'avvio e dal normale rilascio. Richiede il mandato al reset, un
backup completo con restore verificato e un piano privato associato al target.
Il piano predefinito esegue soltanto letture; `--apply` richiede il suo hash,
il manifest del backup e una nuova ricevuta. L'host di produzione è vincolato.

Il reset elimina decisioni, giocate, liquidazioni, cancellazioni e osservazioni C,
comprese le previsioni C degli input condivisi e quelle accoppiate di valutazione.
Le righe A operative restano conservate; negli archivi condivisi si aggiornano
soltanto i riferimenti agli input migrati. Gli hash originari restano come
metadati di migrazione, senza conservare il contenuto C rimosso. I vecchi input
non sono più replayabili e non costituiscono una coppia A/C immutata.

Il nuovo movimento di apertura C è 100.000 centesimi, con zero impegnato. Il
cutoff persistito nella stessa transazione impedisce claim, commit, recovery e
nuove raccolte basati su job o previsioni precedenti. Un vecchio job pendente
non viene riattivato dal reset. Modello corrente, parametri e configurazione
restano distinti dallo storico; dipendenze di adozione o recensione inattese
bloccano l'operazione. Trigger e chiavi esterne vengono verificati prima del commit.

Per la protezione dei dati osservati e la quarantena delle quote legacy vedere
il [contratto delle osservazioni](../data-observation-contract.md). La migrazione
mirata si esegue con `backend/scripts/prepare-data-integrity.js`, con gli stessi
vincoli di piano, backup e target; non avvia il bootstrap generale.

## Uso ordinario

Questa guida descrive i comportamenti correnti e rimanda alle procedure
specialistiche. Codice e configurazione del repository descrivono ciò che
può essere eseguito; stato remoto, saldi, quote residue e release installate
richiedono una verifica dell'ambiente effettivo.

| Attività | Riferimento unico |
| --- | --- |
| Avvio locale e configurazione | [README](../../README.md) |
| Import, nuove giocate virtuali A/C, liquidazioni, recuperi e watchdog | [Nightly GitHub Actions](../github-actions-nightly-sync.md) |
| Rilascio web e controllo Hostless | [Deploy Hostless](hostless-deployment.md) |
| Backup e prova di ripristino locale | [Backup Turso](turso-backup.md) |
| Build, firma e aggiornamento Android | [APK privato](../android-private-apk.md) |
| Architettura e contratti | [System Design](../SYSTEM-DESIGN.md) |
| Modelli, benchmark e adozione C | [Piattaforma research](../research-platform.md) |

## Portafogli e storico

Partite, Giocate, Budget e Archivio leggono importi in euro e saldi tramite
`GET /api/wallets` e `GET /api/wallets/archive`. Le selezioni automatiche e le
puntate manuali usano i portafogli virtuali esistenti `shadow_A` e `shadow_C`,
sempre separati: nessun capitale viene aperto nuovamente o ricaricato durante
la transizione. Le giocate del
registro deterministico precedente hanno identità esplicita di modello A
(`model_family='A'`, portafoglio `legacy_deterministic_A`); capitale e ledger
restano distinti da quelli dei portafogli `shadow_A` e `shadow_C`.
La UI distingue registrazioni manuali, Nightly e opportunità archiviate.
Aggregati, filtri temporali e dettagli paginati/limitati hanno significati
diversi: una lista parziale non sostituisce il totale del portafoglio.

La Nightly automatica usa la policy `funded-dynamic-stake-v1`, con
`stakeMode=MODEL_RECOMMENDED_PERCENT`: considera
tutte le opportunità dei mercati già supportati che superano i criteri del
modello, EV e controlli prudenziali esistenti. Non applica top N né massimi
per esecuzione, giorno, campionato, partita o modello. Più mercati della
stessa partita e la medesima selezione di A e C sono registrazioni distinte.
La chiave `(famiglia, partita, mercato/esito/linea/squadra)` impedisce
di rigiocare la stessa selezione per un cambio di bookmaker, prezzo o versione.
Linea e squadra entrano nella chiave solo nei mercati che le usano: campi
aggiuntivi irrilevanti non creano una seconda puntata. Quote di bookmaker
diversi sullo stesso esito sono prezzi alternativi della stessa selezione;
si conserva il migliore prezzo già qualificato. A e C restano separati.
Le quote dei bookmaker già acquisite sono qualificate prima di scegliere il
migliore prezzo ammissibile; non si aumenta il numero di chiamate per selezione.

Ogni opportunità fornisce la propria percentuale dinamica suggerita: A usa i
controlli Kelly/rischio esistenti; per i mercati gol C usa il motore sulle
proprie probabilità, mentre per le statistiche usa lo specialista A condiviso. Non è
la mappa fissa LOW 1% / MEDIUM 3% / HIGH 5%. La percentuale valida, espressa
con due decimali, si applica al **patrimonio della famiglia a inizio gruppo**,
cioè saldo disponibile più importo già impegnato, letto nella transazione.
Lo stake viene arrotondato per difetto al centesimo. Il saldo residuo deve
coprire l'intero importo: non si ridistribuisce proporzionalmente. Se non basta,
la priorità è HIGH, MEDIUM, LOW, poi EV decrescente e chiave crescente.
Percentuali mancanti/invalide e stake arrotondati a zero non finanziano giocate.
Non esiste un tetto cumulativo del 5%: più giocate possono impegnare una quota
maggiore, entro il saldo disponibile. I limiti interni per singola selezione
del motore restano distinti dal saldo e dall'ammissibilità delle opportunità.

Il profitto è il ritorno in euro meno lo stake della selezione liquidata;
il ROI è `100 × profitto / stake delle selezioni liquidate`. Le puntate aperte
hanno conteggio e importo separati. Vittorie/perdite parziali e annullamenti
usano il moltiplicatore del settlement; il ritorno è arrotondato al centesimo.
La percentuale di successo esclude gli annullamenti. Le proposte senza stake
non entrano nel ROI.

La migrazione **additiva 030** introduce `dynamic_model_bets` e
`dynamic_model_settlements`, con evidenze immutabili e movimenti sullo stesso
`research_ledger` dei portafogli esistenti. Non apre capitali né riscrive lo
storico. La precedente policy `funded-confidence-v1` e i suoi importi fissi
restano identificabili come storici.

La migrazione **additiva 031** introduce `funded_model_bet_cancellations`:
il passaggio controllato annulla soltanto le giocate fisse future, pendenti
e scelte nel piano. Ogni cancellazione immutabile restituisce tutto lo stake
al saldo e lo sottrae dall'impegnato, lasciando invariato il patrimonio.
Il movimento ha ID `cancel:<id-giocata>` ed evento `SETTLE`, con `bet_id` nullo:
è un rimborso di cancellazione, non una liquidazione sportiva. Le righe delle
vecchie giocate e i movimenti precedenti restano invariati; le giocate annullate
sono escluse da totali operativi, ROI e settlement. Anche le precedenti
registrazioni paper annullate restano evidenza distinta, senza conversioni
in euro. La nuova Nightly acquisisce quote fresche e ricalcola A e C:
può produrre selezioni diverse o astenersi, senza ricreare automaticamente
le giocate annullate. Backup, migrazioni e rimborso seguono la
[procedura controllata](../github-actions-nightly-sync.md#pubblicazione-e-passaggio-ai-portafogli-in-euro).
Nessun percorso trasmette puntate a un bookmaker.

Restano obbligatori dati affidabili, quota reale recente, identità, timing
prepartita, configurazione/versione del modello, idempotenza e budget API.
I mercati disabilitati e i player props non diventano automaticamente ammessi.
Per la copertura squadra della release corrente C e la registrazione esplicita
dei mercati vedi [Modello C](../models/MODEL-C.md) e
[Research](../research-platform.md#registrare-la-copertura-squadra-c).
La modalità finanziata sopprime la registrazione prospettica opzionale delle sue
inferenze aggiuntive: non avvia né modifica il pilot scientifico.

Un punteggio mancante o invalido non equivale a zero: la liquidazione research
mantiene irrisolte le giocate senza entrambi i gol osservati come interi non
negativi. Un evento provider esplicitamente live/concluso non autorizza a
riscrivere il kickoff in preparazione. Un cambio di orario senza tali stati
mantiene il percorso precedente, inclusa la finestra persa in caso di anticipo
già trascorso, senza puntata retroattiva. Questi controlli non aggiornano dati storici e non
provano che la fonte del risultato sia oggi disponibile.

## Prova isolata della pipeline

`backend/test/automatic-pipeline-e2e.test.js` attraversa acquisizione in forma
Understat, CSV, SQLite temporaneo, statistiche, A, C, trasporto quote, accounting
API, selezione, claim, portafogli e liquidazione. I dati e le quote sono fixture
esplicitamente sintetiche; solo il callback HTTP viene sostituito nel budget
store. I calcoli ordinari della baseline congelata avvengono in RAM, senza
riaddestrare CatBoost C o aggiornare parametri/calibrazioni operativi.

Il default usa un piccolo artefatto C di test. Con `FP_REAL_C_ARTIFACT` riferito
a una copia privata esistente di C-906, il test controlla versione e hash
approvati prima/dopo e percorre anche l'inferenza di quell'artefatto. Il file non
viene distribuito con i test né modificato. Il test non è prova della copertura,
licenza, disponibilità live, redditività o attivazione della Nightly; i controlli
su servizi reali e il consenso alle scritture restano separati.

La regressione temporale esclude dal forecast C una partita di fixture
successiva all'istante della previsione. I parametri A sono fissi e sintetici:
la prova non certifica la disponibilità temporale di aggregati, parametri e
calibrazioni A e non rende ammissibili input alla validazione prospettica.

Dopo la build, dalla directory `backend`:

```powershell
node --test test/automatic-pipeline-e2e.test.js test/research-settlement-observations.test.js
```

Usare soltanto archivi temporanei gestiti dal test. Non passare un database
operativo, non avviare il Compose ordinario come preflight read-only e non
modificare i flag A/C o prospettici per provare questa suite.

Riferimenti: [AppWalletService](../../backend/src/services/AppWalletService.ts),
[WalletArchiveService](../../backend/src/services/WalletArchiveService.ts),
[identità A del registro precedente](../../backend/migrations/027_deterministic_bet_model.sql),
[policy Nightly](../../backend/src/research/ResearchRecommendationPolicy.ts),
[assegnazione degli importi](../../backend/src/research/DynamicModelStake.ts),
[registro dinamico](../../backend/src/research/DynamicModelBetLedger.ts),
[migrazione 030](../../backend/migrations/030_dynamic_model_bets.sql),
[migrazione 031](../../backend/migrations/031_dynamic_funded_cancellations.sql).

## Consigli, quote e consumo provider

L'analisi iniziale A legge le quote salvate. C mostra prima la decisione
Nightly archiviata; in sua assenza può produrre un'anteprima non registrata
con dati e quote già disponibili, senza acquisire prezzi dalla rete.
Aprire l'anteprima non crea puntate, movimenti o forecast prospettici.

La scheda **Giocate nel dettaglio partita** monta però
[MatchQuoteRequest](../../frontend/src/components/predictions/MatchQuoteRequest.tsx):
quando l'analisi è pronta e non ha quote abbastanza recenti, chiede
automaticamente `/api/scraper/odds/match` con `cacheOnly=false` e
`requestNetwork=true`. Il tentativo automatico è limitato per partita da una
finestra di cinque minuti nella sessione UI; il pulsante Riprova consente
un nuovo tentativo. Cache, budget e disponibilità possono evitare o impedire
il fetch effettivo. Non è quindi corretto dichiarare gratuita tutta la
consultazione o riservare ogni richiesta quote alla sola Nightly.

Le richieste autorizzate condividono budget e cache persistenti attraverso
[SmartOddsRequestStore](../../backend/src/services/odds-provider/SmartOddsRequestStore.ts).
`ODDS_API_ACCOUNT_SCOPE` deve restare uguale per le chiavi della medesima
sottoscrizione, anche dopo rotazione. I default pianificano 500 crediti e
50 di riserva; non dimostrano il piano attivo o il consumo residuo.
Verificare misure provider, timestamp e reset prima di abilitare nuovi fetch.
Non cambiare scope o azzerare il ledger per simulare crediti disponibili.

`RUN_ODDS_SYNC=false` e `ODDS_INFORMATIONAL_NETWORK_ENABLED=false` spengono
la raccolta informativa generale, ma non equivalgono a un blocco di tutte
le richieste esplicite per partita o del feed essenziale Nightly.
Quote sintetiche, compresi i completamenti del modello, restano interne:
nessuna attribuzione bookmaker, value o ROI basati su quei prezzi.

## Azioni manuali

Le azioni nel dettaglio richiedono autenticazione e conferma dell'utente.
[ManualModelBetService](../../backend/src/services/ManualModelBetService.ts)
ricostruisce lato server modello e quota salvata: bookmaker, prezzo e
selezione devono coincidere con quelli confermati. Non accetta una quota
inventata dal browser e non acquisisce nuove quote durante la conferma.
Per registrare una giocata servono quota reale recente (massimo cinque
minuti), partita futura, mercato liquidabile e saldo disponibile sufficiente;
i controlli vengono ripetuti nella transazione, senza tetto cumulativo del 5%.
La stessa selezione già finanziata dalla Nightly non può essere duplicata
manualmente. Un conflitto richiede di
riaprire il consiglio aggiornato, senza modificare lo storico.

- `POST /api/wallets/bets/manual`: registra la giocata e il movimento sul
  portafoglio della famiglia scelta, con origine manuale immutabile.
- `POST /api/wallets/opportunities/archive/manual`: conserva un'opportunità
  LOW o SPECULATIVE coerente con il modello, senza stake o addebito. Una
  quota archiviata non certifica la possibilità di giocarla ora.
- `POST /api/results/refresh`: recupera risultati finali e liquida giocate
  virtuali già esistenti. Non avvia la Nightly, non ricalcola decisioni A/C
  e non recupera astensioni precedenti.

Le route legacy di budget/giocata non possono essere usate per indirizzare
silenziosamente una scrittura verso A o C; usare le API dedicate.

## Diagnosi e manutenzione

L'import alternativo della Nightly è opt-in e richiede target/mapping verificati
e cache condivisa già inizializzata. Conserva gli xG originali e le quarantene,
aggiorna le medie prima delle previsioni e decide separatamente per famiglia e
mercato. Una fonte supplementare non disponibile non cancella le osservazioni
esistenti. La manutenzione non ricalibra A automaticamente: un profilo non
compatibile produce astensione, mentre C può continuare se ammissibile. Le
liquidazioni delle puntate esistenti precedono l'ammissione delle nuove.

In modalità alternativa non si avviano refresh delle seconde divisioni o
learning review, raccolta forecast dei challenger o rollback automatico del
champion C. Un errore C resta tracciato e produce astensione; non cambia
silenziosamente la versione adottata. Le API esistenti restano separate. Il nuovo import CSV riguarda
le statistiche ammesse, senza convertire le quote di chiusura storiche in prezzi
eseguibili. Le quote correnti restano di The Odds API, con budget/scope e
provenienza reali. Vedere la [procedura controllata](../github-actions-nightly-sync.md#preparare-il-passaggio-alle-fonti-alternative).

Il batch dell'audit prediction esclude le fixture senza risultato e lascia
irrisolti i mercati con osservazioni mancanti, proseguendo verso le successive
prediction liquidabili. Il limite conta i match con almeno una liquidazione:
il numero di match esaminati può essere maggiore. Non cambia la liquidazione
dei portafogli A/C né ricostruisce statistiche mancanti.

Distinguere quattro verifiche: raggiungibilità API, esecuzione completa
Nightly, contabilità DB e comportamento browser/Android. Un healthcheck
riuscito prova soltanto che il servizio risponde. Zero nuove giocate può
essere una corretta astensione; una contabilità integra non prova che la
fonte dati abbia sincronizzato.

Per errori Understat o quote usare la [procedura Nightly](../github-actions-nightly-sync.md#recupero-controllato):
prima diagnosi e piano, poi il percorso autorizzato con guard, kickoff
futuro e idempotenza. Non riattivare fonti ritirate, non abbassare i gate
per produrre una giocata e non rigiocare movimenti già presenti.

Il processo CLI `backend/scripts/research-worker.js` è ritirato: emette
`worker_retired` e termina con uscita 0. Non è un worker persistente da
configurare su Hostless. La Nightly è un job finito GitHub; il suo watchdog
controlla job e DB, senza richiedere heartbeat T−15.

Prima di interventi su DB verificare identità del canonico condiviso e
[backup ripristinabile](turso-backup.md). Migrazioni, restore remoti,
modifiche ai saldi, deploy e distribuzioni seguono il proprio mandato:
questa guida non attiva operazioni esterne. Non eliminare dati o schema
per ridurre letture, correggere un pannello o ripulire la documentazione.
