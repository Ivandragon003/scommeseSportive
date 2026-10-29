# Nightly GitHub Actions e puntate virtuali A/C

Direzione aggiornata il 29 ottobre 2026: **Nightly Pre-Match Virtual Betting**.
La [guida canonica](operations/nightly-pre-match-2026-10-29.md) conserva il
piano di attivazione e i risultati effettivi. Il backend `63d7cb96` è LIVE
sul personale, con health, route legacy HTTP 410 e sessione verificati. Il cutover è
effettivo; nightly attiva, flag `true` e workflow attivo. Primo run manuale
`40944747548`, creato alle 19:57:46 UTC, è SUCCESS; job finito alle
20:04:35 UTC. Il riepilogo registra zero nuove puntate; un
ciclo reale con liquidazione non è ancora attestato. Il training
settimanale e Odds Smoke manuale sono riattivati, Registry writes `false`.
L'adozione del dump 15:17 UTC resta la baseline autorizzata, con delta
successivi della sorgente bloccata non verificabili e accettati.

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

Il workflow legge `vars.RESEARCH_NIGHTLY_ENABLED`, con fallback `false`. La
variabile remota è ora `true`. Il flag nel backend Hostless
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
in `main` e scrive nel DB dei secret correnti. La pubblicazione tramite PR e il cutover sono
avvenuti; i workflow riattivati usano i secret personali RW/RO. Training
settimanale attivo, Registry writes `false`; evitare futuri collegamenti divergenti. `research-training.yml` resta distinto: registry, validazione
cronologica, Champion–Challenger e rollback sono preservati. C resta Challenger;
ROI migliore o mercati `EXPERIMENTAL` tecnicamente idonei non ne autorizzano
la promozione statistica.

L'[audit Turso/CPU](operations/turso-cpu-audit-2026-10-29.md) misura riduzione del
payload delle quote storiche e UPDATE evitati su partite identiche. I dati
locali non certificano righe fatturate o CPU Hostless risolti. Non si cancella
lo storico per ridurre i consumi e non si riattivano fonti ritirate.

## Monitoraggio e riepilogo

Il monitor GitHub e il controllo DB periodico sono attivi, con token DB
in sola lettura e nessun fallback RW. Il monitor `4dff28f4` è pubblicato:
CI `40944506327` SUCCESS, dieci test mirati e revisione DST superati; smoke RO
`40945351072` SUCCESS. Audit RO 20:07 UTC PASS e quattro fingerprint finanziari
invariati. Anche `RESEARCH_NIGHTLY_MONITOR_ENABLED=true` è ora attivo: le
attese della nightly delle 03:00 sono abilitate, separatamente dal flag BET.

Contabilità, quota, errori e stalli recenti oltre quattro ore non dipendono
dall'aspettativa programmata. Il watchdog con attese attive `40946558140`
è SUCCESS, tutti i passi GitHub e DB RO completati in 26 secondi. Il vecchio
heartbeat T−15 non è un requisito.

La dashboard distingue abilitazione dichiarata dal backend web, `enabled`
realmente osservato nell'ultimo job, manutenzione completa, import ed esito
A/C. Mostra partite analizzate, registrazioni, salti, API, quota e liquidazioni.
Gli orari attesi rispettano DST e tolleranza; assenza di misure resta esplicita.
Solo con la nuova nightly abilitata e il reconcile eseguito viene preparata
la riga del riepilogo precedente, con `publishAfter` alle 09:00 Europe/Rome.
Il GET filtra la visibilità senza scritture o invio esterno. Nessuna notifica
per ogni puntata. Il job SUCCESS non prova da solo un nuovo riepilogo:
la riga pubblicabile va verificata dopo il reconcile. Nessun nuovo servizio a pagamento
è stato attivato.

## Pubblicazione, migrazione e rollback

Il personale è ora il canonico unico di web e GitHub. 020/021 applicate,
export finale 18:58 UTC e parità 19:00 UTC PASS: 57 tabelle e 133 oggetti di schema,
storico 52 tabelle preservato. Secret GitHub RW/RO personali aggiornati alle
19:03 UTC, ambiente Hostless distribuito e configurazione locale produzione
allineata. Warmup `40937894463` e probe C `40936914212` sono riusciti.

L'adozione del dump 15:17 UTC / 16:17 Roma è quella autorizzata dall'utente,
con accettazione dei delta successivi non verificabili sulla sorgente bloccata.
Questo limite non è diventato una parità live. L'originale non è eliminato:
la CLI è personale, quindi serve il proprietario per la dismissione dopo
verifica della nuova applicazione. Vedi
[procedura Turso](operations/turso-personal-migration-2026-10-29.md) e
[guida Hostless](operations/hostless-deployment.md).

La nightly è attiva e il run manuale `40944747548` è SUCCESS, senza nuove
puntate. L’audit RO 20:10:52 UTC conferma `missedMatches=2`: due partite già
iniziate e correttamente escluse, senza job o decisioni di modello. Nessun evento eleggibile nella finestra restante, nessuna puntata
retroattiva; ciclo prospettico reale fino alla liquidazione ancora pendente.
Il flag del backend non avvia autonomamente il job; la richiesta usa GitHub.

Rollback: impostare `RESEARCH_NIGHTLY_ENABLED=false`, preservare liquidazioni
e storico e non ripristinare la chiamata automatica legacy o `AUTO_BET_*`.
Usare i backup verificati del nuovo canonico per il rollback; non riaprire
collegamenti all’originale bloccato o dichiarare recuperati delta ignoti. I test sintetici
vanno su DB isolati; il collaudo remoto deve includere un ciclo prospettico
reale senza forzare una puntata. Il precedente
[report T−15](operations/production-status-2026-10-29.md) resta storico e non è
la procedura di attivazione di questa nightly.
