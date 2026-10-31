# System design di FootPredictor

**Audit dei dati C.** Il [controllo del 31 ottobre](performance/c-data-benchmark-audit-2026-10-31.md)
ha dimostrato errori di calendario nel vecchio benchmark. Un manifesto C
versionato isola 22 record; soltanto i nuovi artefatti con policy dichiarata
e baseline ricostruita usano questa storia filtrata. A operativo e il default
C906 conservano i percorsi precedenti. La qualità dei dati è parte del dossier
candidato e non viene dedotta dal solo accordo con Understat.

**Aggiornamento C del 31 ottobre 2026.** Il percorso candidato usa input
Nightly, feature versionate e un selettore C autonomo per i payout completi.
C906 legacy resta il default; un registro append-only separato raccoglie
confronti futuri e governa adozione/rollback della sola tupla C. A operativo
non cambia. Sono applicati il registro additivo 025 e la preregistrazione
della candidata, senza movimenti nei portafogli; la prima raccolta Nightly
è ancora da osservare. Il [report](performance/c-hybrid-improvements-2026-10-31.md)
distingue implementazione, prove di sviluppo e verifica futura.

**Architettura verificata sui sorgenti del 30 ottobre 2026: percorsi A/C distinti.**
A usa il `PredictionService` esistente, inclusi cartellini e tiri quando
coperti da dati e quote reali; C conserva il catalogo gol concordato.
L'automazione esegue i consigli prodotti dai due percorsi e applica soltanto
i controlli tecnici e contabili. Non definisce un terzo modello o un insieme
obbligatoriamente comune di mercati. C906 legacy riusa le funzioni di valutazione
`ValueBettingEngine` e il picker canonico, con le proprie probabilità e senza
una seconda calibrazione o un secondo blend: i due algoritmi non sono due
codebase interamente separate.

Le guide separate [Modello A](models/MODEL-A.md) e [Modello C](models/MODEL-C.md)
descrivono input, formule, mercati, scelta, importi e limiti;
l'[indice dei modelli](models/README.md) mostra anche i componenti condivisi.
Il codice v2 è pubblicato e la Nightly `41098979782` è riuscita, con quattro
puntate virtuali A e due C. La conferma LIVE dei deploy web richiesti resta
distinta da quel riscontro. Per stato e cronologia del rilascio usare la
[Specifica corrente](operations/recommendation-execution-2026-10-30.md).

## Snapshot storici delle attivazioni precedenti

I paragrafi seguenti conservano le verifiche delle diverse fasi del 30 ottobre.
I conteggi delle cinque puntate v1 e gli stati intermedi dei deploy non sono
lo stato successivo al ritiro v1 e alla nuova esecuzione v2; valgono per il
momento descritto. Il ritiro e la nuova Nightly sono documentati nella
[correzione operativa](operations/nightly-engine-correction-2026-10-30.md).

**Portafogli nelle pagine normali dell’app — integrazione locale in verifica.**
Il nuovo requisito porta A/C in **Giocate, Budget e Archivio**, con filtro per
modello e confronto. Sono gli stessi portafogli e le stesse cinque BET già
finanziate: nessuna copia, migrazione, nuova puntata o addebito. La lettura
`GET /api/wallets` riusa il confronto contabile esistente; aggregati completi
e dettaglio limitato a 500 righe sono distinti. Lo storico precedente di 258
giocate resta consultabile separatamente, senza attribuirlo ad A o sommarne
il capitale. Research rimane dedicato a benchmark e modelli, non alla gestione
dei saldi. Questa integrazione non è ancora attestata LIVE: lo snapshot
cloud qui sotto riguarda la UI precedente e la policy v1 già attiva. La sola
integrazione della navigazione non cambia modelli e infrastruttura; la
correzione locale v2 dei mercati è descritta separatamente sopra.

Codice `7f9ab7cf2f10938a8fd52421eb7df2994afe338f` pubblicato su main;
CI `41085821060` Backend/Frontend SUCCESS. Gate locale: backend Linux Node20
1.024 test totali, 1.023 PASS e uno SKIP opzionale di training. Il cleanup
frontend finale `225e8c0b81468fa58f86559ae1f641410ae2278f` è pubblicato:
rimuove il vecchio pannello autonomo ormai irraggiungibile e relativi wrapper/test,
senza modifiche backend. Gate frontend finale: 32 suite/229 test PASS,
typecheck/lint e dieci controlli mirati PASS; 239 test era il gate prima della
rimozione di due suite obsolete. CI e deployment di questo ultimo frontend
restano da attestare. Compose isolato e controlli delle cinque BET reali,
filtri A3/C2, saldi e pacchetti congelati superati; undici hash finanziari e
storici invariati prima/dopo, nessun POST legacy osservato in Nginx.
Il backend Hostless `6ae4bf80475f3a60ae37bd72`, richiesto alle 16:02 UTC
(17:02 Roma), è ancora **Queued**: questa integrazione non è LIVE. Frontend
remoto ancora `3c503fa9`; auto-deploy OFF e risorse invariati. Il precheck
remoto conferma cinque BET, sette movimenti, 258 legacy e 24 righe in `schema_migrations`.

**Snapshot cloud prima dell’integrazione nelle pagine normali, 30 ottobre 2026.** Backend `eb5d838e`
LIVE, deployment `6ae4984bb53426f1e55ec75c`; frontend `3c503fa9` LIVE,
deployment `6ae49cd1e2d5898dc9ef7bb2`. Variabile GitHub `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` verificata.
Run reale `41069572500` SUCCESS: cinque partite, dieci decisioni e cinque
puntate virtuali, tre A e due C. Audit RO 71/71 PASS. A disponibile 955,80 euro,
impegnato 44,20; C disponibile 980 euro, impegnato 20; equity 1.000 euro ciascuno.
Stake A 0,42%/1,8%/2,2%, C 1%, esposizione massima 5% rispettata, senza promozione C.

Quote reali Codere IT/Betsson, fresche 51,6–79,3 secondi alla decisione. Provider
325 usati/175 residui osservati alle 14:16:55 UTC. Il suo stato DEGRADED include
l’unico errore mensile precedente nel ledger; ultima acquisizione SUCCESS
14:16:54 UTC. Lo stato non viene ripulito o dichiarato tutto verde.
Watchdog automatico `41070547360` SUCCESS (GitHub/DB `ok=true`, `issues=[]`,
Nightly SUCCESS/non scaduta). Duplicato `41071349342` SUCCESS con gate
`daily_sync_already_succeeded` e ciclo applicativo/provider saltato.
Controllo RO dopo il duplicato: invariati 5 BET, 7 movimenti, 5 job, 10 decisioni,
saldi e 325/175 crediti.
Pagina Partite autenticata verificata: Le Havre–PSG, A quota 8 Codere IT,
importo archiviato 4,20 euro, uguale alla Nightly. Risultati/liquidazioni e
primo trigger programmato restano da osservare; il ciclo sportivo non è completo.
APK Android non aggiornato, keystore originale assente; nessun piano/provider
cambiato, servizio a pagamento aggiunto o T−15 operativo.
Rollback delle nuove puntate: `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=false`,
workflow completo attivo e backend compatibile con la 023. Il POST `/api/research/settle`
precede il gate A/C; sola CLI diagnostica o retry saltato non garantiscono
liquidazioni. Non fermare il processo completo confidando in quei soli percorsi.
[Specifica e avanzamento](operations/recommendation-execution-2026-10-30.md)


Aggiornato al 30 ottobre 2026: **Nightly Pre-Match Virtual Betting**.
La [guida canonica](operations/nightly-pre-match-2026-10-29.md) definisce
configurazione, gate e attivazione. La nuova nightly A/C e la dashboard sono pubblicate. Il backend attuale `eb5d838e`
è LIVE sul Turso personale dopo Resume e deploy del nuovo ambiente; health,
route legacy HTTP 410, login, sessione e dashboard A/C sono verificati. Il cutover è
effettivo, sulla baseline del dump 15:17 UTC adottata con autorizzazione e
accettazione dei delta sorgente successivi non verificabili.

La prima fase del30 ottobre (run delle10:12 UTC, antecedente alla nuova policy)
usava il backend `013209419ef25b949525485a92fb0448ed5d6b8b`, allora LIVE,
deployment `6ae468ad1a67b8db20f91272`, con minuto 7 e chiave write-only caricati.
Quota riconciliata alle 10:01:04 UTC; registrazione A/C attiva dalle 10:04 UTC.
Run `41038096151` SUCCESS: quattro partite reali, otto decisioni/inferenze e
quattro snapshot condivisi; tutte astensioni, zero BET/errori/API errori.
Sono congelate 58 osservazioni CALIBRATION su quattro incontri; nessun nuovo
FUTURE_TEST o campione prudenziale completato. A riferimento, C Challenger,
portafogli 1.000 euro ciascuno senza impegnato; 258 giocate legacy preservate.
Il duplicato ha saltato il ciclo prima di npm/build e DB/provider; audit RO del duplicato PASS alle 10:22:18 UTC, senza nuovi run DB
o record provider. Watchdog `41039066641` e `41039490287` SUCCESS. Frontend
`fb0e30f8` Deployed LIVE, Site Running, deployment `6ae46ff81a67b8db20fa2f2e`,
CI `41039799271` SUCCESS. Restano da osservare il trigger programmato
31 ottobre 03:07 e risultati/liquidazioni reali. Vedi il [recupero](operations/nightly-recovery-2026-10-30.md).

Snapshot browser dopo il LIVE, prima del recupero Nice–Rennes: sessione autenticata conservata, Sistema
mostra Riuscita alle 11:12 Roma, quattro partite e zero errori/API errori.
Prossimo run 31 ottobre 03:07 e testo «Orario di riferimento: 03:07 Europe/Rome»
verificati; quota 196 residui/304 usati e database raggiungibile. Le prove
restano private; questa è verifica dell'app effettiva, oltre al badge Hostless.

**Snapshot recupero calendario,30 ottobre 11:08 UTC, prima della nuova policy:** il verde precedente copriva
quattro incontri su cinque. `41044931407` su `fd97d145` è SUCCESS 11:08:12 UTC,
CI Backend/Frontend `41044683537` SUCCESS. Con cinque GET eventi gratuiti sono
controllati 800 record e corretti 43 kickoff futuri, incluso Nice–Rennes:
31 ottobre 16:15 UTC→30 ottobre 18:00 UTC, oggi 19:00 Roma.
A/C ha valutato solo il nuovo incontro, aggiungendo due decisioni e 16
osservazioni, zero BET/errori/API errori/missed. Quattro incontri esistenti
esclusi prima di quote/inferenza. Audit RO 11:10:02 PASS: cinque input e dieci
decisioni/marker cumulativi; quattro input e otto decisioni precedenti invariati.
Wallet 1.000 euro ciascuno, zero impegnati, 258 legacy e sette hash finanziari
preservati. Una richiesta quote da 3 crediti porta a 307 usati/193 residui.
Backend `01320941` e UI `fb0e30f8` erano allora LIVE: quella correzione non
richiedeva deploy web; il rilascio attuale eb5/3c è distinto.
[Report](operations/nightly-fixture-recovery-2026-10-30.md); cron 31 ottobre 03:07
e ciclo ufficiale risultato/liquidazione ancora da osservare.

Hostless, GitHub Actions e Turso restano i componenti. Non occorre il worker
T−15 sempre acceso. I precedenti
[report operativi](operations/production-status-2026-10-29.md) restano snapshot
storici, superati per la direzione di automazione; benchmark e risultati
scientifici non vengono riscritti. C resta Challenger e nessuna puntata usa
denaro reale. La guida canonica conserva l'esito del primo job e dei cicli
successivi quando effettivamente disponibili.

## 1. Scopo e confini del sistema

FootPredictor è una web app per analizzare partite di calcio prima del loro inizio, confrontare probabilità statistiche con quote bookmaker reali e conservare le decisioni e i risultati.

Il ciclo principale è:

**Dati calcistici → statistiche derivate → probabilità → confronto con quote reali → consiglio → registrazione interna → verifica dell'esito.**

L'app comprende anche budget condiviso, archivio delle opportunità, replay delle partite concluse, backtest e strumenti di controllo dei dati.

L'estensione A/C aggiunge un confronto cronologico tra il nucleo statistico A e
un candidato ibrido CatBoost C, registri di validazione e due portafogli virtuali
separati. I componenti e i limiti di attivazione sono documentati in
[piattaforma sperimentale A/C](research-platform.md). La presenza di codice ML
non dimostra una superiorità predittiva né un'automazione remota attiva.

La registrazione di una giocata modifica il registro e il budget dell'app. Non invia una puntata a un bookmaker e non movimenta denaro esterno. Non è presente un collegamento per eseguire scommesse sui siti degli operatori.

## 2. Architettura generale

Il sistema è un **monolite modulare**: un solo backend contiene moduli con responsabilità distinte. Frontend, backend e database sono separati, ma importazione, previsione, quote e gestione delle giocate appartengono alla stessa applicazione backend.

```mermaid
flowchart TB
    U[Utente] --> W[Browser con frontend React]
    U --> A[App Android con React e Capacitor]
    W -->|HTTPS / API JSON| B[Backend Node.js / Express / TypeScript]
    A -->|HTTPS / API JSON| B
    B <-->|Letture e scritture libSQL| D[(Database condiviso Turso / libSQL)]
    B -->|Statistiche e calendario| US[Understat]
    B -->|Supplemento CSV e quote storiche| FD[football-data.co.uk]
    B -->|Quote bookmaker e orari eventi| O[The Odds API]
    B -.->|Solo se abilitato: disponibilità e formazioni| AF[API-Football]
    G[GitHub Actions] -->|Avvia una copia temporanea del backend| T[Backend temporaneo e job nightly sul runner]
    T <-->|Stesso database configurato| D
    T --> US
    T --> FD
    T --> O
```

La copia sul runner GitHub usa lo stesso progetto backend, non un servizio indipendente con una propria logica o un proprio archivio. Serve per svolgere gli aggiornamenti e i calcoli programmati senza dipendere dal processo web ospitato.

| Componente | Responsabilità | Non gli compete |
|---|---|---|
| Frontend React | Navigazione, selezione partita, richiesta di analisi, presentazione di quote, consigli e stato delle operazioni | Accedere direttamente al DB o custodire credenziali dei provider |
| App Android | Eseguire la stessa interfaccia web in un contenitore nativo | Mantenere un bankroll indipendente o un backend separato |
| API Express | Ricevere richieste, controllare accesso e parametri, collegare le funzionalità | Essere il luogo dei modelli statistici |
| Servizi applicativi | Coordinare import, previsioni, quote, archivio, budget e verifiche | Sostituire una quota mancante con una quota bookmaker inventata |
| Modelli statistici e motore decisionale | Stimare probabilità, valutare rischio e opportunità, scegliere il consiglio | Recuperare autonomamente dati dal browser dell'utente |
| Livello database | Persistenza, query, aggiornamenti coerenti e migrazioni dello schema | Decidere quali mercati siano validi come prodotto |
| GitHub Actions | Aggiornamenti, calibrazione, decisioni virtuali A/C opt-in, liquidazioni e controlli CI | Servire l’interfaccia agli utenti |

## 3. Interfaccia e comunicazione con il backend

Le sezioni principali sono:

- **Partite:** calendario, quote e analisi della partita selezionata.
- **Giocate:** registrazioni aperte e storico degli esiti.
- **Budget:** capitale interno, disponibilità e andamento.
- **Archivio giocate:** opportunità operative e salvate a fini di analisi.
- **Backtest:** valutazione storica del modello.
- **Centro dati:** dati importati, fonti, sincronizzazione e integrità.
- **Confronto A/C nella UI LIVE precedente:** saldi e rendimento A/C erano raccolti nella vista dedicata, insieme al benchmark e allo stato nightly. La nuova integrazione locale, ancora in verifica, porta la gestione contabile in Giocate/Budget/Archivio con filtri A/C e confronto; Research conserva benchmark, modelli e stato tecnico.
- **Glossario:** spiegazione dei termini mostrati nell'app.

Il frontend comunica tramite richieste HTTP con risposte JSON. Le operazioni interattive ricevono la risposta dal backend; lo stato generale viene aggiornato anche con controlli periodici. Non è previsto un canale WebSocket per gli aggiornamenti in tempo reale.

Il browser conserva preferenze locali come il tema. Budget, giocate, opportunità e dati calcistici risiedono nel database condiviso. Due dispositivi vedono quindi gli stessi dati applicativi dopo il loro aggiornamento, se usano lo stesso backend e lo stesso utente condiviso.

Le cache del frontend evitano richieste identiche ravvicinate; il caricamento di più viste può condividere una richiesta già in corso. Le scritture pertinenti invalidano le letture memorizzate.

## 4. Moduli logici del backend

```mermaid
flowchart LR
    API[API e controllo accesso] --> I[Import e normalizzazione]
    API --> Q[Acquisizione e selezione quote]
    API --> P[Orchestrazione previsioni]
    API --> R[Archivio, giocate e budget]
    API --> V[Backtest e report]
    I --> S[Statistiche derivate e copertura]
    S --> P
    P --> M[Modelli e contesto partita]
    M --> C[Calibrazione e confronto col mercato]
    Q -->|Quote con provenienza| C
    C --> E[Filtri, ranking e consiglio]
    E --> R
    V --> M
    V --> C
    I --> DB[(Accesso dati condiviso)]
    Q --> DB
    P --> DB
    R --> DB
    V --> DB
```

Gli archi rappresentano dipendenze e passaggi di dati logici, non processi separati. Il modulo quote e quello previsioni sono coordinati dalle richieste applicative: il modello non deve conoscere le credenziali del provider.

| Modulo | Ruolo nel sistema |
|---|---|
| Import e normalizzazione | Trasforma le informazioni delle fonti in squadre, partite e statistiche coerenti con l'archivio interno |
| Statistiche derivate | Calcola medie, variabilità, copertura storica e profili utili ai modelli |
| Contesto della partita | Combina informazioni disponibili su squadre, calendario, arbitro e, quando abilitati, giocatori e assenze |
| Previsioni | Coordina caricamento dati, modelli, calibrazione, analisi delle quote e costruzione del risultato |
| Quote | Abbina gli eventi, normalizza mercati e selezioni, mantiene bookmaker, orario e fonte |
| Decisione | Filtra mercati non ammessi o fragili e ordina le opportunità in base a probabilità, quota, rischio e qualità dei dati |
| Archivio e budget | Collega analisi, decisioni, registrazioni e risultato economico interno |
| Validazione e learning | Esegue backtest e confronti post-partita; mantiene le analisi tecniche interne |
| Osservabilità | Raccoglie stato dei job, errori, tempi e stato delle fonti |

## 5. Fonti e importazione dei dati

### 5.1 Fonti distinte per responsabilità

| Fonte | Dati utilizzati | Regola principale |
|---|---|---|
| Understat | Squadre, calendario, risultati, xG, tiri e dati giocatore quando abilitati | Fonte primaria dei dati calcistici |
| football-data.co.uk | CSV con statistiche supplementari e quote storiche di apertura/chiusura disponibili | Riempie statistiche mancanti senza sovrascrivere quelle Understat; le quote hanno provenienza separata |
| The Odds API | Quote espresse dai bookmaker, eventi e relativi orari | Unico provider quote del runtime corrente; la disponibilità dipende da copertura e credenziali |
| API-Football | Rose, indisponibilità e formazioni nel percorso opzionale | Richiede abilitazione e configurazione; il percorso è in pausa per default |
| Riferimenti delle competizioni | Identità, stagioni e passaggi tra competizioni | Supportano integrità e contesto delle neopromosse; non sbloccano automaticamente nuovi mercati |

FotMob, Transfermarkt, FBref e lo scraper supplementare SofaScore non fanno parte del flusso dati attivo descritto qui.

### 5.2 Flusso di import

1. Si identifica la competizione e la finestra delle stagioni da mantenere: stagione corrente e quattro precedenti.
2. Understat fornisce le identità principali e i dati delle partite, distinguendo concluse e future.
3. Il sistema normalizza nomi, identificativi e date e aggiorna i record già esistenti.
4. Il supplemento CSV viene abbinato per data e alias squadra. Completa solo i campi statistici mancanti; conserva separatamente le quote storiche.
5. Si controlla la copertura, si aggiornano le statistiche derivate delle squadre coinvolte e si invalidano le cache interessate.
6. I risultati nuovi consentono di chiudere le previsioni e le giocate valutabili.

Gli aggiornamenti sono progettati per poter essere ripetuti: una partita già importata viene riconosciuta e aggiornata, evitando duplicazioni per la stessa identità. Le righe immutate vengono escluse dalle scritture dove previsto. La retention può eliminare partite fuori dalla finestra; dopo tale operazione le medie devono essere ricalcolate per non usare lo storico rimosso.

La presenza di un campo nel modello dati non prova che la fonte lo fornisca per ogni lega. In particolare, il supplemento non fornisce il possesso e la copertura dell'arbitro non è uniforme.

## 6. Quote: acquisizione, provenienza e disponibilità

Il recupero quote parte da una partita interna. Il sistema cerca l'evento corrispondente presso il provider usando squadre, competizione e orario; quindi collega le selezioni offerte ai mercati interni.

Uno **snapshot** è una fotografia delle quote raccolte in un determinato momento. Conserva il collegamento alla partita, la fonte, i bookmaker e i mercati disponibili. Snapshot diversi consentono di distinguere ciò che era disponibile in momenti diversi.

Possono essere usate quote di più bookmaker, mantenendo il bookmaker effettivo per ciascuna selezione. Il provider che trasporta il dato e il bookmaker che esprime la quota sono due soggetti distinti.

Prima di chiamare il provider, il percorso della singola partita può riutilizzare cache e snapshot compatibili, secondo le regole di freschezza applicabili. Se il provider non trova l'evento o il mercato richiesto, quel dato resta indisponibile: non esiste un secondo provider quote attivo come fallback.

Tutte le richieste HTTP a The Odds API attraversano ora un gestore persistente
nel medesimo database libSQL/Turso. Prima del trasporto prenota il costo stimato,
riusa una risposta ancora valida oppure acquisisce una lease esclusiva della
richiesta. La chiave normalizzata comprende endpoint e parametri, senza secrets.
Ciò condivide raccolta, budget e deduplicazione fra UI e job nightly,
anche dopo un riavvio o fra istanze concorrenti. Nessuna transazione DB resta
aperta durante la chiamata HTTP. I risultati conservano costo osservato negli
header, stime prudenziali quando manca, timestamp originari e motivo dei blocchi.

La migrazione additiva `018_smart_odds.sql` aggiunge registro richieste/risultati,
budget, cache, lease ed eventi. Il limite locale di pianificazione è 500 crediti
al mese, con riserva di 50 per le richieste essenziali: non è una misura del
residuo dell'account. Il consumo osservato resta sconosciuto fino agli header.
Il mese UTC è una convenzione locale; il reset del provider deve essere
riconciliato con una verifica gratuita, senza ricarica presunta.

Per default la UI è cache-only e `RUN_ODDS_SYNC=false` disabilita la raccolta
informativa generale. Il job opt-in di C mantiene il feed essenziale
`h2h`, `totals` e `spreads`, una regione. A riusa i prezzi base disponibili
e i mercati per evento configurati nell'app, con gli stessi controlli del
provider, senza una restrizione al catalogo di C. Cache, budget e provenienza
sono condivisi; la copertura dei due motori può differire.
Il calendario usa eventi gratuiti, senza richiedere prezzi o scores per il kickoff.

L'età massima iniziale della quota è 300 secondi alla decisione notturna,
controllando acquisizione e aggiornamento originario; non è un requisito di
quota a cinque minuti dal calcio d'inizio. Cache informativa di trenta minuti
non autorizza una decisione con prezzi scaduti. Budget insufficiente o assenza
di quota reale provocano astensione, senza abbassare la freschezza.

La proiezione `forecastRemainingNightlyOddsDemand` raggruppa lega/finestra
configurata in Europe/Rome (produzione 03:07), gestisce DST e mese contabile UTC ed esclude leghe senza incontri
previsti. È una stima, distinta dai crediti osservati dal provider. Il caso
teorico di cinque leghe per 31 notti costa 465 crediti; con 16 richieste retry
sale a 513 e richiede esclusioni entro il limite 500. Le precedenti stime
T−15 restano storiche. La [gestione quote](operations/smart-odds-2026-10-27.md)
distingue i due metodi e non garantisce copertura integrale gratuita.

Il sistema contiene anche stime e completamenti prodotti dal modello per analisi interne o replay. Questi non costituiscono quote bookmaker reali e non possono dimostrare convenienza, ROI o qualità rispetto al mercato. La UI deve distinguere gli stati e mostrare come indisponibile una quota reale assente.

## 7. Dalla partita al consiglio

```mermaid
sequenceDiagram
    actor U as Utente
    participant F as Frontend
    participant A as API
    participant Q as Modulo quote
    participant P as Servizio previsioni
    participant D as Database
    participant M as Modelli e decisione
    U->>F: Seleziona una partita e richiede l'analisi
    F->>A: Richiede le quote della partita
    A->>Q: Cerca quote compatibili e disponibili
    Q->>D: Legge o salva snapshot
    Q-->>A: Quote, bookmaker, fonte e stato
    A-->>F: Quote disponibili o indisponibilità
    F->>A: Richiede previsione con i dati della selezione
    A->>P: Avvia l'analisi
    P->>D: Legge squadre, storico e contesto
    P->>M: Stima probabilità e valuta le quote
    M-->>P: Opportunità, rischio e decisione
    P->>D: Salva evidenze delle probabilità se la partita è identificata
    P-->>A: Risultato dell'analisi
    A-->>F: Dati per la presentazione
    F-->>U: Consiglio principale e motivazione
```

Il processo decisionale ha questi passaggi:

1. **Preparazione:** recupera i dati delle due squadre, lo storico, la copertura e il contesto disponibile.
2. **Contesto:** gli input disponibili adattano l'analisi alla partita. Dati assenti o campioni deboli non vengono trattati come informazioni certe.
3. **Stima:** il modello Dixon-Coles descrive i goal delle squadre e i risultati possibili; un modello Poisson basato sugli xG contribuisce alle probabilità dei mercati goal. Modelli dedicati trattano statistiche come tiri e cartellini.
4. **Calibrazione:** le probabilità vengono corrette usando previsioni storiche prodotte in ordine temporale, per ridurre gli scostamenti sistematici dalle frequenze osservate.
5. **Confronto col mercato:** il sistema considera le quote reali, il margine del bookmaker e il blending, cioè la combinazione controllata tra stima statistica e informazione del mercato.
6. **Filtri e rischio:** valuta convenienza attesa, incertezza, copertura e fragilità. Calcola anche una proposta di importo rispetto al budget, con limiti prudenziali.
7. **Scelta finale:** seleziona un consiglio principale sui mercati squadra, con motivazione breve, oppure segnala che non ci sono condizioni adeguate per una giocata operativa.

La probabilità di un risultato, la convenienza di una quota e la certezza di vincere sono concetti diversi. Il sistema produce stime e decisioni condizionate ai dati disponibili; l'architettura non implica una redditività dimostrata.

### 7.1 Mercati e moduli opzionali

- I mercati squadra comprendono esito, doppia chance, draw no bet, goal/over-under, entrambe a segno, handicap e, con copertura sufficiente, tiri, tiri in porta e cartellini totali.
- Per i cartellini totali l'unità di confronto è **gialli + due volte i rossi**, coerente con il mercato corrispondente.
- Il risultato esatto contribuisce alle probabilità e alle analisi interne; non è un mercato bookmaker operativo richiesto.
- Corner e falli restano esclusi dalla selezione operativa, anche quando esistono statistiche o stime interne.
- Le player props, cioè mercati sul singolo giocatore, sono un percorso distinto: richiedono dati abilitati, campione sufficiente, identificazione non ambigua e una quota reale per giocatore, mercato e linea.
- L'import dei giocatori e il percorso disponibilità/formazioni sono disattivati per default. La loro presenza nel progetto non significa che siano attivi nel deploy.

### 7.2 Addestramento e uso dei modelli

L'addestramento, chiamato anche **fit**, stima i parametri dei modelli dalle partite concluse di una competizione. È un'operazione distinta dalla previsione della singola partita: il flusso di aggiornamento dati può eseguirla dopo l'import e il sistema conserva i parametri nel database.

Il servizio previsioni carica i parametri salvati e li riusa in memoria. Non avvia un nuovo addestramento completo a ogni clic dell'utente. L'assenza di parametri o di un partner Poisson compatibile può attivare comportamenti di base o ridurre l'ensemble: la possibilità di ottenere una risposta non dimostra che un modello sia addestrato e validato sulla competizione scelta.

La calibrazione è un'elaborazione diversa: costruisce correzioni da previsioni storiche cronologiche e le conserva in profili compatibili. Preparare questa cache anticipatamente non equivale a importare dati nuovi o a registrare giocate.

### 7.3 Percorso sperimentale A/C

L'A operativo è il servizio descritto in 7.1–7.2: conserva tutti i propri
mercati squadra abilitati, la selezione canonica e lo stake consigliato.
`AppPredictionOddsService` prepara le quote secondo le regole dell'app;
`ResearchRecommendationRuntime` registra quel risultato senza rifare la
selezione su un sottoinsieme gol. La descrizione research qui sotto riguarda
la baseline A80 usata da C e dal benchmark, distinta dall'A operativo.
La policy di esecuzione `virtual-recommendation-v2` non sostituisce i motori:
valida quota, kickoff e capitale e preserva i pacchetti originali. Le player
props restano separate, corner e falli bloccati. Per liquidare tiri e
cartellini A occorrono le statistiche effettive richieste; i mancanti non
vengono interpretati come zero.

La [guida A](models/MODEL-A.md) segue il percorso operativo dell'app e la
[guida C](models/MODEL-C.md) segue baseline, CatBoost e selezione del Challenger.
In C la pipeline coerente applica il post-processing previsto prima di
`ChallengerRecommendation`: quest'ultimo riusa `ValueBettingEngine` per
filtri/EV/confidenza con calibrazione e blend disabilitati in quello stadio,
poi il picker canonico. Non confronta il ranking C con quello A.
Il limite sulle quote con rimborso o puntata suddivisa e la causale globale
di astensione talvolta troppo generica sono spiegati nella guida C.

Questo passaggio descrive C906 legacy. Il nuovo selettore candidato
`ChallengerSelection` usa direttamente la distribuzione dei rendimenti e
non richiama il motore value o il picker di A. Viene scelto soltanto da una
tupla C approvata; in mancanza di prove non cambia la selezione operativa.
`ChallengerAdoptionStore` congela forecast comparativi futuri senza puntate,
con separazione CALIBRATION/FUTURE_TEST e un unico verdetto sul campione
preregistrato. Il training settimanale registra candidature, non promozioni
basate sui risultati storici. La migrazione 025 viene scoperta dal normale
runner delle migrazioni, ora compatibile con i corpi completi dei trigger.

`ForecastCore` ricostruisce il nucleo A dal solo passato ammissibile e produce
feature comuni per training, benchmark e inferenza. `CatBoostModel` carica
gli alberi JSON del candidato C e deriva una distribuzione congiunta dei gol.
`ResearchProbabilityPipeline` conserva il protocollo V1 come evidenza storica.
Il percorso decisionale usa `CoherentProbabilityPipeline`, con protocollo
versionato `joint-goal-coherent-v2`: calibra una partizione 1X2 normalizzata,
riproietta la distribuzione dei gol e deriva tutte le probabilità e l'EV
dalla stessa matrice finale. Conserva separatamente raw, calibrate,
decisionali e bookmaker. I calibratori V1 non vengono riutilizzati come V2.
`ProbabilityConfiguration` identifica anche modalità, temperatura e calibratore
del post-processing. La validazione di mercato è legata a questo descrittore/hash,
non alla sola versione raw del modello. Una configurazione nuova o mancante
non eredita le approvazioni precedenti, anche quando la versione A resta uguale.
La baseline ricostruita non equivale a ogni stato mutabile dell'analisi live:
manifest e report esplicitano le differenze, inclusa la matrice ausiliaria A.

`ResearchEvaluation` confronta A/C con input e condizioni uguali, metriche
appaiate e test cronologico separato. `ResearchLifecycle` conserva candidati,
valida l'ultimo holdout e può promuovere o ripristinare versioni solo con
evidenze prestabilite. La policy protegge le 745 partite finali già osservate
e richiede un nuovo periodo futuro per le promozioni; tre retry dello stesso
snapshot non bastano come controlli operativi. La promozione del modello è distinta dall'abilitazione
di un mercato. In assenza di evidenze il mercato resta sperimentale. La nuova simulazione
nightly può ammetterlo solo con idoneità tecnica verificata, senza promuoverlo
o considerare dimostrata una redditività.
Modalità, temperatura e hash della configurazione effettiva restano espliciti
nei report e nelle prove operative, senza ricorrere a un calibratore implicito.

Il training CatBoost avviene tramite comando Python locale o workflow
settimanale. L'inferenza web resta nel monolite TypeScript; non viene aggiunto
un microservizio ML. `ResearchRuntime` fornisce preparazione, probabilità e snapshot al job finito
`ResearchNightly`, al settlement e al monitoraggio. Il precedente T−15 resta
codice di compatibilità, non un processo richiesto. La sezione Confronto A/C legge lo stesso
database; non simula saldi nel telefono.

`ResearchProspectiveEvidence` aggiunge raccolta prepartita e risultati
append-only con la migrazione additiva 021. Congela osservazioni anche sulle
astensioni, senza creare puntate o movimenti del ledger; le risolve soltanto quando il
risultato ufficiale è realmente osservato. La partizione nominale 80/20 usa
l'hash della partita, comune per A/C: `FUTURE_TEST` non entra nei campioni
prudenziali. Si riutilizzano soltanto osservazioni `CALIBRATION` già risolte e
compatibili con versione, artefatto e configurazione al momento della nuova
previsione. Nessun refit, calibrazione ricostruita o promozione implicita.

Nel benchmark e nella diagnosi research, almeno50 partite per mercato/fascia
e Hoeffding possono imporre astensione. Questi criteri restano conservati:
non sono il veto della nuova esecuzione virtuale basata sul consiglio Partite.
La diagnosi ha stake zero; eventuali nuove BET appartengono a record di
esecuzione distinti e non promuovono automaticamente un modello. Vedi il [riscontro runtime](operations/nightly-model-runtime-2026-10-29.md).

Il registry `research_experiments`, aggiunto dalla migrazione 017, conserva
separatamente diagnosi e confronti di sviluppo. I relativi artefatti restano
incompatibili con la selezione runtime e non diventano candidati operativi
soltanto perché sono consultabili nella scheda Esperimenti.

## 8. Dati persistenti e relazioni

Il database libSQL/Turso è il punto di condivisione tra interfaccia web, Android e processi programmati. Non viene creato un database per ciascun dispositivo.

| Gruppo di dati | Contenuto e collegamenti |
|---|---|
| Squadre, partite e stagioni | Identità calcistiche; ogni partita collega casa, trasferta, competizione, stagione e risultato |
| Statistiche derivate | Medie, variabilità, copertura e profili di squadre, arbitri e, se abilitati, giocatori |
| Parametri dei modelli | Parametri addestrati per competizione e riferimento temporale, ricaricabili dal servizio previsioni |
| Quote storiche e snapshot | Prezzi, mercati, timestamp e provenienza associati alla partita |
| Previsioni e opportunità | Selezioni analizzate, probabilità, quote usate, classificazione e versioni pertinenti |
| Decisioni archiviate | Collegamento tra opportunità e scelta operativa oppure semplice salvataggio |
| Giocate e budget | Importi registrati, quota, esito, ritorni e movimenti del capitale interno condiviso |
| Backtest e learning review | Report di validazione e confronti post-partita |
| Cache di calibrazione | Profili riutilizzabili con impronta di dati, configurazione e codice |
| Sessioni e job | Sessioni amministrative e traccia persistente delle esecuzioni programmate |
| Riferimenti tra competizioni | Identità e passaggi di squadra utili ai controlli e ai percorsi previsti |
| Registry e benchmark A/C | Artefatti, hash, metriche, holdout, Champion e transizioni versionate |
| Mercati della ricerca | Stato ed evidenze per famiglia/versione/mercato, separati dalla promozione del modello |
| Job e input prepartita | Finestra nightly, kickoff UTC, lease, motivi di astensione e snapshot condivisi; vecchi record T−15 preservati |
| Esecuzioni nightly A/C | Migrazione additiva 020: finestra e policy persistenti, lease, retry e riepilogo del job |
| Portafogli A/C | Due ledger indipendenti, ID storici preservati e nessun nuovo main o fusione con il budget legacy |
| Monitoraggio della ricerca | Incidenti deduplicati e riepiloghi quotidiani nell'app; canale esterno non configurato |
| Esperimenti diagnostici | Configurazioni e risultati di sviluppo con hash/versioni, separati dai candidati runtime e non promuovibili |

```mermaid
flowchart LR
    T[Squadre] --> M[Partita]
    M --> Q[Snapshot quote]
    M --> P[Previsioni e opportunità]
    Q -->|Quote usate nell'analisi| P
    P --> D[Decisione archiviata]
    D -->|Se operativa| B[Giocata registrata]
    B --> K[Budget e movimenti]
    M -->|Risultato effettivo| S[Valutazione esito]
    S --> P
    S --> B
    S --> L[Learning review interna]
```

Questo è un modello concettuale delle relazioni, non uno schema SQL: alcuni collegamenti sono conservati anche nei payload archiviati. I record legacy possono avere collegamenti o metadati incompleti.

L'audit interno conserva anche probabilità scartate dai filtri o prive di quota. L'archivio delle opportunità comprende invece le decisioni effettivamente registrate o salvate: calcolare una probabilità non significa proporre o registrare una giocata.

Le migrazioni versionate aggiornano lo schema all'inizializzazione del backend. Gli aggiornamenti delle giocate e del budget usano operazioni atomiche per mantenere coerenti registrazione e capitale interno.

## 9. Giocate, automazione e chiusura degli esiti

### 9.1 Portafogli A/C e storico legacy

Il confronto A/C non espone registrazioni manuali: il solo percorso nuovo è
la nightly. I due portafogli esistenti `shadow_A` e `shadow_C` conservano gli
ID storici, i ledger e il capitale; non rappresentano una modalità Shadow
Betting aggiuntiva. Non viene creato un terzo portafoglio. Le API manuali del
budget legacy, fra cui `/bets/place`, appartengono al sistema precedente e
non sono invocate per le registrazioni notturne A/C.

L’integrazione locale usa `GET /api/wallets`: un adattatore sottile sopra
`ResearchComparison`, in sola lettura, con gli stessi ID e movimenti.
Aggregati dell’intero periodo e dettagli fino a 500 righe rimangono distinti,
con troncamento esplicito. Giocate/Budget/Archivio leggono questi dati senza
inizializzazione, sync o placement legacy. Le 258 giocate precedenti restano
in uno storico separato, senza modello A inventato né patrimonio cumulato.
Nessuna tabella o esposizione viene duplicata; il deployment di questa
integrazione non è ancora verificato.

Il settlement liquida soltanto giocate già registrate quando i dati necessari
sono disponibili. Rimborsi, mezzi esiti e risultati incompleti mantengono le
regole implementate; storico e saldi legacy restano separati.

### 9.2 Nightly Pre-Match Virtual Betting

La route legacy automatica `/api/automation/place-valid-bets` rimane ritirata
con `410`; `AUTO_BET_*` non abilita la nuova nightly. Il job finito usa i servizi
esistenti direttamente sul runner GitHub, dopo sincronizzazione e gate dati.

La finestra parte dall'avvio effettivo e arriva alla successiva nightly delle
03:07 Europe/Rome nel nuovo assetto, oppure usa una durata configurata. Orario legale, ritardi,
rinvii e cambi di kickoff non autorizzano una puntata retroattiva. Il kickoff
viene ricontrollato nel commit, senza nuova registrazione dopo l'inizio.

La nuova policy attiva e verificata riusa due portafogli da 1.000 euro: A esegue esattamente
il consiglio Partite con la sua percentuale di stake, C usa 1% fisso. Ogni
modello può astenersi, esposizione aperta massima 5%, una puntata per partita
e portafoglio. Il picker backend mantiene livelli/ranking della pagina; la
UI non applica un ranking autonomo. Selezione deterministica, lease persistenti e
vincoli univoci proteggono retry e workflow concorrenti senza doppio impegno.

`EXPERIMENTAL` non impedisce da solo la simulazione virtuale: restano
obbligatori dati e probabilità coerenti, prezzo reale identificato, timestamp,
liquidazione, capitale e controlli tecnici. Validazione statistica e promozione
restano separate; C non diventa Champion perché guadagna nel periodo.
`RESEARCH_NIGHTLY_ENABLED=false` resta il default sicuro del codice;
il 30 ottobre le nuove registrazioni sono state riattivate dopo il recupero
controllato verificato. Il run riuscito del 29 ottobre resta un riscontro datato. Nessun percorso di questo confronto invia puntate ai bookmaker.

### Nuova esecuzione del consiglio: codice pubblicato e attivato

A usa PredictionService corrente, versione/hash `APP-A` distinta da A research 80;
C906 e la sua baseline 80 restano immutati. La nightly conserva prima origini
DIAGNOSTIC a stake zero; la migrazione additiva 023 prepara quattro tabelle
`research_execution_policies`, `research_execution_jobs`,
`research_execution_inputs`, `research_execution_decisions` e il FK nullable
`research_bets.execution_decision_id`. I vecchi dieci ABSTAIN non vengono
riscritti. Le nuove valutazioni hanno policy/input propri e quote ≤300 secondi.
Ledger e unicità globale impediscono doppie puntate per match/modello/portafoglio.

Il frontend LIVE preferisce il pacchetto A congelato e gli importi effettivi,
con stato e timestamp della quota storica: non è una quota live. Non ricostruisce
un consiglio live per coprire un ABSTAIN tecnico. Il replay conserva la selezione
mostrata e la quota storica. Un ABSTAIN tecnico lecito senza pacchetto espone
`technical_abstention`, motivo/timestamp reali e stake zero, senza inventare
modello/probabilità/quote o fallback. Una BET corrotta senza pacchetto produce 503.
Il confronto calcola i conteggi completi prima del limite 500 ai dettagli.
C esclude push/quarti non supportati dal proprio engine e cerca un'altra
opportunità ammessa; A conserva i quarti supportati da GoalSettlement.
Mercati EXPERIMENTAL ammessi se tecnicamente idonei, senza promessa di profitto,
commissioni reali, copertura totale o superiorità statistica.

Backup ufficiale da 530.429.352 byte incluso WAL, due ripristini con integrità
ok, FK0, 57 tabelle e 314.952 righe. Rehearsal e crash-resume 023 superati.
023 applicata remotamente alle 13:14 UTC: allora le quattro tabelle erano
vuote, registro 23→24,
21 hash delle colonne originarie protette e sette hash finanziari invariati.
Utenti 2, sessioni 3 e 258 legacy preservati; i wallet erano allora 1.000 euro
con zero impegnato. Dopo l’attivazione gli impegni verificati sono 44,20 A e 20 C.
Rollback: spegnere il nuovo flag, conservando settlement, record e letture
compatibili con le nuove esecuzioni. Non attribuire BET nuove alle origini a
stake zero e non ripristinare un vecchio reader incompatibile come soluzione.

## 10. Replay, archivio e backtest

| Percorso | Domanda a cui risponde | Limite da conservare |
|---|---|---|
| Archivio | Che cosa era stato salvato o registrato, con quali dati e quale esito? | Dipende dalla completezza e dai timestamp dei record realmente presenti |
| Replay | Che analisi ricostruisce il sistema per una partita già conclusa? | Non prova quale consiglio fosse effettivamente disponibile prima della partita |
| Backtest | Come si comporta una configurazione su una sequenza storica? | È una valutazione simulata, distinta dalle giocate registrate prima del calcio d'inizio |

Il replay usa, quando disponibili e ammesse, quote bookmaker archiviate. In loro assenza può produrre un replay statistico con quote stimate dal modello, marcato con una provenienza distinta. Tali quote non costituiscono evidenza di value o rendimento contro il mercato reale. Il replay può inoltre salvare una learning review: una richiesta di analisi non è necessariamente priva di scritture.

Il backtest supportato segue il metodo **walk-forward**: procede nel tempo, addestra sui dati ammessi prima del target e valuta il periodo successivo. I percorsi cronologici applicano regole di disponibilità temporale ai risultati e alle informazioni supplementari, per evitare di usare il futuro per prevedere il passato.

Il lavoro pesante del backtest viene eseguito in un worker thread, cioè un thread di calcolo separato all'interno dell'applicazione Node. È ammesso un backtest alla volta per istanza del servizio, con timeout e rifiuto delle richieste concorrenti. Non è una coda distribuita e non è un microservizio.

Le learning review confrontano probabilità, consiglio ed esito. I moduli di apprendimento e tuning sono strumenti interni e condizionati alla configurazione; non implicano che ogni aggiornamento produca un miglioramento o che il modello si riaddestri autonomamente con risultati garantiti.

## 11. Aggiornamenti programmati

GitHub Actions rimane l'orchestratore su runner standard Linux del repository
pubblico. Il nuovo workflow usa timezone nativa `Europe/Rome`: principale
`7 3 * * *` e recuperi `17 4 * * *`, `27 5 * * *` (03:07/04:17/05:27 locali).
Il guard legge soltanto GitHub API prima di npm/build: solo il successo reale
del passo `Run nightly sync` e del marker `Confirm enabled A/C completion`
nello stesso job e nella giornata Roma consuma la giornata. Uno
stato verde/cancellato da solo non basta, senza quel passo riuscito. Dopo un vero
successo, un secondo trigger non esegue il ciclo con DB/provider; dati API
incerti bloccano il gate. Concorrenza seriale e lease DB restano attivi.
Recuperi dopo failure possono ripetere lavoro: non è una promessa di un'unica
richiesta dopo errori, né un SLA al minuto. `RESEARCH_NIGHTLY_MINUTE=7` viene
allineato in produzione, monitor e dashboard; il default locale resta 0.

Il correttivo pubblicato `fd97d145`, verificato dal run `41044931407`, aggiunge
dopo Understat e prima del job A/C,
`POST /api/system/sync-upcoming-kickoffs`, solo quando A/C sono abilitate,
Top 5 e limite 160. Il GET eventi del provider è gratuito e non richiede prezzi.
Se l'aggiornamento richiesto fallisce, impedisce nuove decisioni A/C senza
impedire manutenzione e liquidazioni esistenti. La completezza va comunque
verificata sui dati reali: il recupero remoto dei cinque incontri è attestato
dall’audit RO 11:10:02 UTC.

Il recupero `recover_missing_fixtures` è manuale e default `false`: richiede
un vero successo A/C nello stesso giorno e nessuna esecuzione attiva. Il
percorso standard continua a saltare dopo il successo. ResearchStore esclude
gli input esistenti prima di API quote/inferenza, preservando il confronto
precedente e valutando solo le partite mancanti. Il recupero verificato usava
la precedente diagnosi EV 4%/prudenziale 1% e minimo 50; la nuova esecuzione
locale Partite è una policy separata, con freschezza e kickoff sempre controllati.

Il flusso mantiene import Understat, supplemento HTTP/CSV consentito,
normalizzazione, calendari, risultati, liquidazioni legacy e A/C e preparazione
calibrazione. Dopo i gate, se abilitato, lo script `research-nightly.js` carica
A/C, raccoglie le quote ammesse per ciascun modello, acquisisce i rispettivi
consigli, registra e aggiorna i portafogli.
Learning review e stato finale restano distinti dai requisiti di ammissione.
Un gate fallito impedisce nuove decisioni su dati non idonei; i risultati
precedenti non vengono cancellati. I dettagli sono nella
[guida nightly](github-actions-nightly-sync.md).

Il backend web usa `NIGHTLY_ORCHESTRATOR=github_actions` e non ripete gli
scheduler interni. `RESEARCH_T15_SCHEDULER_ENABLED=false` rimane impostato;
non occorrono worker Hostless, polling ogni 15 secondi o heartbeat per
l'ammissione delle nuove puntate. Il vecchio watchdog Hostless è in pausa.
La richiesta di pausa standalone è stata accettata, ma lo stato effettivo
non è ancora confermato. Nessun servizio è stato eliminato.

La dashboard espone ultima nightly, esito, conteggi, errori, crediti e
liquidazioni osservati. Monitor GitHub, controllo DB periodico RO e attese
del nuovo orario 03:07 sono attivi; l'opt-in delle attese è separato dal flag delle puntate.
Contabilità, quota, errori e stalli recenti oltre quattro ore vengono controllati
anche indipendentemente dall'aspettativa programmata. Audit finanziario RO
del 29 ottobre alle 20:07 UTC PASS, senza variazioni ai quattro fingerprint finanziari.
Nello snapshot del 29 ottobre il monitor `4dff28f4` era pubblicato; il watchdog
con attese attive `40946558140` è SUCCESS: tutti i passi GitHub e DB RO completati in 26 secondi.
La registrazione A/C è riattivata; quando la nightly abilitata
esegue il reconcile, prepara il
riepilogo del giorno precedente con `publishAfter` alle 09:00 Europe/Rome.
Il GET ne filtra la visibilità senza scrivere o inviare all’esterno. Non ci
sono notifiche per ogni puntata. L’esito SUCCESS del job non viene usato
come prova di consegna esterna o di un nuovo riepilogo senza verifica della riga.

Training settimanale, promozione condizionata e rollback restano separati dal
job giornaliero. `Prepare prediction calibration` calcola i profili sul runner
e li salva nel DB, senza chiamare provider quote o registrare puntate. Il suo
trigger su `main` scrive sul personale. I workflow sono stati riattivati
in modo selettivo:
training e nuove registrazioni nightly attivi,
Registry writes disabilitate. La pubblicazione
tramite PR e il cutover sono avvenuti; CI e build non attestano un ciclo
automatico reale concluso.

## 12. Cache e prestazioni

L’[audit locale Turso/CPU](operations/turso-cpu-audit-2026-10-29.md) distingue
riduzione dei payload e UPDATE inutili dalle righe fatturate dal provider.
Queste misure offline non provano risoluzione del CPU throttling Hostless.

Il sistema usa cache locali e una cache persistente specifica, senza un servizio Redis o un message broker dedicato.

| Livello | Che cosa evita | Validità e limiti |
|---|---|---|
| Frontend | Ripetere letture identiche e richieste simultanee uguali | Durata limitata e invalidazione dopo operazioni pertinenti |
| Backend in memoria | Rileggere riepiloghi, copertura, quote, modelli e input di calibrazione | Ogni processo ha la propria cache; il riavvio la svuota |
| Snapshot e archivio | Recuperare di nuovo informazioni già conservate, quando riutilizzabili | Devono rispettare provenienza, compatibilità e freschezza |
| Cache persistente di calibrazione | Ricalcolare sul servizio web profili già preparati dal runner | Riuso solo con impronta compatibile di dati ammessi, impostazioni e codice |

Se un profilo manca, è danneggiato o non è compatibile, il backend ricalcola la calibrazione completa. Questo preserva la correttezza ma può rendere più lenta la prima previsione. La preparazione anticipata riduce questo costo senza accettare profili obsoleti.

Le scritture del processo locale invalidano le cache interessate dove previsto. Le modifiche eseguite da un altro processo possono diventare visibili solo alla scadenza della cache: database condiviso non significa cache condivisa o aggiornamento istantaneo.

Batch di lettura/scrittura, aggiornamento delle sole squadre coinvolte e richieste quote mirate riducono rete e lavoro ripetuto. Non dimostrano da soli una riduzione delle righe fatturate o il rispetto delle quote del provider: questi aspetti richiedono misure operative.

## 13. Accesso e sicurezza

Il prodotto usa un accesso amministrativo condiviso e un'identità dati canonica per budget e giocate, normalmente `user1`. Non è progettato come servizio pubblico con account e portafogli indipendenti per ogni utente.

Il login verifica una password tramite hash e genera una sessione. Nel DB viene conservato l'hash del token di sessione; il dispositivo riceve un cookie non accessibile al JavaScript della pagina. In produzione i cookie richiedono una connessione sicura e la password configurata è obbligatoria.

Il backend controlla le origini autorizzate, limita i tentativi di login e
protegge le operazioni amministrative. Le chiamate interne usano i meccanismi
dedicati alla manutenzione. La route legacy di registrazione automatica è
ritirata e risponde sempre 410; non avvia decisioni né richiede una sessione
browser. Il job nightly usa direttamente il database con i secret del runner,
mai quelli del frontend. L'healthcheck essenziale resta pubblico.

Le chiavi del database e dei provider restano nell'ambiente backend o nei GitHub Secrets. Le variabili frontend vengono incluse nella build: non devono contenere credenziali riservate. L'APK contiene interfaccia e configurazione di collegamento, non un'autorizzazione permanente alle API.

## 14. Esecuzione e distribuzione

| Ambiente | Frontend | Backend | Persistenza |
|---|---|---|---|
| Sviluppo locale | Server React con proxy API | Processo Node locale | Database libSQL configurato |
| Docker Compose | Build React servita da Nginx sulla porta locale 3000 | Container Node sulla porta 3001 | Database libSQL/Turso configurato nell'ambiente |
| Hosting web previsto dalla configurazione | Servizio frontend, eventualmente con URL API esplicito nella build | Servizio backend separato | Database condiviso configurato |
| Android | Asset React inclusi nell'APK tramite Capacitor | Stesso backend remoto della versione web | Stesso database attraverso le API |
| GitHub Actions | Nessuna UI | Processo temporaneo sul runner | Stesso database indicato dai secrets |

In Compose, Nginx serve gli asset e inoltra le richieste `/api` al backend; il frontend parte dopo il superamento dell'healthcheck del backend. Non è presente un container database nello stack Compose corrente.

Per browser e Android la destinazione API dipende dalla configurazione della build. Il client Android ha anche un indirizzo Hostless predefinito. Questi riferimenti descrivono il collegamento previsto, non una verifica di disponibilità dell'hosting.

La [migrazione Turso personale](operations/turso-personal-migration-2026-10-29.md)
è completata come adozione autorizzata della copia esistente. Migrazioni 020/021,
export finale 18:58 UTC e parità 19:00 UTC sono riusciti: target 57 tabelle e
133 oggetti di schema, con le 52 tabelle dello storico preservate. Backend,
configurazione locale produzione e secret GitHub RW/RO puntano al personale.
La sorgente resta bloccata: il delta dopo il dump 15:17 UTC non è verificabile
ed è stato esplicitamente accettato. L'originale non è eliminato; la gestione
è del proprietario, fuori dall'accesso CLI personale disponibile.

Il comando di avvio completo previsto è `docker compose up -d --build`. L'endpoint essenziale è `http://localhost:3001/api/health`. HTTPS esterno, DNS e modalità di deploy dipendono dall'ambiente scelto.

## 15. Errori, osservabilità e limiti operativi

| Situazione | Comportamento o confine previsto |
|---|---|
| Statistiche mancanti o campione ridotto | Qualità e disponibilità influenzano mercati, confidenza e decisione; non si presume copertura completa |
| Evento o quota reale assente | Segnalazione di indisponibilità; niente attribuzione di una quota sintetica a un bookmaker |
| Database non raggiungibile | Le funzionalità che richiedono dati o scritture possono fallire; non c'è un archivio operativo offline separato sul telefono |
| Cache di calibrazione inutilizzabile | Ricalcolo completo, con possibile aumento dei tempi |
| Backtest concorrente o troppo lungo | Rifiuto della seconda elaborazione per istanza oppure termine per timeout |
| Import parzialmente fallito | Stato di errore e conteggi delle scritture confermate; non si presume un rollback globale dell'intero import |
| Controlli obbligatori nightly falliti | Il run rimane fallito e i passaggi dipendenti devono rispettare i gate |
| Risultato insufficiente per il settlement | Record ancora non risolto invece di un esito inventato |

Gli identificativi delle richieste e delle esecuzioni, i log e i record dei job permettono di collegare operazioni ed errori. Le API di sistema espongono stato generale, provider, metriche e run recenti.

L'healthcheck essenziale conferma che il processo risponde: non prova freschezza dei dati, copertura quote o corretto completamento della nightly. Questi richiedono controlli separati.

L'architettura dipende da un database condiviso e da provider esterni. Non documenta un cluster con alta disponibilità, una coda distribuita o un piano di backup già verificato. Cache, lock e limiti di concorrenza locali non coordinano automaticamente più repliche del backend. Prima di aumentare le istanze servirebbe verificare questi confini.

## 16. Scelte architetturali e conseguenze

| Scelta | Motivo | Conseguenza |
|---|---|---|
| Monolite modulare | Mantenere semplice lo sviluppo e il collegamento tra dati, modelli e budget | I moduli condividono il ciclo di rilascio e parte delle risorse del processo |
| Web-first con Android Capacitor | Riutilizzare interfaccia e logica applicativa | Le funzioni principali del telefono richiedono il backend raggiungibile |
| libSQL/Turso condiviso | Unificare dati tra dispositivi e job senza un DB locale separato per ogni client | Costi, latenza e disponibilità del DB incidono sui percorsi principali |
| Nightly sul runner | Separare il lavoro periodico dal servizio che risponde agli utenti | Le scritture esterne richiedono attenzione alla freschezza delle cache |
| Provenienza esplicita delle quote | Separare prezzi reali da stime del modello | Un mercato può restare non disponibile anche se la probabilità è calcolabile |
| Calibrazione persistente compatibile | Riutilizzare il lavoro senza alterare il protocollo statistico | Nuovi dati o configurazioni possono richiedere calcoli completi |
| Backtest in worker | Limitare l'impatto del calcolo sulla risposta HTTP | Le risorse restano condivise sulla stessa macchina; non è scalabilità distribuita |

## 17. Riferimenti e verifica del documento

Questa è la lettura d'insieme dell'app. Gli altri documenti approfondiscono singoli aspetti:

- [README](../README.md): ingresso al progetto e comandi principali.
- [Formulario](FORMULARIO-sistema-scommesse.md): dettagli matematici e configurazione dei modelli.
- [Indice A/C](models/README.md), [modello A](models/MODEL-A.md) e [modello C](models/MODEL-C.md): percorsi separati, componenti condivisi e limiti verificati nel codice.
- [Nightly GitHub Actions](github-actions-nightly-sync.md): ordine operativo, gate e configurazione dei job.
- [Android privato](android-private-apk.md): distribuzione e collegamento dell'APK.
- [Transizioni tra competizioni](competition-transitions/README.md): riferimenti e limiti dei dati.
- [Piattaforma A/C](research-platform.md): ML, benchmark, mercati, portafogli e nightly opt-in.

I principali riscontri per mantenere questo documento aggiornato sono:

| Aspetto | Fonti nel repository |
|---|---|
| Schermate e comunicazione | [App React](../frontend/src/App.tsx), [client API](../frontend/src/utils/api.ts), [Capacitor](../frontend/capacitor.config.ts) |
| Ingresso backend e accesso | [Avvio backend](../backend/src/index.ts), [autenticazione](../backend/src/security/SharedAdminAuth.ts), [API](../backend/src/api/routes.ts) |
| Dati e import | [Database](../backend/src/db/DatabaseService.ts), [migrazioni](../backend/migrations), [Understat](../backend/src/services/UnderstatScraper.ts), [supplemento CSV](../backend/src/services/FootballDataService.ts) |
| Previsioni e decisioni | [Servizio previsioni](../backend/src/services/PredictionService.ts), [contesto](../backend/src/services/PredictionContextBuilder.ts), [motore decisionale](../backend/src/models/value/ValueBettingEngine.ts) |
| Quote e provenienza | [Configurazione provider](../backend/src/services/odds-provider/providerRuntimeConfig.ts), [coordinatore](../backend/src/services/odds-provider/OddsProviderCoordinator.ts), [selezione quote](../backend/src/services/BookmakerOddsSelectionService.ts) |
| Automazione e calcoli | [Pianificatore](../backend/src/services/AutomatedBetPlanningService.ts), [worker backtest](../backend/src/services/HeavyJobService.ts), [previsioni cronologiche](../backend/src/services/ChronologicalForecastService.ts) |
| Job e deployment | [Compose](../docker-compose.yml), [Nginx](../frontend/nginx.conf), [nightly](../.github/workflows/nightly-sync.yml), [script nightly](../scripts/ci/nightly-sync.sh), [warm calibrazione](../.github/workflows/calibration-warm.yml), [CI](../.github/workflows/ci.yml) |

Per verificare questa descrizione in modo ripetibile occorre confrontare: servizi effettivamente avviati, route raggiunte dalla UI, dipendenze tra moduli, gruppi di dati persistiti, flag predefiniti e sequenza dei workflow. I diagrammi rappresentano questi riscontri, non componenti futuri della roadmap.

Per questa revisione sono stati controllati sorgenti, configurazioni e riferimenti locali. Non sono stati avviati import, backtest, job, container o chiamate al database/provider: la modifica riguarda solo la documentazione e non misura prestazioni, disponibilità o rendimento delle previsioni.
