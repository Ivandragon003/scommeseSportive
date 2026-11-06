# Operazioni dell'applicazione

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

Partite, Giocate, Budget e Archivio leggono le nuove selezioni automatiche A/C
tramite `GET /api/paper-bets`: ogni selezione usa **1 unità virtuale**, senza
saldo, capitale iniziale, percentuali o limiti di esposizione. A e C restano
separati. Il registro paper non apre un altro capitale e non sposta fondi.
Lo storico precedente resta consultabile separatamente tramite `GET /api/wallets`
e `GET /api/wallets/archive`. Le giocate del
registro deterministico precedente hanno identità esplicita di modello A
(`model_family='A'`, portafoglio `legacy_deterministic_A`); capitale e ledger
restano distinti da quelli dei portafogli `shadow_A` e `shadow_C`.
La UI distingue registrazioni manuali, Nightly e opportunità archiviate.
Aggregati, filtri temporali e dettagli paginati/limitati hanno significati
diversi: una lista parziale non sostituisce il totale del portafoglio.

La Nightly automatica usa la policy separata `paper-fixed-unit-v1`: considera
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

Il profitto è il ritorno meno 1 unità per selezione liquidata; il ROI è
`100 × profitto / unità delle selezioni liquidate`. Le puntate aperte hanno
un conteggio separato. Vittorie parziali e perdite parziali usano il ritorno
effettivo; gli annullamenti restituiscono 1 unità e non sono successi.
I calcoli in unità usano il moltiplicatore originale del settlement:
una mezza vincita a quota 2,01 restituisce 1,505 unità. I campi interni in
centesimi restano per compatibilità e verifica, senza arrotondare il ROI.
La percentuale di successo esclude gli annullamenti. Le metriche non mescolano
le unità nuove con i saldi e gli importi dei registri precedenti.

La migrazione **additiva 028** introduce `paper_model_bets` e liquidazioni
immutabili, senza riscrivere lo storico. Deve essere applicata al DB operativo
solo dopo backup e autorizzazione distinta. Prima della preparazione,
`GET /api/paper-bets` risponde 503 `paper_schema_required`, non un falso elenco vuoto.
La manutenzione dello storico può continuare se entrambe le tabelle paper
sono assenti e non è mai stata registrata una policy paper. Questo caso è
esplicito (`NOT_INITIALIZED`); schema parziale, precedente attivazione e
errori di connessione restano errori. La Nightly paper richiede sempre 028.
Il percorso automatico non crea movimenti di apertura né consulta saldi.
Le azioni manuali precedenti mantengono contabilità e vincoli originali,
accessibili con scelta esplicita. Nessun percorso trasmette puntate a un bookmaker.

Restano obbligatori dati affidabili, quota reale recente, identità, timing
prepartita, configurazione/versione del modello, idempotenza e budget API.
I mercati disabilitati e i player props non diventano automaticamente ammessi.
La modalità paper sopprime la registrazione prospettica opzionale delle sue
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
[policy Nightly](../../backend/src/research/ResearchRecommendationPolicy.ts).

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
minuti), partita futura, mercato liquidabile, saldo ed esposizione validi;
i controlli vengono ripetuti nella transazione. Un conflitto richiede di
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
