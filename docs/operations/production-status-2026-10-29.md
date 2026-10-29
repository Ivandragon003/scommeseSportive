# FootPredictor: stato della produzione, 29 ottobre 2026

**Deploy web completato. Sistema automatico T−15 non completato: il worker
Hostless è creato ma non operativo e il cron watchdog non viene salvato.**
Scheduler e Shadow Betting restano disabilitati. Nessun ciclo prospettico
reale completo è stato dichiarato. I report storici e i benchmark restano immutati.

## A. Hostless

- Progetto: `Ivandragon003's Project`, ID `6a838a83424e48848fce82b0`, verificato
  nel browser integrato. Ruolo `Editor`, impostazioni e deploy accessibili;
  lettura della fatturazione non disponibile con i permessi correnti.
- Backend `scommese-sportive-backend`: repository
  `Ivandragon003/scommeseSportive`, branch `main`, Docker, directory e contesto
  `/backend`, `Dockerfile`; start/post-build personalizzati vuoti. Una replica
  fissa, 0,1 vCPU/256 MiB, massimo una replica.
- Frontend Site `scommese-sportive-frontend`: stesso repository/branch,
  directory e contesto `/frontend`, installazione `npm ci`, build
  `npm run build`, output `./build`.
- Revisione applicativa distribuita: `122fd360994f84ca0d405cf25a9734cf48e94431`.
  Backend LIVE: `6ae3213f30465a147074f461`; frontend LIVE:
  `6ae322cd7b2d5d826aa0c130`. Auto-deploy disattivati per il rilascio controllato.
- Backend verificato alle 10:41 UTC: health `200`, POST anonimo alla route legacy
  `410`, API research anonima `401`. Login reale, sessione dopo reload, calendario
  e dashboard A/C verificati; la dashboard mostra due versioni e DB raggiungibile.
- La richiesta worker 512 MiB ha mostrato il requisito di aggiungere una carta
  ed è stata annullata. Creato soltanto il worker embedded Small
  `footpredictor-t15`, ID `6ae3240430465a1470752801`, 0,1 vCPU/256 MiB, una replica.
- **Worker non operativo:** UI `DEPLOYING`/`Not deployed`; record presente nelle
  letture API, stato deployment `missing`, `ready=false`. La gestione ambiente
  restituisce `404` con `App worker not found`; la pagina di modifica mostra
  errore di caricamento. Redeploy esplicito e restart accodato non hanno prodotto
  un processo verificabile. La causa radice non è stata determinata.
- Il comando iniziale conserva collaudi C/E2E isolati e worker con
  `RESEARCH_T15_SCHEDULER_ENABLED=false`: un eventuale avvio successivo non
  abilita decisioni o registrazioni automatiche.
- I tentativi cron watchdog, anche con comando minimo
  `node scripts/check-research-worker.js`, timezone UTC e `*/5 * * * *`,
  restituiscono `400` con rifiuto di salvataggio. Le liste cron restano vuote.
- Esplorata l'alternativa ufficiale standalone nello stesso progetto, **senza
  crearla**. Source mostra `No repositories accessible`; Repository segnala
  assenza di account GitHub accessibili e precisa che autorizzare Hostless non
  installa la GitHub App. Occorre che proprietario/admin `Ivandragon003`
  autorizzi la GitHub App Hostless per il solo `scommeseSportive` tramite
  `Manage GitHub access`, poi aggiorni l'accesso. Risposta dell'utente pendente,
  nessun nuovo grant eseguito. Riparazione embedded e standalone sono alternative;
  il riscontro sullo standalone non dimostra la causa del guasto embedded.
- `Git Connections` mostra il collegamento legacy GitHub `Ivandragon003`
  `Connected`/`Healthy`, usato da due risorse, con ultimo uso visualizzato
  34 minuti prima del controllo. Non è stato disconnesso o alterato.
  `Manage GitHub Access` apre l'installer ufficiale Hostless App nella sessione
  GitHub `Daniele04-creator`, che offre soltanto `Daniele04-creator` e `Betting1`,
  non `Ivandragon003`. Questa sessione non può concedere il nuovo accesso sul
  repository del proprietario. Nessuna installazione o autorizzazione concessa;
  l'alternativa standalone resta bloccata. Questo non dimostra la causa del
  problema embedded.
- [Scheda del blocco Hostless](hostless-blocker-2026-10-29.md), pronta per il
  proprietario/assistenza: nessun messaggio inviato automaticamente.

## B. GitHub e vecchia automazione

- Pubblicata prima la patch isolata
  `e046bc4fb625d64910ea63d250330c4f47117368`, poi il codice completo `122fd360`
  su `main`. Remote verificato: `Ivandragon003/scommeseSportive`.
- Workflow e script nightly remoti riletti e confrontati con la patch:
  nessuna chiamata `place-valid-bets`, `AUTO_BET` o `/bets/place`.
- `Nightly Sync`, ID `253787848`, riattivato (`active`). Run manuale
  [40857398332](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40857398332)
  riuscito; il log conferma manutenzione senza registrazione futura.
- Dopo il run: 258 giocate, ultima creazione `2026-10-25T07:09:40.275Z`,
  invariati rispetto al controllo precedente. Nessuna nuova giocata nightly.
  Import, manutenzione e liquidazione restano nel workflow.
- La nuova release backend risponde `410` sul POST alla route legacy anche
  anonimo: il ritiro è verificato sul remoto, oltre alla rimozione del chiamante.
- CI della revisione `122fd360`, run
  [40858594561](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40858594561):
  Backend e Frontend completati con successo.
- `Prepare prediction calibration`, sospeso per evitare bootstrap concorrente
  durante il rilascio, è stato riattivato (`active`). Training settimanale e
  watchdog sono pubblicati; nessun training nuovo è stato forzato per il deploy.
- Watchdog GitHub ancora manuale; manca `TURSO_WATCHDOG_READONLY_TOKEN`.
  Il processo web e la nightly non avviano il worker T−15.

## C. Turso, backup e integrità

- Database esistente confermato:
  `libsql://scomessesportive-ivandragon003.aws-eu-west-1.turso.io`.
- Credenziali applicative esistenti riutilizzate; SQL verificato con token `rw`,
  senza esposizione o rigenerazione. Accesso SQL e amministrazione della
  piattaforma sono distinti; non è servito un nuovo accesso amministrativo Turso.
- Prima delle migrazioni: 8.834 partite, 10.915 snapshot quote, 183.913 previsioni,
  258 giocate, un budget, una sessione budget, due utenti e quattro sessioni
  amministrative. Sono conteggi osservati, non una metrica di qualità predittiva.
- Backup coerente `/dump`: 445.882.733 byte, SHA-256
  `00403b5a72a69f07c57928e3e5d75f70dbf3fd29878ca18bbc58de2f640f9462`.
  Riferimento privato locale, escluso da Git:
  `backend/artifacts/backups/production-20261029-1029/manifest.json`.
  ACL limitate a utente corrente, SYSTEM e amministratori.
- Ripristino isolato completo: 29 tabelle, `integrity_check=ok`, zero violazioni
  delle chiavi esterne, manifest `complete=true`.
- Migrazioni `015–019`, compresa `018`, applicate due volte su una copia isolata:
  conteggi e hash dei contenuti delle 29 tabelle esistenti invariati, integrità
  `ok`, zero violazioni FK. L'archivio di ripristino originale è rimasto intatto.
- Migrazioni remote `015–019` poi applicate; registro con 20 versioni, inclusi
  i due prefissi storici `007`. `integrity_check` remoto post-deploy: `ok`.
- Confronto post-deploy con il backup: righe e valori di `bets` (258), `budgets`
  (1) e `budget_sessions` (1) identici (`byteEquivalentValues=true`). Nessuna
  cancellazione, nuovo database o ripristino sopra la produzione.
- Il manifest dichiara `quotaReviewedByOperator=false` e
  `quotaCheckWaivedByUser=true`: la verifica quote account è stata omessa su
  istruzione diretta dell'utente, senza dichiararla eseguita.
- Backup periodico, retention esterna e disponibilità del PITR restano da
  configurare/verificare. Il backup manuale locale non è un servizio continuativo.

## D. Modelli e mercati

- Registry reale: A `A-80cb25df5552621e`, C `C-906371b0b3a1e2c8`.
  Registrazione via CLI autorizzata con artefatti esistenti, senza retraining.
  A resta riferimento; nessun Champion C, nessuna promozione.
- C usa `joint-goal-coherent-v2`, è compatibile con la baseline A registrata e
  conserva `productionValidated=false`. I 26 mercati restano `EXPERIMENTAL`.
- **Inferenza CatBoost verificata su Hostless:** terminale dell'app backend,
  Node 20.20.2/Linux, artefatto C letto dal Turso reale, 1.000 chiamate
  `predictHybrid`, probabilità valide e somma 1; p95 circa 0,5125 ms,
  RSS massimo 105,75 MiB. Input sintetico, zero chiamate provider e zero scritture DB.
- Questa prova dimostra caricamento/inferenza nel runtime Hostless, non un
  ciclo pre-match reale A/C, puntualità T−15 o qualità delle previsioni.
  Python resta training/parità; l'inferenza di produzione è JSON CatBoost in Node.
- Il codice ammette registrazioni soltanto per mercati `SHADOW`/`ACTIVE` con
  evidenze indipendenti coerenti. `EXPERIMENTAL` resta escluso anche dai portafogli
  shadow. Il collaudo tecnico non promuove modelli o mercati e non aggira i gate.
- Registry, validazione cronologica e rollback sono conservati. Nessun test
  storico finale è stato riutilizzato per ottimizzare modelli durante il deploy.

## E. Quote

- Provider reale: The Odds API; nessun provider, chiave o abbonamento aggiunto.
- Probe persistente `/v4/sports` del 29 ottobre, 11:03:11 UTC, eseguito attraverso
  `db.oddsRequests`, operazione `deployment_quota_probe`: 280 crediti usati,
  220 residui, costo ultima richiesta 0. Budget configurato 500, riserva 50,
  scope `primary`, rete informativa ed extra disabilitate.
- Il manager mantiene cache condivisa, deduplicazione e prenotazione atomica;
  dashboard prevalentemente su cache. Nessuna chiamata quote a ogni polling.
- Non sono state recuperate nuove quote reali per bookmaker o mercati. Copertura
  attuale Top 5, Eurobet, freschezza T−15 e costo di una coorte decisionale restano
  da verificare. I contatori non provano il piano contrattuale gratuito.
  Il reset del periodo locale non certifica quello contrattuale del provider.
- Dopo refresh, la scheda API quote della produzione conferma 220 crediti residui,
  280 usati e una richiesta tracciata a costo zero; non mostra una nuova coorte
  di quote bookmaker acquisita per T−15.
- Nessuna quota inventata o attribuita a un bookmaker diverso. Nessuna rotazione
  di account/chiavi e nessuna riduzione automatica dei controlli di freschezza.

## F. Automazioni, monitoraggio e notifiche

- Scheduler T−15 non abilitato; nessun heartbeat worker, job decisionale o
  puntualità remota verificati. Il worker Hostless non ha eseguito l'E2E preparato.
  Dopo refresh, la scheda Sistema conferma `Fermo`, senza heartbeat né job.
- Contratto nel codice: polling 15 s, target T−15, tolleranza 60 s, quote massimo
  300 s, nessun recupero retroattivo o dopo kickoff, lease e vincoli persistenti.
- Prima della creazione worker, E2E Docker isolato senza rete, 0,1 vCPU/256 MiB:
  135 partite storiche fixture, tre match simultanei, sei puntate A/C simulate,
  due worker, restart/subentro e liquidazioni senza duplicati. Picco 168,76 MiB,
  polling osservato 14,316 s, coorte 3,542 s, restart 2,096 s, settlement 0,214 s.
  Sono misure locali sintetiche, non dati dell'Hostless worker o eventi reali.
- Watchdog indipendente SELECT-only disponibile nel repository, ma cron Hostless
  bloccato e workflow GitHub soltanto manuale, senza token dedicato di sola lettura.
  Nessun nuovo monitor periodico o canale di notifica esterno operativo.
- Alert Hostless preesistenti osservati e preservati: 21 regole, una destinazione;
  warning CPU throttling del 29 ottobre alle 11:45 e High Response Time del
  23 ottobre. Non sono stati riconfigurati e non sostituiscono il watchdog T−15.
- Riepilogo in-app dalla prima riconciliazione stabile dalle 09:00 Europe/Rome,
  deduplicato; incidenti tecnici immediati, nessuna notifica per singola puntata.
  Nessun invio esterno nuovo configurato o dichiarato.

## G. Portafogli e contabilità

| Portafoglio | Disponibile | Impegnato | Patrimonio | Puntate |
| --- | ---: | ---: | ---: | ---: |
| `shadow_A` | 1.000 EUR | 0 EUR | 1.000 EUR | 0 |
| `shadow_C` | 1.000 EUR | 0 EUR | 1.000 EUR | 0 |

I due portafogli sono stati realmente inizializzati sul Turso condiviso, con
ledger di apertura separati da 100.000 centesimi. Nessun `main`, capitale
combinato o fusione con il budget legacy. Stake previsto 1%, esposizione 5%,
massimo una puntata per partita/modello. Non sono state registrate puntate
shadow: nessuna liquidazione shadow reale o relativa variazione del saldo è
quindi ancora verificabile. La contabilità legacy è conservata come sopra.
Il refresh della dashboard di produzione conferma per ciascun portafoglio
1.000,00 EUR, zero impegnato e zero puntate, coerenti con le letture SQL.

## H. Verifiche e limiti

- CI reale `122fd360`, run `40858594561`: 765 test backend, 764 superati,
  zero fallimenti e un test opzionale saltato,
  `real CatBoost training compares three candidates and exported JSON matches Python inference`.
  Il test saltato non è presentato come eseguito.
- Frontend CI: lint, typecheck e build superati; test frontend locali 175/175.
  Python locale: 13/13 test. Monitoring mirato: 12/12 test.
- Scansione storia candidata:
  unica segnalazione verificata come assertion sintetica in
  `hostless-integration.js:263`, non una credenziale.
- Compose locale isolato: backend/frontend, health diretto, proxy API e login
  sintetico riusciti. E2E locale nei limiti worker come sopra, senza provider.
- Remoto verificato: deploy web, autenticazione/sessione, navigazione/calendario,
  dashboard A/C, DB, integrità e migrazioni, registry, inferenza C sintetica,
  quota probe persistente, nightly e ritiro legacy.
- Android: compatibilità nel codice conservata; nessun dispositivo reale collaudato.
- **Nessun ciclo prospettico reale completo** previsione → T−15 → eventuale
  puntata → risultato → liquidazione. Nessuna prova di uptime o restart del
  worker Hostless; inferenza sintetica e health web non sostituiscono questi gate.

## I. Esito e intervento indispensabile

| Domanda finale | Risposta verificata |
| --- | --- |
| Nuova versione pubblicata? | Sì, frontend e backend `122fd360` online su Hostless. |
| Vecchia registrazione nightly disabilitata? | Sì: chiamante rimosso, nightly riuscita senza nuove giocate, endpoint remoto `410`. |
| Worker T−15 operativo? | No: record creato, deployment mancante e gestione ambiente `404`. |
| A e C funzionano in remoto? | Registry e baseline compatibili; inferenza C su Hostless riuscita con input sintetico. Ciclo reale A/C non completato. |
| Shadow Betting attivo? | No: scheduler spento, mercati `EXPERIMENTAL`, zero puntate. |
| Turso esistente collegato? | Sì, migrazioni e letture/scritture autorizzate verificate, contabilità legacy preservata. |
| Opera con PC e smartphone spenti? | Il web sì; il processo automatico completo non è operativo. |
| Cosa resta? | Riparazione worker/cron Hostless, watchdog/notifiche, quote decisionali, gate mercati e primo ciclo reale con liquidazione. |
| Costi aggiuntivi? | Nessun piano/carta/servizio a pagamento attivato. Fatturazione effettiva account non verificata. |
| Serve il proprietario? | Sì: riparazione embedded/cron tramite proprietario o assistenza Hostless; in alternativa, proprietario/admin GitHub `Ivandragon003` per autorizzare Hostless sul solo repository e sbloccare lo standalone. Non servono entrambe le soluzioni. Nessun nuovo accesso amministrativo Turso richiesto per le operazioni completate. |

Preservare web e database funzionanti, worker con registrazioni disabilitate
e nightly di manutenzione. Lo standalone è un'alternativa autorizzata ma bloccata
prima della creazione: non lasciare mai due worker operativi intenzionali durante
l'eventuale sostituzione. Dopo lo sblocco, ripetere collaudi worker, monitor indipendente,
quote reali e ciclo prospettico. Backup periodico e retention restano pendenti.

## Rollback

Disabilitare nuove decisioni e fermare il worker se necessario, mantenendo
storico e liquidazioni. Conservare migrazioni additive, ledger e portafogli.
Un rollback del codice deve preservare la patch nightly e il ritiro legacy:
la vecchia immagine senza il blocco `410` non è un ripristino sicuro automatico.
Non sovrascrivere la produzione con un backup più vecchio senza piano di
riconciliazione e autorizzazione. L'auto-deploy rimane disattivato per mantenere
controllo sulle prossime pubblicazioni.
