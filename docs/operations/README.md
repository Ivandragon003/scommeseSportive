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

Partite, Giocate, Budget e Archivio riusano i due portafogli persistenti A/C
tramite `GET /api/wallets` e `GET /api/wallets/archive`. Non aprono un secondo
capitale durante la navigazione. A e C restano separati. Le giocate del
registro deterministico precedente hanno identità esplicita di modello A
(`model_family='A'`, portafoglio `legacy_deterministic_A`); capitale e ledger
restano distinti da quelli dei portafogli `shadow_A` e `shadow_C`.
La UI distingue registrazioni manuali, Nightly e opportunità archiviate.
Aggregati, filtri temporali e dettagli paginati/limitati hanno significati
diversi: una lista parziale non sostituisce il totale del portafoglio.

La Nightly registra al massimo una giocata per partita/famiglia, usa lo stake
consigliato per A e 1% per C e limita l'esposizione al 5%. Le azioni manuali
usano gli stessi saldi e i controlli di unicità/esposizione, con importo
scelto dall'utente. Questi registri rappresentano denaro virtuale: il software
non trasmette puntate a un bookmaker.

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
