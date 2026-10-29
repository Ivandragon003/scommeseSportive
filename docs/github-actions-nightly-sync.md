# Nightly GitHub Actions e puntate virtuali A/C

Direzione aggiornata il 29 ottobre 2026: **Nightly Pre-Match Virtual Betting**.
La [guida canonica](operations/nightly-pre-match-2026-10-29.md) conserva il
piano di attivazione e i risultati effettivi. Il codice descritto è locale:
`RESEARCH_NIGHTLY_ENABLED=false`, nuove registrazioni remote non attivate e
cutover Turso personale non eseguito. Non si ripristina il vecchio auto-betting.

## Orchestrazione e orario

Si estendono il [workflow esistente](../.github/workflows/nightly-sync.yml) e
lo [script](../scripts/ci/nightly-sync.sh), senza un secondo scheduler cloud.
Il workflow usa cron `0 1 * * *` UTC e `0 2 * * *` UTC; il gate sul trigger
originale seleziona quello delle **03:00 Europe/Rome**, gestendo l'ora legale
anche quando GitHub avvia il job in ritardo. Il run escluso dal gate non è
una sync riuscita. `concurrency: nightly-sync` evita sovrapposizioni del
workflow; lease e vincoli DB proteggono anche retry e chiamanti concorrenti.

GitHub non garantisce avvio esatto al minuto. La finestra delle decisioni
parte dall'istante effettivo del job finito A/C e arriva alla successiva
nightly prevista. `RESEARCH_NIGHTLY_WINDOW_HOURS`, se impostato, sceglie una
durata tra 1 e 48 ore. Un retry conserva finestra e policy originarie;
rinvii, nuovi kickoff e partite già iniziate vengono ricontrollati nel commit.
Una notte persa non viene ricostruita con puntate retroattive.

## Flusso e gate

1. Avviare il backend temporaneo sul runner con bootstrap e collector periodici
   disabilitati, sul database condiviso configurato.
2. Importare calendario, risultati e statistiche Understat e verificarne la
   copertura; applicare il supplemento HTTP/CSV consentito di football-data.co.uk
   solo ai campi mancanti, mantenendo provenienza e quote storiche distinte.
3. Aggiornare riferimenti fra competizioni e kickoff, rispettando la pausa
   giocatori/formazioni; normalizzare dati e verificare i gate obbligatori.
4. Liquidare le giocate esistenti quando gli esiti sono disponibili, mantenendo
   separati budget legacy e portafogli A/C; aggiornare le prediction concluse.
5. Preparare feature e cache di calibrazione per il codice/configurazione
   effettivi. Il training settimanale resta un workflow separato, non un
   riaddestramento per ogni previsione.
6. Se `RESEARCH_NIGHTLY_ENABLED=true` e i gate dati sono idonei, eseguire
   `backend/scripts/research-nightly.js`: caricare A/C, selezionare le partite
   future, acquisire snapshot reali comuni e applicare il Decision Engine.
7. Registrare al massimo una puntata per partita/modello o l'astensione, con
   capitale, idempotenza e kickoff ricontrollati atomicamente. Conservare
   motivi, timestamp, versione del modello e distanza della quota dal kickoff.
8. Salvare risultati del job, quote residue, liquidazioni, errori e riepilogo;
   mantenere learning review e stato finale subordinati ai rispettivi gate.

Lo script A/C è un processo finito sul runner, senza polling o heartbeat
Hostless. Non chiama `/bets/place` o `/automation/place-valid-bets`; la seconda
route resta ritirata con `410`. `AUTO_BET_ENABLED=true` non è il nuovo opt-in.
Se il percorso A/C è disabilitato, import, manutenzione e liquidazioni previste
dallo script continuano; non vengono create nuove puntate virtuali A/C.

Il [percorso prospettico](operations/nightly-model-runtime-2026-10-29.md)
congela osservazioni anche sulle astensioni prima degli esiti, senza creare
puntate o movimenti contabili. La migrazione additiva 021 e i risultati
append-only conservano timestamp ufficialmente osservati e identità del
modello/configurazione. Partizione nominale 80/20 tramite hash partita;
`FUTURE_TEST` escluso dai residui prudenziali. Il registro iniziale privo di
campioni idonei impone astensione: minimo 50 e Hoeffding non sono ridotti,
nessun refit o calibratore inventato; con il registro attuale non sono
ammesse BET iniziali.

## Configurazione dichiarata nel codice

| Variabile | Default / ruolo |
| --- | --- |
| `NIGHTLY_ORCHESTRATOR` | `github_actions`, disabilita gli scheduler periodici duplicati nel web |
| `RESEARCH_NIGHTLY_ENABLED` | Variabile repository omonima, default `false`; unico opt-in delle nuove registrazioni notturne A/C |
| `RESEARCH_NIGHTLY_HOUR`, `RESEARCH_NIGHTLY_MINUTE` | 3 e 0, confine della finestra in Europe/Rome; modificare coerentemente col workflow |
| `RESEARCH_NIGHTLY_WINDOW_HOURS` | Non impostata: fino alla prossima 03:00 Roma; durata configurabile 1–48 ore |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | 300 alla decisione notturna, controlla acquisizione e aggiornamento del mercato |
| `RESEARCH_NIGHTLY_MIN_EV` | 0,04, soglia sperimentale configurabile |
| `RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV` | 0,01, soglia sperimentale configurabile |
| `RESEARCH_NIGHTLY_TIMEOUT_SECONDS` | 1200 per il processo A/C nello script |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false`, percorso precedente non necessario e non concorrente |
| `RUN_ODDS_SYNC` | `false`, raccolta informativa generale disattivata |
| `ODDS_INFORMATIONAL_NETWORK_ENABLED` | `false`, dashboard prevalentemente su cache |

Il workflow legge `vars.RESEARCH_NIGHTLY_ENABLED`, con fallback `false`. Nessuna
variabile remota è stata impostata per attivarlo. Il flag nel backend Hostless
può dichiarare la configurazione per la dashboard, ma il web non avvia il job.

Secrets: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` e `ODDS_API_KEY` per le decisioni
con quote reali. Le credenziali non appartengono a codice, frontend, log o
artifact pubblici. La chiave opzionale API-Football non riattiva da sola i
percorsi sospesi. `PLAYER_DATA_ENABLED=false` e
`PLAYER_AVAILABILITY_ENABLED=false` mantengono la pausa giocatori/formazioni;
non sono riattivati da questo mandato.

`RUN_ODDS_SYNC=false` non vieta il feed essenziale del job A/C abilitato: sono
scopi diversi. Il gestore persistente prenota il costo e condivide cache e
snapshot fra A/C, con limite 500 crediti e riserva informativa 50. Quote
mancanti, obsolete, sintetiche, senza bookmaker o fuori budget restano escluse.
La freschezza è misurata alla decisione notturna, non a T−15. Vedi
[quote e proiezioni](operations/smart-odds-2026-10-27.md).

## Calibrazione, letture e modello

La nightly prepara i profili delle cinque leghe sul runner; Hostless li legge
dalla cache additiva Turso. Il riuso richiede gli stessi dati e quote ammessi,
configurazione effettiva e hash del codice `dist`. Un warmup di un altro commit
non è una prova di riuso. Dati fuori cutoff e risultati successivi non entrano
negli input prepartita. Non si riducono gate o finestre scientifiche per
nascondere un costo di calcolo.

Il workflow `Prepare prediction calibration` può partire su push pertinente
in `main` e scrive nel DB dei secret correnti. La pubblicazione di questo
mandato si prepara perciò su branch `codex/` e PR, senza push prematuro su
`main`. `research-training.yml` resta distinto: registry, validazione
cronologica, Champion–Challenger e rollback sono preservati. C resta Challenger;
ROI migliore o mercati `EXPERIMENTAL` tecnicamente idonei non ne autorizzano
la promozione statistica.

L'[audit Turso/CPU](operations/turso-cpu-audit-2026-10-29.md) misura riduzione del
payload delle quote storiche e UPDATE evitati su partite identiche. I dati
locali non certificano righe fatturate o CPU Hostless risolti. Non si cancella
lo storico per ridurre i consumi e non si riattivano fonti ritirate.

## Monitoraggio e riepilogo

Il nuovo watchdog GitHub osserva esecuzioni e ritardi tramite GitHub API con
`actions:read`; è indipendente dal runner monitorato. L'allarme per job
mancante è opt-in con `RESEARCH_NIGHTLY_MONITOR_ENABLED`. I controlli DB sono
un opt-in distinto con `RESEARCH_NIGHTLY_DB_MONITOR_ENABLED` e
`TURSO_WATCHDOG_READONLY_TOKEN`, senza fallback al token in lettura/scrittura.
Non viene più richiesto un heartbeat del worker T−15.

La dashboard distingue abilitazione dichiarata dal backend web, `enabled`
realmente osservato nell'ultimo job, manutenzione completa, import ed esito
A/C. Mostra partite analizzate, registrazioni, salti, API, quota e liquidazioni.
Gli orari attesi rispettano DST e tolleranza; assenza di misure resta esplicita.
Il riepilogo del giorno precedente è consultabile dalle 09:00 Europe/Rome.
Nessuna notifica per ogni puntata; la memorizzazione in-app non prova invio a
un canale esterno. Non è stato autorizzato un nuovo servizio a pagamento.

## Pubblicazione, migrazione e rollback

Il backup sorgente aggiornato è privato e verificato; l'account Turso personale
Starter gratuito è stato controllato. La CLI ufficiale è autorizzata e
operativa, con overage disabilitati
verificati sul piano gratuito. La copia iniziale è importata e confrontata
integralmente, con schema/conteggi/hash corrispondenti, integrità `ok` e FK0.
La parità riguarda i due snapshot (`liveParityVerified=false`): migrazione
delle connessioni e cutover non eseguiti. Restano sincronizzazione finale,
conferma dell'utente e deployment Hostless riuscito. Seguire la
[procedura Turso](operations/turso-personal-migration-2026-10-29.md) e la
[guida Hostless](operations/hostless-deployment.md). Non aggiornare soltanto i
secret della nightly mentre Hostless continua a scrivere sul vecchio DB.

Prima del cutover: backup finale, writer sospesi in modo controllato, parità,
configurazione coordinata di web/nightly/training/calibrazione e piano di
rollback da presentare all'utente. Sono richieste conferme separate prima
del cutover definitivo e dell'attivazione remota delle registrazioni A/C.
Le modifiche locali o una PR non attestano deploy o attivazione.

Rollback: impostare `RESEARCH_NIGHTLY_ENABLED=false`, preservare liquidazioni
e storico e non ripristinare la chiamata automatica legacy o `AUTO_BET_*`.
Non sovrascrivere il database corrente con un backup vecchio. I test sintetici
vanno su DB isolati; il collaudo remoto deve includere un ciclo prospettico
reale senza forzare una puntata. Il precedente
[report T−15](operations/production-status-2026-10-29.md) resta storico e non è
la procedura di attivazione di questa nightly.
