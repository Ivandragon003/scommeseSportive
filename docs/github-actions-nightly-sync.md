# GitHub Actions per sync notturna

**Stato al 27 ottobre 2026:** il vecchio workflow remoto, che conteneva ancora
`AUTO_BET_ENABLED=true` e la chiamata legacy, è stato sospeso tramite GitHub CLI.
Verificato workflow ID `253787848` in stato `disabled_manually` e nessun run
attivo o in coda. La patch permanente workflow/script è nel commit locale
`e046bc4f`, non ancora pubblicato. Anche import e liquidazioni della nightly
sono temporaneamente sospesi: non è ancora una nightly remota maintenance-only.

Il [piano operativo T−15](operations/t15-readiness-2026-10-27.md) distingue la
correzione preferita di workflow/script dalla sospensione temporanea dell'intera
nightly, che interrompe anche la manutenzione. Il
[report corrente](operations/production-status-2026-10-27.md) documenta le
operazioni effettive e i blocchi. Nessun cambio di
repository variable può sovrascrivere il vecchio flag scritto nel workflow.

La nightly è orchestrata da GitHub Actions. Il backend web serve UI e API.
Dal 12 ottobre 2026 le formazioni sono temporaneamente sospese per ridurre
letture, scritture e chiamate provider. Anche import, statistiche derivate,
letture e mercati giocatore sono temporaneamente sospesi; lo storico resta salvato.

## Flusso

- Avvio di un backend temporaneo con bootstrap e tutti i collector periodici disabilitati.
- Import Understat su stagione corrente e quattro precedenti, con verifica di copertura.
- Supplemento HTTP/CSV `football-data.co.uk`: riempie solo i campi mancanti di
  tiri, tiri in porta, falli, corner, cartellini e arbitro; conserva le quote
  storiche di apertura/chiusura nella loro colonna dedicata. Non fornisce il possesso.
- Aggiornamento dei riferimenti per le transizioni tra competizioni. Il recupero
  dei kickoff resta disponibile; lo step formazioni è saltato quando
  `PLAYER_AVAILABILITY_ENABLED=false` (default).
- Settlement delle prediction e delle giocate concluse e preparazione delle
  analisi. La raccolta quote è disabilitata per default (`RUN_ODDS_SYNC=false`);
  se riabilitata esplicitamente usa il budget persistente comune. La nightly
  non registra nuove giocate e non riserva decisioni di puntata future.
- Learning review solo quando i gate obbligatori sono soddisfatti.
- Stato finale e log come artifact GitHub Actions; un gate fallito mantiene il run fallito.

Riferimenti: [workflow](../.github/workflows/nightly-sync.yml) e
[script](../scripts/ci/nightly-sync.sh). Le quote sintetiche restano interne;
bookmaker e provenienza delle quote reali vengono conservati.

## Consumo del database

I CSV storici già verificati evitano nuovi download, ma la copertura nel DB
continua a essere controllata. Il supplemento legge solo le finestre stagionali
richieste. Le righe già identiche non generano UPDATE; le condizioni SQL
proteggono comunque le scritture concorrenti. Le statistiche cambiano solo se
la fonte può riempire un campo mancante e le quote solo quando cambiano.
Le medie vengono ricalcolate sulle sole squadre con statistiche modificate,
anche quando un'altra stagione è incompleta. Il gate di completezza rimane obbligatorio.
Se la retention elimina partite, si ricalcolano invece tutte le squadre per
rimuovere dai valori derivati lo storico eliminato; le elaborazioni già in
corso vengono invalidate prima di attendere il download supplementare.

Per Rennes–PSG del 23 agosto 2026, Ligue 1 2026/27, la
[LFP ha invertito il campo](https://ligue1.com/fr/articles/l1_article_5699-j1-psg-rennes-inverse-l1-2627).
Understat conserva l'ordine PSG–Rennes. Solo per questa partita, risultato
ufficiale 2–2 e un unico candidato inverso nella stessa data, il supplemento
orienta statistiche e quote per squadra. Il JSON delle quote conserva ordine
originale della fonte, mapping e riferimento ufficiale. L'identità primaria
rimane invariata: l'etichetta casa/trasferta Understat resta una discrepanza
nota. Nessun matching inverso generico viene abilitato.

Il batching riduce le richieste di rete; i contatori Turso di righe lette e
scritte devono essere misurati separatamente. Non cancellare lo storico per
risolvere un limite di letture.

## Un solo orchestratore

La nightly prepara i profili di calibrazione
delle cinque leghe tramite `/api/model/calibration/warm` sul proprio backend
temporaneo. Il calcolo resta sul runner GitHub Actions; Hostless legge i profili
da una cache additiva libSQL/Turso, senza servizi aggiuntivi.

Il riuso richiede la stessa impronta dei dati e delle quote storiche ammesse,
della configurazione effettiva e del codice backend. La coorte include solo
risultati disponibili entro il cutoff richiesto, con le stesse due ore di
ritardo del percorso cronologico. Cambiamenti dei dati, del codice o delle
impostazioni provocano un nuovo calcolo. Non vengono ridotti i 450 target,
i refit settimanali o le iterazioni del modello. Profili danneggiati o cache
indisponibile usano il calcolo completo; il primo caricamento di una nuova
coorte non ancora preparata resta più costoso. La cache persistente conserva
al massimo 128 profili; le cache in RAM e il loro TTL di sei ore restano attivi.
La nuova tabella viene creata dalla migrazione additiva
`014_runtime_calibration_cache.sql` durante l'avvio del backend.
Se Hostless usa valori personalizzati `MODEL_*` o `PLAYER_GOALS_XG_SHRINK`,
configurare gli stessi valori anche nel workflow per condividere i profili.
Impostazioni diverse non riusano risultati incompatibili: provocano un miss.

`NIGHTLY_ORCHESTRATOR=github_actions` è il default anche per un avvio diretto
con Node. Disabilita bootstrap, scheduler Understat, quote e learning persino
quando vecchi flag in ambiente sono `true`. Docker Compose imposta questo
valore esplicitamente. API manuali squadra restano disponibili. Il collector formazioni
richiede sia `PLAYER_DATA_ENABLED=true` sia `PLAYER_AVAILABILITY_ENABLED=true`.

Per una scelta esplicita di esecuzione nel backend si può impostare
`NIGHTLY_ORCHESTRATOR=backend` e abilitare i relativi flag. In quel caso
disabilitare prima il workflow GitHub e mantenere un unico processo scheduler.
Gli aggiornamenti si applicano dopo il riavvio/redeploy dei processi esistenti.

La route legacy `/api/automation/place-valid-bets` è ritirata e risponde `410`:
i vecchi flag `AUTO_BET_*` non devono riattivarla. L'unico percorso nuovo di
registrazione automatica è il processo T−15 separato dalla manutenzione,
descritto in [piattaforma A/C](research-platform.md). Il workflow imposta
`RESEARCH_T15_SCHEDULER_ENABLED=false` sul backend temporaneo: il runner non
deve diventare una seconda istanza decisionale. `RUN_ODDS_SYNC=false` nel
workflow e come default dello script evita richieste quote periodiche;
`ODDS_INFORMATIONAL_NETWORK_ENABLED=false` impedisce che letture informative
consumino crediti. La presenza della chiave non riattiva da sola la raccolta.
Un opt-in futuro deve impostare entrambi i permessi e resta soggetto al budget.
Il recupero kickoff usa l'endpoint gratuito eventi: non richiede h2h/scores.
La raccolta di quote durante la nightly, se autorizzata, non è uno snapshot
osservato a T−15. Registro, cache e consumo sono descritti nella
[gestione quote](operations/smart-odds-2026-10-27.md).

Il gate locale `backend/test/nightly-maintenance.test.js` controlla la
separazione. Per la conferma remota occorre pubblicare la versione verificata,
riavviare i processi e controllare un run effettivo: una modifica locale non
cambia un workflow già pubblicato o un backend già in esecuzione.

Il backend web (`node dist/index.js`) non avvia più `ResearchRuntime`, anche
se eredita `RESEARCH_T15_SCHEDULER_ENABLED=true`. La sola registrazione
automatica nuova appartiene al worker dedicato; non esiste una route HTTP
per avviare tick o registrazioni A/C. Le route manuali restano esplicitamente
manuali e non ricevono il tipo di origine dal client. Il vecchio
`AUTO_BET_ENABLED` non è letto dal codice operativo e non può riattivare la
route ritirata. I metodi DB legacy restano per compatibilità con lo storico.

### Passaggio manuale dal workflow remoto precedente

Le seguenti operazioni richiedono pubblicazione autorizzata e non sono state
eseguite durante la preparazione locale:

1. Confrontare la revisione remota effettiva con lo script e il workflow locali.
   Pubblicare lo script di manutenzione senza chiamata a
   `/automation/place-valid-bets` e il workflow corrispondente, con raccolta
   quote disabilitata e processo T−15 disabilitato.
2. Attendere l'eventuale run già avviato con la vecchia revisione, oppure
   annullarlo esplicitamente prima di autorizzare il worker. Pubblicare un
   workflow nuovo non modifica i job già in corso.
3. Aggiornare il backend affinché la route legacy restituisca `410` e il
   processo web non avvii decisioni. Togliere i vecchi `AUTO_BET_*` dagli
   ambienti effettivi: è igiene di configurazione, non il blocco primario.
4. Eseguire una nightly manuale e controllare import, gate e liquidazioni.
   Verificare sul DB condiviso che non siano state create nuove puntate
   future o nuove prenotazioni legacy durante il run. Mantenere attiva la
   nightly per dati e liquidazioni.
5. Solo dopo questi controlli, seguire il collaudo Hostless del worker
   disabilitato e l'abilitazione graduale. Non abilitare due sistemi di
   registrazione durante il passaggio.

In caso di rollback della release web, **non ripristinare** il vecchio
workflow che registrava puntate. Disabilitare prima il worker e mantenere
la nightly di sola manutenzione; un rollback della UI/API non deve
riattivare `AUTO_BET_ENABLED` o la chiamata legacy.

Il training ML settimanale è nel workflow separato
[`research-training.yml`](../.github/workflows/research-training.yml), martedì
alle 04:30 UTC. Il candidato viene registrato sul DB e sottoposto ai gate solo
quando `RESEARCH_REGISTRY_WRITES_ENABLED=true` nelle variabili repository;
per default il job conserva artefatti. Non crea nuove puntate e non abilita
mercati o processo T−15. Il suo trigger non richiede precisione al minuto.

## Configurazione e verifica

Secrets obbligatori: `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN`.
`ODDS_API_KEY` configura il provider, ma non abilita la raccolta di default;
`API_FOOTBALL_KEY` è necessaria per il relativo provider di formazioni quando riabilitato.
Non pubblicare i valori dei secrets nei log o nel repository.

La pausa giocatori usa `PLAYER_DATA_ENABLED=false` nel backend e nel workflow:
anche una richiesta manuale `importPlayers=true` non riattiva il percorso.
Il predittore evita le rose e non genera player props; le richieste quote
escludono i mercati `player_*`. Il frontend nasconde le sezioni giocatore con
`REACT_APP_PLAYER_DATA_ENABLED=false`. La pausa delle formazioni usa
`PLAYER_AVAILABILITY_ENABLED=false` nel backend e
nel workflow; `LINEUP_REFRESH_SCHEDULER_ENABLED=false` in Compose. Le route
availability rispondono con uno stato disabilitato prima di accedere al DB o al
provider, anche alle richieste degli APK precedenti. Il predittore evita le letture
dei relativi snapshot. Il frontend nasconde il pannello e non effettua refresh
availability: per riabilitarlo occorre ricompilare con
`REACT_APP_PLAYER_DATA_ENABLED=true` e `REACT_APP_PLAYER_AVAILABILITY_ENABLED=true`
oltre ad abilitare entrambi i flag backend e il workflow. Nessuno storico viene
cancellato. Vedi [diagnosi iniziale](performance/lineup-pause-2026-10-12.md) e
[riduzione letture e pausa completa](performance/db-read-reduction-2026-10-12.md).

L'import Understat riutilizza gli ID letti prima delle scritture e aggiunge solo
quelli confermati dal batch, evitando una seconda lettura di ogni stagione.
Le medie si aggiornano sulle squadre delle partite concluse modificate; la
retention mantiene il ricalcolo globale necessario. Il riepilogo statistiche e
la copertura storica delle squadre condividono letture concorrenti con cache
in memoria di 10 minuti, invalidata dalle scritture locali pertinenti. Le
scritture di un processo esterno possono restare invisibili alla cache fino
alla scadenza. Cambiare squadra nella UI non ricarica l'intero riepilogo.

L'orario previsto è **03:00 Europe/Rome**: cron `0 1 * * *` in estate e
`0 2 * * *` in inverno. Lo script sceglie il cron attivo dall'offset e dal
trigger originale, anche in caso di ritardo GitHub; l'altro run termina senza
sync. Il gruppo di concurrency impedisce sovrapposizioni tra run del workflow.
Un run verde con `Skip scheduled run` non dimostra che la sync sia riuscita.

Dopo il push, la CI verifica il codice. Per verificare l'intera nightly contro
il DB configurato usare `Actions → Nightly Sync → Run workflow` e controllare
gate, copertura delle stagioni, snapshot e conclusione del run effettivo.
Questa verifica esegue gli import e le scritture del normale job.

## Preparazione dei pronostici dopo il deploy

`Prepare prediction calibration` (`calibration-warm.yml`) prepara i profili
delle cinque leghe a ogni push pertinente su `main`, senza aspettare la nightly.
Include il profilo live e i cutoff prematch delle ultime dieci partite concluse
per lega. Anche la nightly usa il comando con verifica del riuso persistito,
entro il timeout previsto, invece della sola risposta della route di warmup.
È disponibile anche da **Actions → Prepare prediction calibration → Run workflow**.
Richiede solo i due secrets Turso già previsti. Esegue la calibrazione completa
sul runner e verifica il riuso persistito da un nuovo servizio; non importa dati,
non richiama provider quote e non registra giocate. Applica solamente la migrazione
additiva della cache, quando necessaria.

Il comando equivalente, con le credenziali già nell'ambiente, è
`cd backend` seguito da `npm run build` e `npm run calibration:warm`.
La build pulisce `dist` per evitare che moduli compilati rimossi in passato
alterino l'impronta rispetto al container. Il workflow e Hostless devono avere
la stessa configurazione dei modelli (`MODEL_*`, se personalizzata).

Attendere il risultato verde **calibration_verified** del job: un deploy può
diventare disponibile prima che la preparazione termini. Se la coorte cambia
prima della nightly o la configurazione differisce, resta necessario il calcolo
completo; la preparazione non autorizza l'uso di profili obsoleti.

Diagnosi e misure del percorso replay:
[riduzione CPU del 18 ottobre](performance/runtime-throttling-2026-10-18.md).
