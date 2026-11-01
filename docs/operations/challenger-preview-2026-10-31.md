# Anteprima C senza registrare puntate — 31 ottobre 2026

## Comportamento e confini

La pagina Partite continua a calcolare A attraverso il percorso esistente. Se A
ha una decisione Nightly, mostra quella decisione archiviata. Il motore operativo
`PredictionService`, la sua calibrazione, mercati, filtri, ranking e stake non
sono modificati. La baseline research A80 non viene usata come anteprima di A.

Per C, il frontend legge prima l'archivio autenticato. Se la lettura riesce,
manca C e la partita è futura e non conclusa, richiede automaticamente la nuova
anteprima. Un errore nella lettura dell'archivio blocca il ripiego. Un consiglio
archiviato resta prioritario e non viene ricalcolato. A e C caricano separatamente:
un errore o un'attesa di C non impedisce la visualizzazione del consiglio A.

La scheda mostra **Anteprima C · non registrata**, eventuale giocata, bookmaker,
quota reale, orario e stake indicativo **1%**. Non mostra un importo addebitato.
La Nightly ricalcola al proprio orario: dati e quote aggiornati possono produrre
un consiglio diverso dall'anteprima.
Indisponibilità tecnica, partita non ammissibile e nessuna puntata consigliata
sono stati distinti. La scadenza nasconde il prezzo e permette un nuovo tentativo
manuale; non avvia richieste automatiche ripetute al provider.

## Contratto e origine

`POST /api/research/challenger-preview` usa la sessione amministratore e i
controlli di origine esistenti, accetta soltanto `{ "matchId": "…" }` e risponde
con `Cache-Control: no-store`. Il client non può scegliere orario, modello o quota.

Il servizio legge l'adozione C effettiva e blocca versione, revisione e selettore
per la durata del calcolo. Usa il percorso C operativo di `ResearchRuntime` e
`buildChallengerRecommendation`, senza eseguire `PredictionService` né calcolare
forecast research A80. Usa il momento corrente, non la scadenza storica T−15.
Artefatto e registrazione C richiedono timestamp espliciti, validi e non futuri.

Servono partita futura Top 5, squadre identificabili, quote autentiche
`odds_api` pre-match entro cinque minuti e condizioni del selettore operativo.
Letture fallite del registro, sospensione, quote mancanti/scadute o dati
insufficienti non vengono tradotti in un finto consiglio di non puntare.

La risposta include `kind=C_PREVIEW`, `family=C`, `registered=false`,
`suggestedStakePercent=1`, versione/revisione e scadenza. Non include identificatore
di puntata o azione di esecuzione. Le verifiche finali rileggono partita, adozione
e archivio prima della consegna, anche dopo cache o richieste condivise.

## Effetti ammessi e quote

Non vengono creati o modificati puntate, ledger, forecast, residui, osservazioni
prospettiche, job, adozioni o kickoff. Il percorso non avvia scheduler, rollback,
raccolta del candidato o diagnostica persistente del runtime research.
Le anteprime non allargano il campione di validazione prospettica di C.

Il gestore quote esistente può aggiornare **cache tecnica e contabilità API**:
non è quindi una promessa di zero scritture SQL. Le richieste sono informative,
entro il tetto configurato e rispettano la riserva Nightly. Il flag specifico
`CHALLENGER_PREVIEW_NETWORK_ENABLED=true` consente quote aggiornate; `false`
accetta soltanto cache fresca. Il flag informativo generale e A restano invariati.
Nessuna nuova chiave o fonte a pagamento è necessaria o introdotta.

La cache C dura al massimo 30 secondi. La validità del consiglio è separata:
massimo cinque minuti dal forecast, dalla cattura e dall'aggiornamento della quota,
sempre prima del kickoff. La cache termina prima di questa scadenza,
contiene al massimo 100 risultati e non conserva errori tecnici. Sono ammessi
al massimo due calcoli distinti simultanei; richieste identiche condividono il
calcolo. La decisione Nightly è ricontrollata prima di restituire un risultato.

La schermata verifica prima l'archivio C, calcola eventualmente l'anteprima C e
poi avvia A, per evitare i due calcoli simultanei sul piano gratuito. A mantiene
gli stessi input e il proprio motore. Dal 1 novembre il client avvia A con una
richiesta breve e recupera il risultato senza tenere aperta una connessione oltre
il limite Cloudflare; il calcolo resta identico. Il replay conserva il trasporto
precedente. [Correzioni UI e risultati](production-ui-and-results-2026-10-31.md).

## Verifiche e rilascio

I test dedicati coprono inferenza C senza effetti economici/research, modello
operativo bloccato, quote reali, stati di astensione e indisponibilità, corse con
Nightly/adozione/kickoff, cache/concorrenza, contratto HTTP, errori redatti e UI
indipendente da A. La regressione A confronta i sorgenti protetti e gli scenari
golden esistenti, senza modificarne hash o risultati attesi.

Il commit applicativo usa il marcatore `[c-preview-only]`: la sola integrazione
C nella route condivisa non deve avviare il workflow push di riscaldamento della
calibrazione A. L'avvio manuale e gli altri push mantengono il comportamento
precedente. Non è una disattivazione della Nightly o della CI.

Sorgente applicativa: `6d9ea1c6f53e19f5a20a0e97a137043ba20b269a`.

| Controllo | Risultato |
|---|---|
| Nuovi test backend + regressione A | 55 passati: runtime 16, servizio 22, route 10, A 7 |
| Isolamento A/C nello stesso processo | Ulteriore test passato, insieme alle 7 regressioni A: 8/8 |
| Suite backend completa in CI Linux, ultimo commit di test | 1.234 passati, zero falliti, uno opzionale saltato |
| Frontend da worktree pulito | 34 suite / 295 test passati; typecheck, lint e build passati |
| Revisione indipendente del diff | Nessun P1/P2 residuo confermato; race cache/Nightly riprodotta e corretta |
| Browser desktop/mobile con API simulate | 15 scenari passati, nessun overflow; risposte tardive isolate |
| Docker Compose isolato | Build e avvio backend/frontend; health e sito 200; anteprima senza sessione 401, con sessione 200/NOT_ELIGIBLE; override orario 400; no-store |
| Android 1.1.6/code 8 | Build, firma, 19 asset, aggiornamento con dati preservati e 2 test strumentali passati |

[CI della sorgente applicativa, 1.233 passati](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41217415031)
e [CI con la regressione aggiuntiva, 1.234 passati](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41219156825).
Lo skip riguarda il test opzionale di training/parità con Python CatBoost,
non A o l'anteprima. Il workflow di calibrazione A è stato saltato come previsto.
Le 7 regressioni A verificano hash di 36 sorgenti protetti e 6 scenari golden,
senza modificarne manifest o risultati attesi.

Il commit di soli test `b98147bbe5b8f4aeb9d559f3f8c40973e2c2f3a6` aggiunge
`challenger-preview-a-isolation.test.js`, senza differenze nei sorgenti runtime
web/Android rispetto a `6d9ea1c6`. Esegue vera preparazione C con dati sintetici,
fit della baseline, inferenza CatBoost, calibrazione e blending, poi entrambi
i selettori C. I sei scenari golden A sono identici prima e dopo; configurazioni,
ambiente e `Date` invariati, zero uso del generatore casuale globale durante C.
Il test rifiuta scritture research, letture dell'altro modello e chiamate esterne.
Questa prova protegge anche la coesistenza nello stesso processo web, oltre
all'identità dei sorgenti A. L'ambiente è confrontato tramite hash, evitando
segreti nei messaggi di eventuale errore.

La revisione ha trovato una race ripetibile: una risposta in cache poteva
ignorare la decisione Nightly pubblicata durante la lettura del deployment.
Ora ogni chiamante, compresi cache e richieste condivise, rilegge fixture,
deployment e infine archivio come ultima lettura asincrona. Riproduzione
indipendente dopo il fix: `ARCHIVED`, una sola inferenza, nessuna scrittura business.

La QA browser ha intercettato 136 richieste nel pass principale e 14 nel controllo
aggiuntivo, tutte simulate: nessun provider reale, endpoint inatteso, richiesta
di registrazione/liquidazione o scrittura forecast. Verificati errori archivio,
retry, scadenza senza rinnovo automatico, priorità Nightly, ARCHIVED/refetch senza
cicli e indipendenza dall'analisi A anche quando A fallisce o C attende. La prova
browser osserva l'isolamento delle risposte tardive; la cancellazione del trasporto
non è attestabile dal routing simulato. Il segnale AbortSignal è coperto dai test.

Il runtime Docker usa un progetto e porte loopback separati (3300/3301), libSQL
locale, credenziale QA e chiave provider fittizia con rete quote disabilitata:
non modifica gli stack esistenti né usa credenziali produzione.
Il gate completo Windows è stato interrotto due volte da `EPERM` nel cleanup
SQLite del test invariato `research-recommendation-view.test.js`. La suite completa
è invece passata su Linux in CI: non viene dichiarato un pass completo su Windows.

[Verifiche APK 1.1.6](../android/releases/1.1.6-2026-10-31.md). Restano non verificati
telefono fisico e flusso A/C nativo autenticato. Queste sono prove funzionali;
non dimostrano miglioramenti statistici o di redditività del modello.

### Prova diretta con dati reali

Alle 16:09 UTC è stato invocato **una sola volta** il servizio locale compilato
dalla stessa sorgente, con dati e configurazione reali, su una partita futura
di Serie A senza decisione C operativa (`understat_31653`, kickoff 1 novembre
11:30 UTC). Il risultato è `RECOMMENDED`, `registered=false`, C906/revisione
`initial`, selettore `canonical-binary-v1`. Hash dell'artefatto e timestamp
di artefatto/registrazione sono stati controllati prima del calcolo.

La quota proviene da `odds_api`, pre-match: aggiornata alle `16:09:11Z`,
catturata alle `16:09:36.756Z`, previsione alle `16:09:44.244Z`. Non vengono
pubblicati selezione e prezzo della futura giocata. Il gestore ha registrato
una richiesta riuscita con priorità informativa e consumo di 3 crediti
(contatore provider 282→285), senza intaccare la riserva configurata.

Un blocco sul client libSQL condiviso impediva scritture business: **zero
tentativi**. Prima/dopo, hash integrali di 24 tabelle business identici;
`predictions` legacy, molto ampia, confrontata soltanto per conteggio, limite
esplicito. Ammessi 16 statement tecnici `smart_odds_*`. I 32 bootstrap di trigger
già esistenti sono stati verificati tramite SELECT e trattati come no-op nella
sonda, senza eseguire DDL. Non è stata invocata l'analisi A.

È una prova del servizio con dati e quote reali, **non** dell'endpoint HTTP
autenticato in produzione, del telefono fisico o della redditività. Le prove
browser e native sopra restano distinte e usano dati simulati o la pagina login.

### Ripetere i controlli senza provider

Alla sorgente indicata, nella directory `backend`, `npm test` comprende build e suite completa;
`npm run typecheck` e `npm run lint` completano il gate. I soli test nuovi e la
regressione A si possono ripetere, dopo la build, dalla directory backend:

```sh
node --test test/challenger-preview-runtime.test.js test/challenger-preview-service.test.js test/challenger-preview-routes.test.js test/operational-a-regression.test.js
```

Dal frontend pulito: `npm ci`, `npm run test:ci -- --runInBand`,
`npm run typecheck`, `npm run lint`, `npm run build`. I test dedicati non richiedono
credenziali o quote reali e non registrano puntate. Una nuova sonda reale consuma
eventualmente crediti informativi: non è necessaria per questi controlli.
Dal commit aggiuntivo di test si può eseguire anche
`node --test test/challenger-preview-a-isolation.test.js test/operational-a-regression.test.js`
dalla directory backend, dopo la build.

## Pubblicazione verificata

- Commit applicativo `6d9ea1c6f53e19f5a20a0e97a137043ba20b269a` pubblicato su GitHub.
- Backend Hostless [deployment 226a6a5a](https://hostless.cloud/apps/scommese-sportive-backend/deployments/6ae611c158c3b12e226a6a5a):
  **Deployed LIVE** su `6d9ea1c`, health pubblico HTTP 200 alle `16:13:45.805Z`.
- Frontend Hostless [deployment f0d3fd5f](https://hostless.cloud/sites/scommese-sportive-frontend/deployments/6ae612731af23518f0d3fd5f):
  **Deployed LIVE** sulla stessa sorgente. Manifest pubblico HTTP 200; asset
  `main.49fdec22.js`, SHA-256 `244114fc34d33c350afbffa37b64943c20759eb6c3894d050503c771ce2ed96d`.
  Confrontati via source map i sei sorgenti runtime interessati, incluso
  `walletApi.ts` dalla copia Git pulita: tutti coincidono. Le stringhe e la route
  della nuova anteprima sono presenti nel bundle servito.
- APK [1.1.6 di prova](https://github.com/Ivandragon003/scommeseSportive/releases/tag/android-v1.1.6-debug-20261031)
  pubblicato con tag sul commit applicativo completo; file e checksum riscaricati
  da GitHub coincidono con l'APK verificato. La build Android usa
  `main.491d309b.js`: web cloud e APK hanno build diverse, non viene dichiarata
  identità binaria tra i due bundle.

Il deploy riusa ambiente, quote di risorse e scheduler esistenti; nessuna nuova
migrazione, chiave provider o modifica ad A. Il flag dedicato C usa il default
documentato, senza attivare la rete informativa generale di A. La calibrazione A
non è stata riscaldata dal push. Le modifiche locali ai due file wallet,
estranee a questo lavoro, restano escluse da commit, build e APK.

La prova reale sopra è diretta sul servizio; l'endpoint distribuito non è stato
invocato con la sessione amministratore dell'utente. Health, sorgenti serviti e
stato LIVE non vengono confusi con questa prova autenticata ancora assente.
I container, server/browser QA e l'emulatore creati/usati per le prove sono stati
fermati; gli stack locali preesistenti sono rimasti attivi.
