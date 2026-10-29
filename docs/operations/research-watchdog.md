# Monitoraggio Nightly Pre-Match Virtual Betting

Configurazione locale aggiornata il 29 ottobre 2026. Questa guida descrive il codice e il workflow preparati: non prova che la loro ultima revisione sia pubblicata, che i secret siano configurati o che una notifica esterna sia stata consegnata.

Il comando attivo `npm run research:watchdog` usa [check-research-nightly.js](../../backend/scripts/check-research-nightly.js). Non controlla heartbeat o puntualità T−15: il worker continuo è stato sostituito dall’elaborazione notturna. Il checker non avvia l’applicazione, non applica migrazioni, non contatta il provider quote e non registra puntate.

## Controllo indipendente tramite GitHub

Da `backend`, con `GITHUB_TOKEN` e `GITHUB_REPOSITORY` già forniti in ambiente in modo sicuro:

```powershell
npm run research:watchdog -- --github-only
```

Questo percorso usa solo moduli Node e GitHub API; non richiede token database, build backend o dipendenze npm. Il token deve poter leggere le esecuzioni Actions del repository corretto. Il workflow usa il token temporaneo GitHub con permessi `contents: read` e `actions: read`.

`RESEARCH_NIGHTLY_MONITOR_ENABLED=true` richiede l’esecuzione programmata delle 03:00 Europe/Rome, rispettando ora legale e solare. Il margine iniziale è quattro ore: non è una garanzia sui ritardi di GitHub. Un recupero manuale appena accodato mantiene il proprio margine, evitando falsi allarmi immediati. I run della seconda espressione cron, intenzionalmente esclusa dal controllo DST della nightly, non sostituiscono il run atteso. Un fallimento recente del workflow resta segnalato anche quando l’attesa del run programmato non è abilitata.

Un workflow concluso con successo non dimostra che siano state registrate decisioni: questa evidenza richiede il controllo database. Una corretta astensione può comunque produrre zero puntate.

## Controllo database opzionale, solo lettura

Dopo installazione delle dipendenze e build backend, configurare in ambiente `TURSO_DATABASE_URL` e **`TURSO_WATCHDOG_READONLY_TOKEN` dedicato di sola lettura**. Il codice non usa `TURSO_AUTH_TOKEN` come ripiego. Lo schema deve essere già presente: il checker non lo crea.

```powershell
npm run research:watchdog -- --database-only
```

`RESEARCH_NIGHTLY_EXPECT_ENABLED=true` richiede un run decisionale effettivo e coerente con l’abilitazione attesa. Non impostarlo durante una disabilitazione intenzionale. Questo flag di controllo non abilita le puntate.

Il checker esegue soltanto `SELECT`, senza leggere tutte le previsioni. Riporta l’ultima nightly osservata e i suoi conteggi realmente registrati: partite analizzate, puntate, astensioni, motivi, errori API, liquidazioni e quota disponibile. Un valore assente rimane assente. Verifica inoltre arretrati di liquidazione e coerenza dei movimenti dei due portafogli, rinviando il controllo contabile se il registro cambia durante la lettura. Crediti esauriti e almeno tre errori API vengono segnalati quando la registrazione è attesa. Contabilità e liquidazioni restano controllate anche quando non sono attese nuove puntate.

JSON ed exit code distinguono successo (`0`) e problemi (`1`). Gli errori di accesso non vengono trasformati in un esito sano. Le quote sono quelle già osservate nel database: il monitor non verifica di nuovo il piano del provider né garantisce la copertura di ogni partita.

Senza opzioni il comando verifica GitHub e, soltanto se sono presenti le credenziali dedicate, anche il database. In loro assenza restituisce esplicitamente `NOT_CHECKED` per il database. Con `--database-only`, credenziali mancanti causano errore.

## Workflow e notifiche

[research-watchdog.yml](../../.github/workflows/research-watchdog.yml) è predisposto ogni ora al minuto 37, dopo il completamento di `Nightly Sync` e su avvio manuale. È indipendente dal backend Hostless e non attiva le puntate.

Configurazione prevista nel repository GitHub:

- `vars.RESEARCH_NIGHTLY_MONITOR_ENABLED`: controllo del run GitHub programmato, inizialmente `false`.
- `vars.RESEARCH_NIGHTLY_DB_MONITOR_ENABLED`: controllo database opzionale, inizialmente disabilitato.
- `secrets.TURSO_DATABASE_URL` e `secrets.TURSO_WATCHDOG_READONLY_TOKEN`: necessari soltanto per il controllo database.
- `vars.RESEARCH_NIGHTLY_ENABLED`: abilitazione attesa dal controllo database; non sostituisce la conferma separata richiesta per attivare la registrazione virtuale.

I fallimenti del controllo possono produrre notifiche secondo le preferenze GitHub dell’account. Nessun canale email esterno viene configurato o dichiarato consegnato da questo codice. La verifica reale di pianificazione, permessi, minuti gratuiti e notifiche resta separata dalla preparazione locale.

Il riepilogo in-app della giornata precedente viene preparato dalla nightly con contabilità stabile e reso visibile dalle **09:00 Europe/Rome**, rispettando DST. Conserva `createdAt` reale e `publishAfter` distinto, è idempotente per giorno e non richiede un processo di scrittura alle 09:00. GET non crea riepiloghi; le notifiche tecniche importanti restano visibili subito. Se il percorso nightly esce prima del database perché disabilitato, non viene preparato un nuovo riepilogo. Questa disponibilità in-app non equivale a un invio email.

## Verifica locale e compatibilità storica

```powershell
cd backend
node --test --test-concurrency=1 test/research-monitoring.test.js test/research-overview.test.js test/research-nightly-watchdog.test.js test/research-watchdog.test.js
```

I 37 test mirati sono stati superati localmente il 29 ottobre 2026, senza chiamate a produzione o provider. Coprono anche DST, prima/dopo le 09:00, riepilogo non contaminato da evidenze future, astensioni, ritardi, fallimenti, assenza di scritture del checker e compatibilità del vecchio helper. Non dimostrano uptime remoto o completamento di un ciclo sportivo reale.

[check-research-worker.js](../../backend/scripts/check-research-worker.js) rimane disponibile per test e compatibilità con eventuali configurazioni esterne storiche non verificate. Non è richiamato dall’alias attivo né dal nuovo workflow: non va utilizzato per giudicare sano il nuovo sistema Nightly. Le precedenti verifiche T−15 sono documentate nel [report storico del 27 ottobre](hostless-readiness-2026-10-27.md).
