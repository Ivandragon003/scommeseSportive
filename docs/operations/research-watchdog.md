# Controllo esterno del worker T−15

Preparato il 27 ottobre 2026; nessuna esecuzione remota o notifica attivata.

Il backend HTTP sano non dimostra che il worker funzioni. `backend/scripts/check-research-worker.js` legge direttamente il Turso condiviso, anche quando il backend Hostless è irraggiungibile. Usa soltanto `SELECT`: non importa `DatabaseService`, non applica migrazioni, non invoca il provider quote e non registra puntate.

Dal computer o da un runner indipendente, dopo `npm ci` e `npm run build` in `backend`, configurare l'URL del database e un token **di sola lettura**, senza stamparli:

```powershell
$env:RESEARCH_WATCHDOG_EXPECT_ENABLED = 'true'
node scripts/check-research-worker.js
```

Restituisce JSON ed exit code 0 quando i controlli passano, 1 per errore, database irraggiungibile o processo non sano. Timeout complessivo: 15 secondi. Non impostare `EXPECT_ENABLED=true` durante la fase intenzionalmente disabilitata; lo stato `DISABLED`/`UNOBSERVED` non significa worker operativo. Prima migrare lo schema con la procedura autorizzata: il monitor non lo crea.

Controlli e informazioni:

- Worker attivo, disabilitato o mai osservato; heartbeat massimo 45 secondi, lease valida e ultimo tick completato entro 90 secondi. Un heartbeat fresco con tick bloccato fallisce ugualmente.
- Ultime decisioni A/C e ritardo rispetto al loro T−15, conteggio job per stato/motivo. Segnala `scheduler_missed_decisions` per job `MISSED` o ancora `PENDING`/`CLAIMED` con target nell'ultima ora e finestra di 60 secondi già trascorsa. Astensioni deliberate e job futuri non sono decisioni mancate.
- Ultimi errori sicuri e tre esecuzioni consecutive fallite nell'ultima ora per scheduler, provider o liquidazione. Legge fino a 100 run per componente, evitando che i tick frequenti nascondano gli altri componenti. Tre errori del modello per la stessa famiglia/versione producono `persistent_model_errors`: un successo di A o di un'altra versione C non li cancella. I payload dei run non sono copiati nell'output.
- Stato Smart Odds, budget 500, riserva 50, crediti osservati e disponibili conservativi, cache e provenienza osservata. Questi sono gli ultimi dati registrati, non una nuova interrogazione all'API. Cache recente non dimostra quota bookmaker aggiornata: l'ammissione T−15 controlla anche il timestamp originario del prezzo.
- Ultima liquidazione e puntate di partite concluse ancora da liquidare; errore se manca una liquidazione recente riuscita a fronte di arretrato.

Con worker abilitato o atteso, `odds_credits_exhausted` segnala disponibilità conservativa pari a zero. Un credito residuo resta distinto dall'esaurimento, anche se può non bastare per il bundle T−15: l'ammissione atomica continua a impedire richieste superiori al budget.

`odds_unavailable_prolonged` richiede tentativi effettivi falliti distribuiti su almeno 15 minuti nell'ultima ora. Considera errori/risposte vuote del provider, job con evento o quote indisponibili e snapshot privi di un prezzo valido. Uno snapshot successivo con almeno una quota reale temporalmente valida risolve questa segnalazione; il solo timestamp HTTP recente non rende valida una quota bookmaker vecchia. La lettura considera fino a 100 snapshot e 100 job con indisponibilità recenti. Un calendario senza decisioni e una cache vecchia, da soli, non generano allarme. È un controllo di assenza complessiva: non attesta copertura di ogni campionato o mercato.

Questi nuovi controlli operativi, e gli errori ripetuti di scheduler/provider, non generano allarmi con worker intenzionalmente disabilitato e non atteso. Liquidazioni arretrate ed errori persistenti di liquidazione rimangono controllati anche in quel caso, perché le giocate già aperte devono restare liquidabili. L'assenza di evidenze non viene trasformata in un errore modello. La finestra di un'ora limita gli allarmi storici; il codice non modifica né riconcilia job, quote o budget.

`.github/workflows/research-watchdog.yml` è pronto per l'esecuzione manuale. Richiede il nuovo secret `TURSO_WATCHDOG_READONLY_TOKEN`, che il proprietario dovrà creare e autorizzare separatamente; non riutilizza automaticamente il token di scrittura. Non abbiamo creato né modificato chiavi. Non richiede accesso a Hostless, chiavi quote o servizi a pagamento. Le notifiche di fallimento dipendono dalle preferenze GitHub del proprietario.

Dopo il collaudo remoto il mandato di produzione autorizza una pianificazione
indipendente su GitHub Actions, per esempio ogni cinque minuti (`*/5 * * * *`),
impostando `RESEARCH_WATCHDOG_EXPECT_ENABLED=true` anche per l'evento pianificato.
Non serve una nuova conferma per il normale passaggio tecnico già autorizzato;
servono accesso, token di sola lettura e verifica dei limiti gratuiti. Finché
manca questa attivazione il rilevamento esterno è manuale. GitHub può ritardare
i job: questo monitor non sostituisce lo scheduler con polling di 15 secondi,
né garantisce un allarme entro 60 secondi. Verificare disponibilità di minuti
Actions e notifiche gratuite prima di abilitarlo.

## Verifica locale ripetibile

```powershell
cd backend
node --test --test-concurrency=1 test/research-watchdog.test.js test/smart-odds-process.test.js test/smart-odds-request-store.test.js
```

Le fixture usano SQLite/libSQL locale senza rete. Coprono arresto/ripartenza di veri processi Node separati, deduplicazione di una sola acquisizione simulata, conservazione conservativa del credito in caso di crash, heartbeat fermo, tick bloccato, lease scaduta, modalità disabilitata e assenza di scritture del monitor. I test del watchdog verificano inoltre crediti esauriti, finestre mancate o bloccate, indisponibilità quote persistente e recupero con quota valida, separazione degli errori per modello/versione e mancata esposizione dei payload privati. Non dimostrano latenza o disponibilità del Turso remoto né risultati sportivi reali.

Estensione dei controlli del 27 ottobre: 31/31 test mirati superati con il comando sopra, zero skip; lint di script e test e controllo whitespace superati. Una prima esecuzione parallela su Windows ha concluso tutte le assertion Smart Odds ma segnalato errore finale del relativo file senza stack; la ripetizione seriale ha superato anche il teardown. Non è una prova di disponibilità remota.

## Audit della concorrenza Smart Odds

Budget, riserva, cache, snapshot e controlli di provenienza restano quelli esistenti. I test con processi separati hanno riprodotto una race di avvio: la creazione dei trigger di immutabilità poteva incontrare `SQLITE_BUSY` prima del retry già previsto per le transazioni. L'inizializzazione ora usa lo stesso retry limitato, e una promessa di inizializzazione fallita non blocca tutti i tentativi successivi del processo. La decisione di ammettere la richiesta e prenotarne i crediti continua a essere una transazione condivisa, protetta da lease e token; nessuna quota o credito viene creato dai test.

Web, worker e altri processi autorizzati devono usare lo stesso Turso e lo stesso `ODDS_API_ACCOUNT_SCOPE` stabile (default `primary`) per ogni account provider condiviso. Scope diversi per chiavi appartenenti allo stesso account spezzerebbero il budget comune; la rotazione della chiave non deve cambiare lo scope. Tutte le istanze devono conservare budget 500 e riserva 50 coerenti. Questa configurazione reale resta da verificare sull'account.

Verifica eseguita localmente: build TypeScript, 26 test mirati superati, lint dei file interessati e parsing YAML. Dopo la correzione della race i due test di processo sono stati ripetuti cinque volte, tutti superati. Il watchdog non è stato eseguito su Turso remoto e la pianificazione GitHub resta disattivata.
