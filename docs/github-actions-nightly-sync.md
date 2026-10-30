# Nightly GitHub Actions e puntate virtuali A/C

**Nuova policy richiesta il 30 ottobre: implementata solo localmente, non
pubblicata né attivata.** A riproduce il consiglio della pagina Partite e la
sua percentuale di stake; C mantiene stake 1%. Due portafogli da 1.000 euro,
esposizione 5% e massimo una puntata per partita/modello. Il flag
`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` resta `false`. Backend `01320941`
e frontend `fb0e30f8` LIVE continuano sulla release precedente: i collaudi
remoti descritti sotto non attestano questa nuova policy. CI remota, preview
senza scritture finanziarie e attivazione restano pendenti.
[Specifica e avanzamento](operations/recommendation-execution-2026-10-30.md).


Direzione aggiornata al 30 ottobre 2026: **Nightly Pre-Match Virtual Betting**.
Il recupero calendario `41044931407` è verificato: cinque incontri cumulativi,
dieci decisioni, zero puntate; dettagli nella sezione seguente. Il riepilogo
del predecessore qui sotto resta il risultato delle 10:12 UTC, non il totale odierno.
Backend `01320941` LIVE, quota riconciliata alle 10:01:04 UTC e registrazione
A/C attiva dalle 10:04 UTC. Run `41038096151` su `8bf17826` SUCCESS 10:12:43 UTC,
con `Run nightly sync` e `Confirm enabled A/C completion` entrambi riusciti.
Quattro partite reali, otto decisioni/inferenze e quattro snapshot condivisi,
zero BET/errori/API errori; astensioni corrette, non un malfunzionamento.
Il duplicato `41039455356` salta npm/build/Sync/marker, senza avviare backend,
DB o provider; audit RO del duplicato PASS alle 10:22:18 UTC, senza nuovi run DB
o record provider. Watchdog `41039066641`
e `41039490287` SUCCESS. Restano da osservare trigger 31 ottobre 03:07 e risultati/liquidazioni.
[Nota del 30 ottobre](operations/nightly-recovery-2026-10-30.md); i run del 29
restano storici. Frontend `fb0e30f8` Deployed LIVE su Hostless, Site Running,
deployment `6ae46ff81a67b8db20fa2f2e`; CI `41039799271` SUCCESS.

Snapshot browser dopo il LIVE, prima del recupero Nice–Rennes: sessione autenticata conservata, Sistema
mostra Riuscita alle 11:12 Roma, quattro partite e zero errori/API errori.
Prossimo run 31 ottobre 03:07 e testo «Orario di riferimento: 03:07 Europe/Rome»
verificati; quota 196 residui/304 usati e database raggiungibile. Le prove
restano private; questa è verifica dell'app effettiva, oltre al badge Hostless.

## Recupero calendario verificato

Il verde `41038096151` copriva quattro partite su cinque: Nice–Rennes era
ancora nel DB al 31 ottobre. Il nuovo run `41044931407`, source `fd97d145`,
è SUCCESS 11:08:12 UTC, con Sync e marker enabled entrambi SUCCESS 11:08:07.
CI `41044683537` Backend/Frontend SUCCESS. Il guard ha ammesso il solo input
manuale `recover_missing_fixtures` con motivo `manual_missing_fixtures_recovery`,
dopo il predecessore riuscito `41038096151` e senza run attivi concorrenti.

`POST /api/system/sync-upcoming-kickoffs` viene eseguito dopo Understat e
prima di A/C, solo con A/C abilitate, Top 5 limite 160. La verifica remota ha
controllato 800 record e corretto 43 kickoff futuri con cinque
[GET eventi gratuiti](https://the-odds-api.com/liveapi/guides/v4/#get-events),
zero crediti. Nice–Rennes è passata da 31 ottobre 16:15 UTC a 30 ottobre 18:00 UTC
(19:00 Roma), coerente con il
[club](https://www.ogcnice.com/index.php/fr/article/131046/nice-rennes-avance-a-vendredi-19h.html).
Un errore del controllo calendario richiesto blocca nuove decisioni A/C,
conservando manutenzione e liquidazioni esistenti.

La fase A/C 11:07:41.440→11:08:04.729 UTC ha elaborato solo Nice–Rennes:
un nuovo input, due decisioni, 16 osservazioni e zero BET/errori/API errori/missed;
quattro esclusioni `decision_already_recorded` prima di API/inferenza.
Audit RO 11:10:02 UTC PASS: cinque input, dieci decisioni e dieci marker modello
complessivi, digest dei quattro input e delle otto decisioni precedenti
invariati. Sette hash finanziari e 258 legacy preservati, A/C 1.000 euro e zero
impegnati. Un solo fetch quote Nightly da 3 crediti: 307 usati/193 residui;
nessun altro caller. Backend e frontend LIVE restano `01320941`/`fb0e30f8`.

L'input resta manuale e default `false`; il percorso standard continua a
saltare dopo un vero successo giornaliero. Quel recupero verificato manteneva
i gate della precedente diagnosi50/EV 4%/prudenziale 1%; la nuova esecuzione
locale Partite non eredita il veto statistico, ma mantiene la freschezza. Il recupero è verificato,
ma cron 31 ottobre 03:07 e risultati/liquidazioni ufficiali restano futuri.
[Report completo](operations/nightly-fixture-recovery-2026-10-30.md).

## Orchestrazione e orario

Si estendono il [workflow esistente](../.github/workflows/nightly-sync.yml) e
lo [script](../scripts/ci/nightly-sync.sh), senza un secondo scheduler cloud.
Il nuovo workflow usa timezone nativa `Europe/Rome`, con principale 03:07 e
recuperi 04:17/05:27. La copia della programmazione è:

```yaml
schedule:
  - cron: '7 3 * * *'
    timezone: Europe/Rome
  - cron: '17 4 * * *'
    timezone: Europe/Rome
  - cron: '27 5 * * *'
    timezone: Europe/Rome
```

Il [guard](../backend/scripts/nightly-schedule-guard.js) legge soltanto GitHub
API prima di installazione npm e build. Verifica la giornata Europe/Rome e
l'esito effettivo del passo `Run nightly sync` seguito nello stesso job dal
marker `Confirm enabled A/C completion`: uno stato verde/cancellato
da solo non consuma la giornata senza quel passo riuscito. Un vero successo impedisce
un secondo ciclo con scritture/provider; API incerte, metadati incompleti o
identità incoerente bloccano il gate. La concorrenza `nightly-sync` rimane
seriale, con lease e vincoli DB contro duplicati. Un recupero dopo failure
può ripetere lavoro: non garantisce un'unica richiesta dopo un errore.

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
campioni idonei impone astensione nella diagnosi research: minimo 50 e
Hoeffding restano nel benchmark/diagnostica, senza refit o calibratori inventati.
La nuova esecuzione Partite locale è separata e non usa quel veto.

## Nuova policy locale del consiglio Partite

Dopo le origini DIAGNOSTIC a stake zero, il nuovo ramo opt-in valuta esecuzioni
con policy/input distinti, senza riscrivere i dieci ABSTAIN precedenti. A usa
PredictionService `APP-A` con versione/hash di stato, consiglio e stake esatti
della pagina Partite; C906/baseline 80 usa 1%. Esposizione5%, massimo una puntata
per match/modello, stessi due portafogli da 1.000 euro e ledger esistente.
Il picker canonico backend replica Low/Medium/High e ranking; nessun riordino UI.

La migrazione additiva 023 e il suo FK bet→execution sono solo collaudati su
ripristino: produzione non migrata. Quote reali ≤300 secondi, settlement
supportato, capitale e unicità globale restano richiesti. Il benchmark e le
origini research mantengono 50/Hoeffding; non bloccano questa nuova esecuzione
virtuale. C scarta push/quarti non supportati e cerca un altro candidato;
A conserva le linee supportate da GoalSettlement. Nessuna promozione C.

Il nuovo flag è `false`: codice non pubblicato/attivato, preview senza
scritture finanziarie e CI remota ancora pendenti. Per rollback disabilitare
questo flag e mantenere settlement e viste aggiornate delle esecuzioni;
un backend vecchio non deve attribuire nuove BET alle origini diagnostiche a stake zero.

## Configurazione dichiarata nel codice

| Variabile | Default / ruolo |
| --- | --- |
| `NIGHTLY_ORCHESTRATOR` | `github_actions`, disabilita gli scheduler periodici duplicati nel web |
| `RESEARCH_NIGHTLY_ENABLED` | Opt-in del processo A/C, default `false` |
| `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` | Nuovo opt-in locale della policy Partite, variabile repository omonima, default `false`; non attivata remotamente |
| `RESEARCH_NIGHTLY_HOUR`, `RESEARCH_NIGHTLY_MINUTE` | Default locale 3/0; produzione, monitor e dashboard 3/7, coerenti col workflow |
| `RESEARCH_NIGHTLY_WINDOW_HOURS` | Non impostata: fino alla prossima 03:07 Roma; durata configurabile 1–48 ore |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | 300 alla decisione notturna, controlla acquisizione e aggiornamento del mercato |
| `RESEARCH_NIGHTLY_MIN_EV` | 0,04, soglia della diagnosi research precedente |
| `RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV` | 0,01, soglia prudenziale della diagnosi/benchmark |
| `RESEARCH_NIGHTLY_TIMEOUT_SECONDS` | 1200 per il processo A/C nello script |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false`, percorso precedente non necessario e non concorrente |
| `RUN_ODDS_SYNC` | `false`, raccolta informativa generale disattivata |
| `ODDS_INFORMATIONAL_NETWORK_ENABLED` | `false`, dashboard prevalentemente su cache |

Il workflow legge `vars.RESEARCH_NIGHTLY_ENABLED`, con fallback `false`. La
variabile remota è `true` dalle 10:04 UTC dopo il recupero controllato. Il flag nel backend Hostless
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

Il monitor GitHub e il controllo DB periodico RO restano separati dal flag
BET: spegnere le nuove registrazioni non nasconde contabilità incoerente,
crediti esauriti o errori osservati. Il nuovo orario atteso è 03:07 Europe/Rome,
con runtime `RESEARCH_NIGHTLY_MINUTE=7`; default locale 0 per compatibilità.
Il recupero A/C reale è verificato; il watchdog aggiornato `41039066641` è SUCCESS.
Il trigger programmato del 31 ottobre 03:07 resta da osservare.
Il watchdog riuscito `40946558140` è una prova del 29 ottobre, non del rollout.

L'orfano noto `40940944902` può essere riconosciuto solo tramite
`RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS`: l'eccezione è limitata a quel
run ancora queued, senza job e di una giornata precedente. Non è cancellato.
Se acquista un job o cambia stato, torna fatale anche oltre 36 ore: non è una
soppressione generale degli allarmi. Vedi [watchdog](operations/research-watchdog.md).

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

Nello snapshot del 29 ottobre il run `40944747548` è SUCCESS senza puntate.
L'audit di quel giorno conferma due partite già iniziate escluse senza job o
decisioni retroattive. È un risultato distinto dal recupero del 30 ottobre:
quattro incontri reali, otto astensioni e 58 osservazioni congelate, con
risultati/liquidazioni ancora futuri. Il trigger 31 ottobre 03:07 resta da osservare.
Il flag del backend non avvia autonomamente il job; la richiesta usa GitHub.

Rollback: impostare `RESEARCH_NIGHTLY_ENABLED=false`, preservare liquidazioni
e storico e non ripristinare la chiamata automatica legacy o `AUTO_BET_*`.
Usare i backup verificati del nuovo canonico per il rollback; non riaprire
collegamenti all’originale bloccato o dichiarare recuperati delta ignoti. I test sintetici
vanno su DB isolati; il collaudo remoto deve includere un ciclo prospettico
reale senza forzare una puntata. Il precedente
[report T−15](operations/production-status-2026-10-29.md) resta storico e non è
la procedura di attivazione di questa nightly.
