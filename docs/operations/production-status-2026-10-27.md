# FootPredictor: stato del mandato di produzione, 27 ottobre 2026

**Consegna parziale, con blocchi di accesso. La nuova versione non è stata
pubblicata su Hostless e lo Shadow Betting remoto non è attivo.** Questo report
aggiorna lo stato operativo dei precedenti report locali della stessa data;
non cambia i loro risultati storici o i benchmark.

## A. Hostless

- Frontend `https://scommese-sportive-frontend.hostless.site`: HTTP 200.
- Backend `https://scommese-sportive-backend.hostless.app/api/health`: HTTP 200.
- `/api/auth/session` e `/api/research/overview`, senza sessione: HTTP 401.
  Questo verifica il rifiuto dell'accesso anonimo, non un login remoto riuscito.
- Il pannello ufficiale richiede login. Nessun token Hostless è disponibile
  nell'ambiente del processo. Il browser locale è stato interrotto dal controllo
  di sicurezza perché non poteva verificare affidabilmente l'URL: nessun
  tentativo di aggirarlo. L'utente è al telefono e non può completare il login
  nel browser del PC durante questo intervento.
- Identità interna di progetto/servizi, piano effettivo, risorse residue,
  branch/build/start/env, auto-deploy e rollback non sono stati inventariati.
  Nessuna configurazione Hostless o risorsa è stata modificata.
- La [documentazione ufficiale worker](https://docs.hostless.cloud/app/workers)
  conferma processi separati standalone/embedded. Il
  [listino](https://hostless.cloud/pricing) descrive una dotazione condivisa di
  0,5 vCPU/1 GB: non dimostra la disponibilità residua dell'account esistente.
  Risorse proposte web 0,25 vCPU/256 MiB e worker 0,25 vCPU/512 MiB da confermare.
- La ricerca nel catalogo delle integrazioni non ha restituito plugin Hostless
  o Turso collegabili in questa sessione. Hostless documenta comunque un
  [MCP ufficiale con OAuth](https://docs.hostless.cloud/mcp):
  `https://mcp.hostless.app/mcp`. Nessuna connessione o autorizzazione è stata
  creata automaticamente. Un login effettuato soltanto nel browser del telefono
  non autentica il browser del PC né il client API di questa sessione.

## B. GitHub e legacy

- Repository verificato: `Ivandragon003/scommeseSportive`, pubblico, default
  `main`, permesso autenticato `WRITE`. Remote `origin` coerente.
- Revisione remota osservata: `852284d89d2f59364b14a435d567ad8576db045c`.
- Il workflow remoto `Nightly Sync`, ID `253787848`, conteneva ancora
  `AUTO_BET_ENABLED=true`, `AUTO_BET_DRY_RUN=false` e la chiamata legacy.
- Eseguito `gh workflow disable 253787848`; rilettura API:
  `state=disabled_manually`. Nessun run attivo o in coda al controllo.
- **Anche import e liquidazioni della nightly sono temporaneamente sospesi.**
  Non si dichiara completata la manutenzione remota, né il ritiro permanente
  dell'endpoint della vecchia release, che non è stata sostituita.
- Commit locale indipendente `e046bc4f`: workflow e script senza registrazione
  di giocate future. Mantiene import e liquidazioni. La chiamata finale al nuovo
  marker research è opzionale per compatibilità con la vecchia release.
- Commit locale `71f4b3a3`: piattaforma A/C, Smart Odds, migrazioni, script e
  test già preparati nel workspace, più correzioni watchdog e procedura backup.
- Commit locale `fdce8f9b`: configurazione worker, packaging Hostless,
  workflow nuovi e dashboard A/C. La documentazione è in un commit separato.
- Commit locale `8e7b919e`: backup grandi con restore offline streaming.
- Nessun push: non è ancora noto se Hostless distribuisca automaticamente il
  branch. Un push completo può avviare anche Actions che inizializzano lo schema.
- Nel codice pronto al rilascio la route legacy risponde sempre 410, il web
  non avvia T−15 e non sono stati trovati altri chiamanti automatici legacy.
  `/bets/place` rimane un'azione manuale autenticata.
- Training settimanale e watchdog nuovi restano locali. Il watchdog è manuale
  e manca `TURSO_WATCHDOG_READONLY_TOKEN`; nessun monitor periodico dichiarato.

## C. Database e backup

- Verificato in sola lettura il DB di `.env.production` con il client libSQL,
  senza `DatabaseService`, migrazioni o inizializzazione di portafogli.
- `.env` e `.env.production` hanno URL Turso, token DB e chiave quote uguali,
  confrontati senza stampare segreti. I secret GitHub sono visibili soltanto
  per nome; non si afferma di averne confrontato il contenuto con Hostless.
- Preflight delle 15:53 UTC: 8.834 partite, 10.915 snapshot quote, 258 giocate,
  un budget, una sessione budget, due utenti e quattro sessioni amministrative.
  Sono conteggi osservati, non un nuovo backup o una prova di saldi corretti.
- Migrazioni remote applicate fino a `014` (15 nomi, due prefissi `007`).
  Nessuna tabella research nuova presente, nessuna migrazione remota applicata.
- Page count 127.341, page size 4.096: circa 522 MB. Il dump SQL può essere
  maggiore e richiede spazio anche per il ripristino locale.
- 015–019 sono additive; il test le ha applicate due volte su libSQL in memoria:
  integrity check `ok`, zero violazioni FK. Il bootstrap applica tutte quelle
  mancanti, compresa 018: questo è un gate prima del deploy, non dopo.
- **Backup produzione non eseguito**: il token DB non permette di verificare
  piano, letture/trasferimenti residui o costi dell'account Turso. Nessun
  archivio parziale è presentato come backup riuscito.
- Preparati script e [procedura di backup/ripristino](turso-backup.md), basati
  sul dump ufficiale coerente, host vincolato, limiti, hash, conteggi e restore
  locale nuovo. Nove test con fixture passati. Download e restore procedono
  a blocchi/istruzioni, senza una stringa Node dell'intero dump: evitato il
  limite di circa 512 MiB. Il restore locale usa Python 3 sqlite3, senza
  passare segreti al processo; questa dipendenza non riguarda l'inferenza.
  La prova di streaming usa circa 2 MiB/8.000 insert, non un backup remoto.
  Serve accesso al pannello Turso
  o alla CLI di gestione per il controllo delle quote prima dell'export completo.

## D. Modelli e mercati

- A conserva il ruolo di riferimento, C resta Challenger. Nessun peso,
  formula, modello o risultato del benchmark è stato modificato per il deploy.
- Inferenza C prevista in Node sui JSON CatBoost; Python serve al training e
  alla verifica di parità. Registro C remoto assente con lo schema research
  attuale: **inferenza A/C in produzione non collaudata**.
- Mercati ancora `EXPERIMENTAL`. Il codice richiede evidenza indipendente e
  hash di configurazione coerente prima di ammettere `SHADOW`/`ACTIVE`:
  nessuna promozione o deroga è stata applicata per ottenere giocate.
- Il flag di scrittura registry non risulta tra le variabili GitHub osservate.
  Il nuovo training locale non promuove candidati senza il gate previsto.

## E. Quote

- Provider reale: The Odds API, dominio `api.the-odds-api.com`.
- `/v4/sports` osservato alle 15:53:46 UTC: HTTP 200, 280 crediti usati,
  **220 residui**, costo ultima chiamata 0. Tutte e cinque le leghe risultano
  attive. Sono dati puntuali e possono cambiare dopo il controllo.
- Totale osservato 500, coerente con il budget iniziale; non costituisce
  verifica contrattuale del piano gratuito o della fatturazione dell'account.
- Non sono state effettuate richieste nuove a consumo per bookmaker/mercati:
  copertura attuale, Eurobet e freschezza T−15 restano da verificare con il
  manager persistente dopo le migrazioni e con quota account confermata.
- Configurazione locale 500/riserva 50, cache condivisa, prenotazione atomica,
  stesso snapshot A/C e nessuna richiesta a ogni polling. Nessuna rotazione di
  account o chiavi, nessun provider o abbonamento aggiunto.

## F. Automazioni e monitoraggio

- Nessun nuovo worker remoto creato o attivato; heartbeat, puntualità, retry,
  riavvio e uptime Hostless non sono stati misurati.
- Contratto locale: polling 15 s, target T−15, tolleranza 60 s, quote massimo
  300 s, nessuna registrazione retroattiva o dopo kickoff. Lease persistenti,
  fencing e vincoli univoci proteggono il database condiviso.
- Corretto il watchdog locale: rileva anche crediti esauriti, decisioni mancate,
  indisponibilità quote osservata per almeno 15 minuti ed errori ripetuti per
  famiglia/versione del modello. Restano attivi i controlli su liquidazioni
  anche quando il worker è intenzionalmente spento. Solo SELECT, nessun fetch.
- [Guida monitoraggio](research-watchdog.md): esterno manuale, non pianificato.
  Notifiche esterne e riepilogo esterno alle 09:00 non configurati; manca un
  canale autorizzato e verificato. Nessuna notifica per singola puntata aggiunta.

## G. Portafogli

- Nessun portafoglio research o puntata shadow creato in produzione.
- Inizializzazione locale prevista: A e C indipendenti, 100.000 centesimi
  ciascuno, stake 1%, esposizione 5%, massimo una puntata per partita/modello.
  Nessun capitale combinato e nessuna attivazione del portafoglio operativo.
- Nessuna scrittura intenzionale al DB remoto durante l'audit; saldi legacy
  non modificati da questa procedura. La correttezza contabile remota completa
  non è ancora stata collaudata.

## H. Verifiche ripetute in questo intervento

- Backend `npm test`: 747/747 passati, zero skip; include build TypeScript.
- Frontend `npm run test:ci -- --runInBand`: 175/175, 27 suite.
- Typecheck e lint backend/frontend, build frontend: superati. Avvisi
  Browserslist datato e deprecazione Node durante la build, senza errori.
- Dopo le nuove correzioni, backup/watchdog: 20/20 test passati; lint mirato
  superato. La verifica seriale Smart Odds/watchdog ha superato 31/31 test.
  Una prova parallela mirata aveva tutte le assertion verdi ma un errore finale
  del processo nativo senza stack: non è stata dichiarata riuscita; seriale verde.
- `scripts/test-hostless-compose.ps1`: build/avvio backend e frontend, health
  diretto e proxy, login sintetico. DB isolato e porte 3101/3100, niente env reali.
  Al termine sono stati fermati soltanto i due container di questa verifica,
  preservando dati locali e gli altri servizi preesistenti.
- E2E immagine Linux Node 20.20.2, rete disabilitata, 0,25 vCPU/512 MiB:
  tre partite sintetiche contemporanee, sei giocate A/C, una sola acquisizione
  quote simulata, due worker, SIGKILL/subentro, nessun duplicato e sei
  liquidazioni idempotenti. Polling osservato 14,62 s, coorte 2,26 s,
  riavvio 1,06 s; picco aggregato 172,2 MiB. Sono fixture, non eventi reali.
- Ripetuto smoke C con candidato locale reale `C-906371b0b3a1e2c8` nella
  stessa immagine Linux, rete disabilitata e limite 256 MiB: 70 confronti di
  parità, errore massimo 0, 1.000 inferenze, p95 0,44 ms e RSS massimo 82,4 MiB.
  `productionValidated=false`: nessuna promozione e nessuna prova Hostless.
- Gitleaks sui 527 file candidati alla pubblicazione: sei segnalazioni
  ispezionate, tutte stringhe sintetiche/assertion o chiavi di selezione sportiva.
  Nessuna credenziale rilevata. Env, DB e output privati sono esclusi da Git.
  La scansione staged backend ha confermato la sola assertion sintetica;
  la scansione staged packaging/UI non ha prodotto segnalazioni.
- Android: URL remoto e configurazione cookie presenti nel codice; nessun
  dispositivo reale o APK aggiornato collaudato in questo intervento.
- **Nessun ciclo prospettico reale T−15/risultato/liquidazione completato.**

## I. Ripresa e rollback

1. Rendere disponibile l'accesso Hostless già autorizzato mediante login nel
   browser controllabile o collegamento OAuth/MCP ufficiale. Non inviare token
   o password in chat. [Metodi ufficiali](https://docs.hostless.cloud/developers).
2. Inventariare servizi/piano/env/auto-deploy e conservare configurazione e
   revisione precedente, senza attivare risorse a pagamento.
3. Verificare quote Turso; eseguire dump, restore isolato e prova migrazioni
   sulla copia. Conservarne manifest privato e verificare storici/saldi.
4. Pubblicare prima la patch nightly compatibile, verificarla sul remoto e
   riattivare il solo workflow corretto. Eseguire manutenzione manuale e
   verificare zero nuove giocate future. Non riabilitare la vecchia revisione.
5. Pubblicare la versione completa con worker spento; collaudare web/login,
   DB, registry, inferenza, quote, Android, rollback e monitor indipendente.
6. Solo dopo i gate, attivare un worker e shadow per mercati ammissibili,
   osservando il primo ciclo reale senza forzare puntate.

Non ripristinare un vecchio database sulla produzione corrente. Se il worker
futuro deve fermarsi, disabilitare nuove decisioni conservando ledger e
liquidazioni. Il rollback di codice deve mantenere il ritiro legacy.

**Nessuna nuova risorsa cloud, piano, carta o servizio a pagamento attivato.**
La fatturazione effettiva degli account esistenti non è verificabile senza
accesso ai relativi pannelli. Non si dichiara il sistema autonomo operativo:
quel risultato richiede ancora deploy, attivazione e prove remote.
