# Nightly GitHub Actions e puntate virtuali A/C

**Correzione locale v2 dei mercati — rilascio remoto non attestato.**
A mantiene il proprio motore e tutti i mercati squadra già supportati,
inclusi cartellini e tiri con dati e quote reali sufficienti. C conserva il
catalogo gol concordato. La Nightly esegue i consigli dei due percorsi con
i rispettivi stake e i controlli tecnici/contabili; non crea un terzo modello
né restringe A al catalogo di C. Gli snapshot cloud sotto restano evidenze
della policy v1 precedente. [Specifica corrente](operations/recommendation-execution-2026-10-30.md).

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


Direzione aggiornata al 30 ottobre 2026: **Nightly Pre-Match Virtual Betting**.
Nello snapshot delle 11:08 UTC il recupero `41044931407` aveva cinque incontri
cumulativi, dieci decisioni e zero puntate; dettagli nella sezione seguente. Il riepilogo
del predecessore qui sotto resta il risultato delle 10:12 UTC, non il totale odierno.
Nel primo recupero delle10:12 UTC era LIVE il backend `01320941`, quota riconciliata alle 10:01:04 UTC e registrazione
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
nessun altro caller. Erano allora LIVE `01320941`/`fb0e30f8`, prima del rilascio
attuale eb5/3c e delle cinque nuove puntate della policy Partite.

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

## Integrazione delle viste contabili: locale, in verifica

La nuova disposizione di Giocate/Budget/Archivio legge gli stessi A/C tramite
`GET /api/wallets`. Non aggiunge workflow, scritture finanziarie, una seconda
esecuzione notturna o POST legacy. I cinque BET già registrati non sono un
nuovo risultato della UI. Research conserva benchmark e modelli; il contratto
dei dati mantiene aggregati completi e dettaglio massimo 500 esplicito.
La pubblicazione e la verifica remota di queste viste restano pendenti.

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
    future e acquisire i consigli dei rispettivi motori con quote reali.
    A conserva il catalogo del proprio `PredictionService`; C i mercati gol
    concordati. L'esecuzione non rifà il ranking di A su un sottoinsieme comune.
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

## Nuova policy pubblicata del consiglio Partite

Dopo le origini DIAGNOSTIC a stake zero, il nuovo ramo opt-in valuta esecuzioni
con policy/input distinti, senza riscrivere i dieci ABSTAIN precedenti. A usa
PredictionService `APP-A` con versione/hash di stato, consiglio e stake esatti
della pagina Partite; C906/baseline 80 usa 1%. Esposizione5%, massimo una puntata
per match/modello, stessi due portafogli da 1.000 euro e ledger esistente.
Il picker canonico backend replica Low/Medium/High e ranking; nessun riordino UI.

La migrazione additiva023 e il suo FK bet→execution sono applicati sul
personale alle 13:14 UTC, inizialmente con quattro tabelle vuote. La policy
finanziaria è ora attiva e ha registrato cinque puntate verificate. Quote reali ≤300 secondi, settlement
supportato, capitale e unicità globale restano richiesti. Il benchmark e le
origini research mantengono 50/Hoeffding; non bloccano questa nuova esecuzione
virtuale. C scarta push/quarti non supportati e cerca un altro candidato;
A conserva le linee supportate da GoalSettlement. Nessuna promozione C.

Il nuovo flag è ora `true`: dopo preview e migrazione, backend eb5 e UI3c
sono LIVE. Il run `41069572500` ha registrato cinque puntate virtuali
(3 A/2 C), con audit 71/71 PASS e saldi verificati. Il settlement resta da osservare. Per rollback disabilitare
questo flag e mantenere settlement e viste aggiornate delle esecuzioni;
un backend vecchio non deve attribuire nuove BET alle origini diagnostiche a stake zero.

## Configurazione dichiarata nel codice

| Variabile | Default / ruolo |
| --- | --- |
| `NIGHTLY_ORCHESTRATOR` | `github_actions`, disabilita gli scheduler periodici duplicati nel web |
| `RESEARCH_NIGHTLY_ENABLED` | Opt-in del processo A/C, default `false` |
| `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` | Default `false`; variabile repository ora `true`, esecuzione Partite attiva e verificata |
| `RESEARCH_NIGHTLY_HOUR`, `RESEARCH_NIGHTLY_MINUTE` | Default locale 3/0; produzione, monitor e dashboard 3/7, coerenti col workflow |
| `RESEARCH_NIGHTLY_WINDOW_HOURS` | Non impostata: fino alla prossima 03:07 Roma; durata configurabile 1–48 ore |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | 300 alla decisione notturna, controlla acquisizione e aggiornamento del mercato |
| `RESEARCH_NIGHTLY_MIN_EV` | 0,04, soglia della diagnosi research precedente |
| `RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV` | 0,01, soglia prudenziale della diagnosi/benchmark |
| `RESEARCH_NIGHTLY_TIMEOUT_SECONDS` | 1200 per il processo A/C nello script |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false`, percorso precedente non necessario e non concorrente |
| `RUN_ODDS_SYNC` | `false`, raccolta informativa generale disattivata |
| `ODDS_INFORMATIONAL_NETWORK_ENABLED` | `false`, dashboard prevalentemente su cache |
| `ODDS_EXTRA_EVENT_NETWORK_ENABLED` | `true` nel workflow locale v2, mercati per evento A entro cache e budget esistenti; non ancora attestato nel rilascio remoto |

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
prezzi base fra A/C, con limite 500 crediti e riserva informativa 50. I mercati
per evento di A restano soggetti ai flag e al costo del provider; non sono
trasferiti a C e non rientrano nella stima del solo feed base. Quote
mancanti, obsolete, sintetiche, senza bookmaker o fuori budget restano escluse.
L'opt-in locale `.env` resta separato e Docker non abilita l'automazione per
default. L'abilitazione degli extra nel job finito non abilita la rete
informativa della dashboard e non garantisce copertura dei mercati aggiuntivi.
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
in `main` e scrive nel DB dei secret correnti. I cambi esclusivamente in
`backend/src/research/**` sono esclusi dal trigger: modificare C non deve
preparare automaticamente la calibrazione A. La pubblicazione tramite PR e il cutover sono
avvenuti; i workflow riattivati usano i secret personali RW/RO. Training
settimanale attivo, Registry writes `true` per candidature con policy qualità C;
questo non autorizza l'adozione dai soli risultati storici. Evitare futuri
collegamenti divergenti. `research-training.yml` resta distinto: registry, validazione
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

Rollback delle nuove puntate: impostare `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=false`,
mantenere workflow completo e backend compatibile 023; preservare liquidazioni
e storico e non ripristinare la chiamata automatica legacy o `AUTO_BET_*`.
Usare i backup verificati del nuovo canonico per il rollback; non riaprire
collegamenti all’originale bloccato o dichiarare recuperati delta ignoti. I test sintetici
vanno su DB isolati; il collaudo remoto deve includere un ciclo prospettico
reale senza forzare una puntata. Il precedente
[report T−15](operations/production-status-2026-10-29.md) resta storico e non è
la procedura di attivazione di questa nightly.
