# Hostless: deployment standalone accodati, 29 ottobre 2026

Scheda tecnica senza credenziali, indirizzi o identificatori di posta.
Il report è stato inviato su esplicita autorizzazione dell'utente nella chat
ufficiale Hostless Support, circa alle 14:29 CET del 29 ottobre; invio
verificato subito dopo alle 13:30:17 UTC. Hostless ha confermato la ricezione
dei dettagli e delle richieste di preservare servizi/database senza risorse a
pagamento; nessuna diagnosi o correzione comunicata.
Testo e screenshot di prova restano artifact privati del backup, esclusi da Git.
Il web funziona; T−15 non è operativo.

## Risorse

- Progetto `Ivandragon003's Project`, ID `6a838a83424e48848fce82b0`.
- Backend LIVE `6ae3213f30465a147074f461`, frontend LIVE
  `6ae322cd7b2d5d826aa0c130`, entrambi revisione `122fd360`.
- Embedded preservato e disabilitato: `footpredictor-t15`, ID
  `6ae3240430465a1470752801`, 0,1 vCPU/256 MiB, una replica.
- Standalone: `footpredictor-t15-standalone`, ID `6ae33d3659ba816e50f640fd`,
  creato alle 13:33 CET, tier `FREE`, una replica, CPU 0,01–0,1 vCPU,
  RAM 128–256 MiB, `scaledDown=false`, `overdue=false`, `autorelease=false`.
  Ventidue variabili necessarie configurate senza esporne i valori sensibili.

## Accesso GitHub risolto

Il proprietario ha completato l'autorizzazione della GitHub App. Il wizard
conferma `Connected as Ivandragon003`, un repository accessibile; repository
`scommeseSportive` e branch `main` sono stati verificati. Il collegamento
legacy è stato preservato. Il precedente limite di accesso non blocca più la
creazione standalone e non prova la causa del guasto embedded.

## Blocchi attuali

- Il wizard aveva selezionato `ed9e58ad`: primo deployment standalone
  `6ae33d3659ba816e50f6410b`. Dopo il push della correzione nativa è stato
  richiesto esplicitamente alle 13:37 CET il deployment
  `6ae33df530465a14707721ec`, revisione
  `cc842005dfd994bc21f787604b107436f5544bc1`.
- Lista verificata alle 15:14 CET: entrambi i deployment, `ed9e58ad` e
  `cc842005`, sono falliti con `Deployment waited too long in the queue`.
  La risorsa resta `Sleeping`; nessun processo, heartbeat o avvio build è
  dimostrato dalle icone o dalle etichette del wizard. Nessun nuovo tentativo
  worker creato. Il timeout non dimostra la causa della coda.
- Il dialogo Restart richiede un ultimo deployment riuscito, che non esiste:
  è stato annullato con `No`, senza effettuare un restart generico.
- Il comando iniziale conserva C smoke in sola lettura, E2E sintetico con
  ambiente isolato e poi attesa inattiva con scheduler `false`. Non rilancia
  automaticamente i test in ciclo e non abilita registrazioni.
- L'embedded precedente resta incoerente: record leggibile `200`, deployment
  `missing`/`ready=false`, gestione ambiente `404`/`App worker not found`.
  Redeploy e restart non avevano prodotto un processo. È mantenuto disabilitato.
- Il precedente cron embedded falliva con `400`, anche con comando minimo.
  È stato poi creato il cron standalone `footpredictor-watchdog`, ID
  `6ae3434030465a1470779a0f`, alle 13:59 CET
  (`2026-10-29T12:59:44.237Z`): tier `FREE`, sorgente `cc842005`, Custom
  0,1 vCPU/128 MiB, ogni cinque minuti UTC, auto-deploy disattivato, otto
  variabili senza chiave quote, worker atteso disabilitato.
- Il cron mostra due deployment riusciti, entrambi `cc842005`: LIVE delle
  15:11 `6ae3540c7b2d5d826aa4a15c` e originale delle 13:59
  `6ae3434030465a1470779a1f`. Anche l'avviso piattaforma conferma il deployment.
  Runs resta vuoto e gli stati UI oscillano, ma la ricerca `"ok"` nei Logs
  attesta 14 check reali riusciti ogni cinque minuti, dalle 14:10:21 alle
  15:15:13 CET (`13:10:21Z`–`14:15:13Z`). Il comando SELECT-only è operativo
  con `expectedEnabled=false`, mentre il worker è intenzionalmente spento.
  La lista Runs non rappresenta le esecuzioni effettive; non prova uno stop.
  Ritardi di output di 7–21 s rispetto all'intervallo cron non sono runtime
  del comando o misure T−15. Nessun allarme worker atteso in questa modalità;
  nessun canale esterno gratuito nuovo e nessuna consegna notifiche collaudata.
  Lo script è passato anche separatamente in Docker, senza scritture/provider.
- Alle 14:04 CET l'endpoint operativo dello stato fatturazione visibile nella
  UI restituisce `200`, `state=current`, `restoring=false`. Nessun saldo o
  documento di fatturazione letto: non prova costi retroattivi o causa della coda.

## Riscontri separati

La CI e la calibrazione `60a6baac` sono riuscite. Gate cache locale dalla
relativa immagine di produzione al Turso reale: 40 profili per passaggio,
80 hit validi, 100 SELECT e zero fit/scritture/provider. Non certifica l'avvio
del worker o il fix quote remoto. La cache usa l'intero `dist`; il deployment
backend manuale della stessa revisione, ID `6ae355cd7b2d5d826aa4c4c4`, è in coda
dalle 15:18 CET. Al checkpoint 15:21 web/frontend ancora LIVE `122fd360`;
nessun nuovo deploy frontend. Non è dimostrata la causa dei warning CPU.

La piattaforma aveva segnalato il 26 ottobre vincoli di capacità e possibili
ritardi/degrado. È un contesto compatibile con la coda, non una diagnosi di
queste risorse. Alert osservati: CPU alle 11:45 CET, rientro alle 12:28,
nuovo CPU alle 13:44; l'ultimo avviso CPU è poi `Recovered`/`Resolved`.
Fallimento embedded alle 11:46. Nessuna regola alterata. Un ulteriore avviso
appErrors riporta un errore senza stack e non consente di attribuirne la causa.
L'avviso appErrors delle 13:42 è distinto: due log erronei hanno classificato
come guasto una risposta cache-only prevista, pur con HTTP `200` in circa
345 ms. La [correzione](odds-cache-policy-2026-10-29.md) è ora pubblicata in
`60a6baac`, ancora non sul web LIVE; CI `40889233354` riuscita (777 test,
776 passati, un opzionale saltato, zero fallimenti), calibrazione `40889233171`
riuscita. Include anche le statistiche API degli skip; 66/66
test mirati e revisione finale senza blocchi. Il gate QA Linux Node 20 è ora
riuscito: 777 test, 776 superati, un opzionale saltato e zero fallimenti.
Il crash nativo Windows resta irrisolto e non è un controllo superato.
Il percorso bulk con HTTP `503` e il suo log HTTP di errore restano
intenzionalmente invariati: la correzione mira al falso errore provider del match.

Un audit quote separato da Linux locale verso provider/Turso ha misurato cinque
richieste e 15 crediti (residuo 220 → 205), 89 eventi futuri e record reali di
mercato senza cambiare otto tabelle protette. Non è una prova del worker Hostless
o di puntualità T−15. Scheduler T−15 e nuove registrazioni shadow restano
disabilitati; nightly di manutenzione e cron watchdog sono attivi.

## Ripresa sicura

Il timeout del deployment standalone è stato comunicato nello stesso caso di
assistenza autorizzato, dopo la conferma di ricezione iniziale. Anche la
discrepanza Runs vuoto/14 check riusciti è stata comunicata; nessuna nuova
diagnosi ricevuta. Verificare perché l'attesa in coda scade senza build osservabile
e segnalare separatamente l'incompletezza della lista Runs del cron, che ha
14 check riusciti nei Logs. Il cron SELECT-only è operativo con worker spento. Controllare
coda, capacità e stato runtime tramite gli strumenti ufficiali, senza assumere
la causa o alterare web/database funzionanti. Non ricreare altri worker per
forzare la coda e non attivare due processi decisionali intenzionali.
Contesto di accesso: proprietario GitHub ha autorizzato il repository; l'account
Hostless opera con ruolo `Editor`. Verificare eventuali ulteriori permessi
necessari come ipotesi da provare, senza attribuire loro il guasto.

Nessuna carta o cambio di piano: la richiesta embedded 512 MiB e il preset
cron Small da 0,25 vCPU hanno richiesto una carta e sono stati annullati.
Il Custom cron da 0,1 vCPU è stato accettato nella capacità gratuita indicata.
La fatturazione effettiva resta non verificata.

Dopo uno stato realmente pronto verificare log, collaudi e monitor prima di
abilitare T−15. Il [report operativo](production-status-2026-10-29.md) conserva
backup, migrazioni, saldo legacy e confini delle prove remote già riuscite.
