# Monitoraggio Nightly Pre-Match Virtual Betting

**Portafogli nelle pagine normali dell’app — integrazione locale in verifica.**
Il nuovo requisito porta A/C in **Giocate, Budget e Archivio**, con filtro per
modello e confronto. Sono gli stessi portafogli e le stesse cinque BET già
finanziate: nessuna copia, migrazione, nuova puntata o addebito. La lettura
`GET /api/wallets` riusa il confronto contabile esistente; aggregati completi
e dettaglio limitato a 500 righe sono distinti. Lo storico precedente di 258
giocate resta consultabile separatamente, senza attribuirlo ad A o sommarne
il capitale. Research rimane dedicato a benchmark e modelli, non alla gestione
dei saldi. Questa integrazione non è ancora attestata LIVE: lo snapshot
cloud qui sotto riguarda la UI precedente e la policy già attiva. Nightly,
modelli e infrastruttura non cambiano.

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
[Specifica e avanzamento](recommendation-execution-2026-10-30.md)


L’integrazione locale di Giocate/Budget/Archivio non modifica il controllo
contabile: il monitor continua a leggere gli stessi A/C, ledger e BET, senza
creare nuovi patrimoni o attribuire lo storico precedente ad A. La nuova
`GET /api/wallets` è una lettura; la sua verifica UI remota resta distinta
dall’esito del watchdog già osservato. Nessun worker o controllo T−15 viene
attivato da questa revisione.

Configurazione aggiornata al 30 ottobre 2026. Scheduler e runtime usano 03:07
Europe/Rome, con recuperi 04:17/05:27. Nel precedente recupero era LIVE il backend `01320941`, con registrazione
A/C riattivata dalle 10:04 UTC dopo riconciliazione quota. Run reale `41038096151`
SUCCESS con quattro incontri e otto astensioni A/C; watchdog indipendente
`41039066641` e `41039490287` SUCCESS. Il duplicato `41039455356` è fermato prima di npm/build
e del ciclo DB/provider, con audit RO del duplicato PASS alle 10:22:18 UTC, senza nuovi run DB
o record provider. Il trigger
programmato 31 ottobre 03:07 e il ciclo sportivo fino alla liquidazione sono
ancora da osservare. Nessun SLA al minuto; vedi la
[nota del 30 ottobre](nightly-recovery-2026-10-30.md). Fix frontend `fb0e30f8`
Deployed LIVE su Hostless, Site Running, deployment `6ae46ff81a67b8db20fa2f2e`;
CI `41039799271` SUCCESS.

Verifica browser dopo il LIVE: sessione autenticata conservata, Sistema
mostra Riuscita alle 11:12 Roma, quattro partite e zero errori/API errori.
Prossimo run 31 ottobre 03:07 e testo «Orario di riferimento: 03:07 Europe/Rome»
verificati; quota 196 residui/304 usati e database raggiungibile. Le prove
restano private; questa è verifica dell'app effettiva, oltre al badge Hostless.

Il comando attivo `npm run research:watchdog` usa [check-research-nightly.js](../../backend/scripts/check-research-nightly.js). Non controlla heartbeat o puntualità T−15: il worker continuo è stato sostituito dall’elaborazione notturna. Il checker non avvia l’applicazione, non applica migrazioni, non contatta il provider quote e non registra puntate.

## Controllo indipendente tramite GitHub

Da `backend`, con `GITHUB_TOKEN` e `GITHUB_REPOSITORY` già forniti in ambiente in modo sicuro:

```powershell
npm run research:watchdog -- --github-only
```

Questo percorso usa solo moduli Node e GitHub API; non richiede token database, build backend o dipendenze npm. Il token deve poter leggere le esecuzioni Actions del repository corretto. Il workflow usa il token temporaneo GitHub con permessi `contents: read` e `actions: read`.

`RESEARCH_NIGHTLY_MONITOR_ENABLED=true` richiede il lavoro programmato
principale delle 03:07 Europe/Rome. Le opportunità 04:17/05:27 sono recuperi,
non tre elaborazioni obbligatorie. Il margine iniziale resta quattro ore,
senza garanzia sui ritardi GitHub. Il monitor legge l'esito reale del passo
`Run nightly sync` e del marker `Confirm enabled A/C completion` nello stesso
job: uno stato verde/cancellato senza questi passi riusciti non prova il ciclo
A/C. La sola manutenzione con A/C disabilitate non consuma la giornata. Il guard giornaliero usa gli stessi metadati prima di npm/build:
un vero successo della giornata Roma impedisce un secondo ciclo con
scritture/provider. API o metadata incerti bloccano il gate.

Uno stallo recente oltre quattro ore o un fallimento resta visibile anche
con aspettative programmate spente; i normali run storici sono osservati
nella finestra di 36 ore. La compatibilità dei precedenti cron UTC è limitata
alla storia prima del nuovo programma, senza considerare il cron estivo o
invernale intenzionalmente inattivo come sync riuscita. La selezione del run
atteso resta distinta dal controllo degli stalli e non nasconde un errore
precedente solo perché esiste un run più recente riuscito.

L'eccezione esplicita è il vecchio evento `40940944902`: la variabile
`RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS` può riconoscere solo quel run
se ancora `queued`, con zero job e di una giornata precedente. Non viene
cancellato e non è una sync. Se acquista job o cambia stato torna fatale come
`github_acknowledged_orphan_revived`, anche dopo 36 ore o se termina. La
verifica diretta dell'ID oltre la finestra storica impedisce che una sua
riattivazione passi inosservata. Altri errori o stalli non sono esclusi.

Un workflow concluso con successo non dimostra che siano state registrate decisioni: questa evidenza richiede il controllo database. Una corretta astensione può comunque produrre zero puntate.

## Controllo database opzionale, solo lettura

Dopo installazione delle dipendenze e build backend, configurare in ambiente `TURSO_DATABASE_URL` e **`TURSO_WATCHDOG_READONLY_TOKEN` dedicato di sola lettura**. Il codice non usa `TURSO_AUTH_TOKEN` come ripiego. Lo schema deve essere già presente: il checker non lo crea.

```powershell
npm run research:watchdog -- --database-only
```

`RESEARCH_NIGHTLY_EXPECT_ENABLED=true` richiede un run decisionale effettivo e coerente con l’abilitazione attesa. Nel workflow deriva da `inputs.expect_enabled` oppure `vars.RESEARCH_NIGHTLY_MONITOR_ENABLED`, con default `false`: non deriva dal flag delle puntate. All’avvio si può mantenere `RESEARCH_NIGHTLY_DB_MONITOR_ENABLED=true` e `RESEARCH_NIGHTLY_MONITOR_ENABLED=false`, controllando il database senza pretendere una nightly precedente all’attivazione. Nessuno di questi flag abilita o disabilita le puntate. Produzione, monitor
e dashboard sono allineati in configurazione a `RESEARCH_NIGHTLY_MINUTE=7`; il default locale del runtime
resta 0 per compatibilità, distinto dal nuovo orario GitHub 03:07.

Il checker esegue soltanto `SELECT`, senza leggere tutte le previsioni. Riporta l’ultima nightly osservata e i suoi conteggi realmente registrati: partite analizzate, puntate, astensioni, motivi, errori API, liquidazioni e quota disponibile. Un valore assente rimane assente. Verifica inoltre arretrati di liquidazione e coerenza dei movimenti dei due portafogli, rinviando il controllo contabile se il registro cambia durante la lettura. Crediti esauriti restano segnalati anche con aspettative programmate disabilitate, così come un fallimento reale o almeno tre errori API dell’ultimo run concluso osservato nelle ultime 36 ore. Evidenze future non sono considerate esiti conclusi; errori storici oltre questa finestra non restano allarmi correnti. Contabilità e liquidazioni rimangono sempre controllate quando il controllo database è attivo. Disabilitare l’aspettativa non maschera questi problemi osservati.

JSON ed exit code distinguono successo (`0`) e problemi (`1`). Gli errori di accesso non vengono trasformati in un esito sano. Le quote sono quelle già osservate nel database: il monitor non verifica di nuovo il piano del provider né garantisce la copertura di ogni partita.

Senza opzioni il comando verifica GitHub e, soltanto se sono presenti le credenziali dedicate, anche il database. In loro assenza restituisce esplicitamente `NOT_CHECKED` per il database. Con `--database-only`, credenziali mancanti causano errore.

## Nuova policy del consiglio: confine del monitor e rollout

Il ramo attivo `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` è separato
dalla diagnosi research e dalla sua aspettativa di run. A usa il pacchetto
Partite `APP-A` e stake indicato; C906 usa 1%, due portafogli da 1.000 euro,
esposizione 5%, max 1 per match/modello. Le origini DIAGNOSTIC restano a zero
stake e i dieci ABSTAIN precedenti non vengono modificati; il monitor non
deve interpretarle come BET del nuovo ramo. I nuovi record 023 e il FK bet→
execution distinguono esecuzione effettiva e origine. 50/Hoeffding resta nel
benchmark/diagnostica, senza veto per questa nuova esecuzione virtuale.

Il checker non attiva la policy. Il nuovo flag è stato abilitato dopo i
rilasci LIVE backend eb5/UI3c. Il run reale `41069572500` ha cinque BET
(3 A/2 C), audit 71/71 PASS; watchdog automatico `41070547360` SUCCESS, controlli
GitHub e DB `ok=true`/`issues=[]`, Nightly SUCCESS e `overdue=false`.
Lo stato provider DEGRADED include un errore storico nel ledger: non va
confuso con un guasto corrente del job o cancellato per mostrare tutto verde.
Il duplicato `41071349342` è stato saltato prima di app/provider.
Le quote esposte hanno
stato e timestamp storico, non una nuova verifica prezzo live. Il rollback
spegne il nuovo flag ma conserva settlement e letture compatibili con le
esecuzioni, senza attribuire le nuove BET alle origini a stake zero.

## Workflow e notifiche

[research-watchdog.yml](../../.github/workflows/research-watchdog.yml) è predisposto ogni ora al minuto 37, dopo il completamento di `Nightly Sync` e su avvio manuale. È indipendente dal backend Hostless e non attiva le puntate.

Configurazione nel repository GitHub (verificare lo stato remoto nel report di recupero):

- `vars.RESEARCH_NIGHTLY_MONITOR_ENABLED`: aspettativa del run programmato sia su GitHub sia nel database, default `false`. Un input manuale `expect_enabled=true` la richiede per quel controllo.
- `vars.RESEARCH_NIGHTLY_DB_MONITOR_ENABLED`: controllo database opzionale, indipendente dalla registrazione A/C.
- `secrets.TURSO_DATABASE_URL` e `secrets.TURSO_WATCHDOG_READONLY_TOKEN`: necessari soltanto per il controllo database.
- `vars.RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED`: opt-in della policy Partite, default `false`, ora `true` e verificato remotamente.
- `vars.RESEARCH_NIGHTLY_ENABLED`: abilita il processo A/C; riattivata alle 10:04 UTC dopo il recupero controllato. Il watchdog non lo usa per pretendere retroattivamente una sync.
- `vars.RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS`: eventuale riconoscimento esplicito del solo `40940944902` nelle condizioni descritte sopra; non è una cancellazione.
- `RESEARCH_NIGHTLY_MINUTE=7`: allineamento del runtime di produzione e del monitor DB al nuovo programma, con default locale 0 invariato.

I fallimenti del controllo possono produrre notifiche secondo le preferenze GitHub dell’account. Nessun canale email esterno viene configurato o dichiarato consegnato da questo codice. La verifica reale di pianificazione, permessi, minuti gratuiti e notifiche resta separata dalla preparazione locale.

Il riepilogo in-app della giornata precedente viene preparato dalla nightly con contabilità stabile e reso visibile dalle **09:00 Europe/Rome**, rispettando DST. Conserva `createdAt` reale e `publishAfter` distinto, è idempotente per giorno e non richiede un processo di scrittura alle 09:00. GET non crea riepiloghi; le notifiche tecniche importanti restano visibili subito. Se il percorso nightly esce prima del database perché disabilitato, non viene preparato un nuovo riepilogo. Questa disponibilità in-app non equivale a un invio email.

## Verifica locale e compatibilità storica

```powershell
cd backend
node --test --test-concurrency=1 test/research-monitoring.test.js test/research-overview.test.js test/research-nightly-watchdog.test.js test/research-watchdog.test.js
```

La precedente verifica dei 37 test mirati è stata superata localmente il 29 ottobre 2026, senza chiamate a produzione o provider. La correzione delle aspettative iniziali e dei run accodati è stata verificata separatamente con i dieci test di `research-nightly-watchdog.test.js`, tutti superati: includono due portafogli integri prima del primo run, richieste di esecuzione mancante abilitate, code recenti o bloccate, limiti temporali, entrambi i cambi DST con esclusione dei cron inattivi ed errori osservati anche con aspettative disabilitate. Coprono anche DST, prima/dopo le 09:00, riepilogo non contaminato da evidenze future, astensioni, ritardi, fallimenti, assenza di scritture del checker e compatibilità del vecchio helper. Non dimostrano uptime remoto o completamento di un ciclo sportivo reale.

[check-research-worker.js](../../backend/scripts/check-research-worker.js) rimane disponibile per test e compatibilità con eventuali configurazioni esterne storiche non verificate. Non è richiamato dall’alias attivo né dal nuovo workflow: non va utilizzato per giudicare sano il nuovo sistema Nightly. Le precedenti verifiche T−15 sono documentate nel [report storico del 27 ottobre](hostless-readiness-2026-10-27.md).

## Riscontro quote del 30 ottobre

La configurazione GitHub è stata riallineata alle 09:29 UTC. Il probe remoto
`41035190734` è SUCCESS alle 09:41 UTC con 295 usati, 205 residui e costo 0:
non riceve token Turso e non acquisisce prezzi partita. CI quote `41035190628`
e warmup `41035190648` sono SUCCESS. Il salvataggio Hostless è write-only;
quel probe da solo non provava il riallineamento. Successivamente il backend
`01320941` era LIVE in quel checkpoint e la riconciliazione COMMITTED alle10:01:04 UTC aveva corretto
500/0 in 295/205, preservando i tracciati preesistenti. Tre fetch reali del
recupero hanno poi consumato 9 crediti: 304 usati/196 residui; limite 500/riserva 50
invariati. Il watchdog `41039066641` è SUCCESS dopo il run A/C reale.
Gli errori correnti non vengono nascosti dai run verdi del 29 ottobre.
