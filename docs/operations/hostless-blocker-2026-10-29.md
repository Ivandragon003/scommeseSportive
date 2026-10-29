# Hostless: worker non distribuito e cron non salvato, 29 ottobre 2026

Scheda tecnica pronta per il proprietario o per l'assistenza Hostless.
**Nessuna richiesta è stata inviata automaticamente.** Non contiene credenziali.

## Risorse interessate

- Progetto: `Ivandragon003's Project`, ID `6a838a83424e48848fce82b0`.
- Backend funzionante: `scommese-sportive-backend`, deploy LIVE
  `6ae3213f30465a147074f461`, revisione `122fd360`.
- Frontend funzionante: `scommese-sportive-frontend`, deploy LIVE
  `6ae322cd7b2d5d826aa0c130`.
- Worker embedded: `footpredictor-t15`, ID `6ae3240430465a1470752801`,
  0,1 vCPU/256 MiB, una replica. Ruolo account osservato: `Editor`.

## Riscontri ripetibili

1. La creazione Small è stata accettata; lista worker e lettura del record
   restituiscono `200`. La richiesta precedente a 512 MiB è stata annullata
   al requisito di aggiungere una carta; nessun upgrade effettuato.
2. La UI resta `DEPLOYING`/`Not deployed`. La lettura dello stato tramite
   `.../worker-processes/6ae3240430465a1470752801/deployment-status` restituisce
   `200` con `state: missing` e `ready: false`.
3. Il record del worker è leggibile con `200`, ma la lettura
   `.../6ae3240430465a1470752801/environment-variables` restituisce `404`,
   messaggio `App worker not found`. La pagina di modifica mostra errore di
   caricamento. Nessun heartbeat o runtime worker osservabile.
4. Redeploy esplicito e restart accodato non hanno prodotto un deployment
   pronto. Non sono stati ripetuti creazione o duplicazione della risorsa.
5. Il salvataggio di un cron embedded nell'app restituisce `400`, anche con
   timezone UTC, `*/5 * * * *` e comando minimo
   `node scripts/check-research-worker.js`. Messaggio:
   `Hostless could not save the cron job. Check the schedule and the command, then try again.`
   Anche il tentativo con prefisso ambiente fallisce; le liste cron sono vuote.

La causa radice non è dimostrata: non si attribuisce il problema a permessi,
configurazione ereditata o servizio della piattaforma senza ulteriori prove.
Il backend e il frontend rimangono funzionanti.

## Alternativa standalone, non creata

Il wizard ufficiale standalone è stato esplorato nello stesso progetto senza
creare una risorsa. Source mostra `No repositories accessible`. Repository
mostra: `No accessible GitHub accounts were found. Authorizing Hostless does not install the GitHub App. Use Manage GitHub access to install it on the account that owns your repository and select the repository, then refresh access.`

Serve l'intervento del proprietario/admin GitHub `Ivandragon003` per installare
la GitHub App Hostless e autorizzare il solo repository `scommeseSportive`, poi
aggiornare l'accesso. La richiesta all'utente è pendente; nessun nuovo grant è
stato eseguito e nessuno standalone è stato creato. È un'alternativa alla
riparazione embedded, non un passaggio aggiuntivo obbligatorio e non una prova
della causa del guasto embedded. Evitare due worker operativi intenzionali.

Il collegamento legacy in `Git Connections` è ancora `Ivandragon003`,
`Connected`/`Healthy`, con due risorse e ultimo uso visualizzato 34 minuti
prima del controllo; non è stato disconnesso o alterato. `Manage GitHub Access`
ha aperto l'installer ufficiale Hostless App nella sessione GitHub
`Daniele04-creator`. I soli target disponibili sono `Daniele04-creator` e
`Betting1`: `Ivandragon003` non è selezionabile. La sessione corrente non può
quindi concedere il nuovo accesso sul repository del proprietario. Nessuna
installazione o autorizzazione è stata concessa. Questo è un limite verificato
dell'alternativa standalone e non spiega il guasto embedded.

## Richiesta tecnica da sottoporre al proprietario/assistenza

Verificare la coerenza tra record embedded e runtime/deployment del worker,
la risoluzione della sua configurazione ambiente e l'errore `App worker not found`.
Verificare inoltre perché il cron viene rifiutato con una pianificazione e un
comando minimi. Indicare eventuali permessi mancanti oppure la correzione della
piattaforma, senza eliminare o duplicare risorse e senza attivare piani a pagamento.

Il comando iniziale del worker conserva collaudi isolati e
`RESEARCH_T15_SCHEDULER_ENABLED=false`; lasciarlo disabilitato anche dopo la
riparazione finché non sono superati i controlli remoti. Non serve ricevere
password o token nella conversazione. Il [report operativo](production-status-2026-10-29.md)
distingue prove web, inferenza sintetica e ciclo T−15 ancora assente.
