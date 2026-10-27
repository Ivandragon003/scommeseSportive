# FootPredictor: preparazione Hostless del 27 ottobre 2026

## Esito

**Hostless è tecnicamente compatibile; non è necessaria una migrazione Oracle.**
Preparati worker separato, coordinamento Turso, monitor esterno, container Linux
e test ripetibili. Tutte le operazioni sono rimaste locali. Pubblicazione e
attivazione restano subordinate a piano account, validazione dei mercati e
collaudo remoto. Non è dimostrato il funzionamento remoto di questa versione.

## Risposte alle dieci domande

1. **Hostless senza Oracle? Sì, tecnicamente.** La piattaforma supporta processi
   persistenti e Docker. Il frontend esistente, Express, Turso e Actions restano
   l'architettura richiesta. Non sono stati introdotti database o servizi cloud.
2. **Worker o backend? Worker dedicato**, preferibilmente embedded nella app
   esistente: processo separato, stessa immagine/ambiente. Standalone se più
   adatto all'account. Il web non avvia più ResearchRuntime: niente attivazione
   implicita da vecchie env. Se il gratuito non consente il worker non si
   introduce automaticamente un'altra piattaforma o la modalità integrata.
3. **CPU/RAM?** I campioni e i limiti sono riportati sotto e negli allegati
   Linux. Il campione completo di calcolo è passato con limite 256 MiB. Una dotazione
   iniziale prudente da collaudare è web 0,25 vCPU/256 MiB e worker
   0,25 vCPU/512 MiB, una replica ciascuno. Non è una garanzia per traffico web
   arbitrario o crescita dello storico; non confondere RSS misurato e RAM allocata.
4. **C su Linux? Sì.** Eseguito un candidato addestrato esistente, non
   diagnostico, tramite inferenza JSON Node nel target runtime. Parità con
   CatBoost nativo Linux su 70 valori: errore massimo 5,55e-17. Python serve al
   training/parity separato, non al web/worker. Il candidato conserva
   `productionValidated=false`: compatibilità non significa promozione.
5. **Doppie esecuzioni e riavvii? Protetti nei test locali.** Lease globale
   persistente di 30 s con rinnovo durante il lavoro; token dei job, vincoli
   univoci e transazione unica di snapshot/decisioni/puntate/ledger. Il vecchio
   proprietario non può riutilizzare token scaduti. Crash e subentro sono stati
   simulati con veri processi. Non è dimostrata alta disponibilità Hostless.
6. **Nightly separata? Sì nel codice locale.** Script/workflow non registrano
   puntate future; route legacy 410 anche con `AUTO_BET_ENABLED=true`. Import e
   liquidazioni rimangono. Lo stato del vecchio workflow remoto non è stato
   ricontrollato o modificato in questo intervento: va dismesso prima dell'avvio.
7. **File modificati?** Elenco completo dell'intervento nella sezione dedicata.
   Il workspace conteneva già molte modifiche A/C: sono state preservate.
8. **Test?** Backend 747/747, frontend 175/175, typecheck/lint/build e prove
   Linux, multi-processo, API, riavvio e liquidazione descritte sotto.
9. **Configurazioni Hostless?** Docker backend, comando web e worker distinti,
   stesso Turso/registry/cache, health HTTP e watchdog DB separati, flag false
   iniziale, scope quote comune, budget 500/riserva 50, env private esistenti.
   Tabella e procedura: [runbook manuale](hostless-deployment.md).
10. **Dati account mancanti?** Piano legacy/PAYG e ciclo effettivo, risorse già
    occupate nell'intero account, worker disponibili e loro dimensioni minime,
    modalità embedded ammessa, root/context/build attuali, repliche, automatic
    deploy, limiti/spese, minuti Actions, latenza/quote Turso, contenuto e stato
    effettivo del registry C e mercati, configurazione e run remoti della nightly.

## Audit dei componenti

| Componente | Stato locale verificato |
| --- | --- |
| Backend Docker | build TypeScript separata, Node 20.20.2 Linux con base fissata a digest, `npm ci --omit=dev`, utente node |
| Start web | `node dist/index.js`, `PORT` dell'host, health `/api/health` |
| Frontend | React build; Site Hostless con `REACT_APP_API_URL` a build time; nginx locale usa DNS Compose |
| Hostless YAML | assente; intenzionalmente nessun file attivo che sovrascriva app/risorse non ancora inventariate |
| Start worker | `node scripts/research-worker.js` / `npm run research:worker`, flag disabilitato per default |
| Coordinamento | migrazione additiva 019; tabella singleton `research_worker_state`, job e ledger nel Turso già configurato |
| Nightly | Actions e script maintenance-only; niente creazione; `/bets/sync` conserva liquidazioni legacy/A/C |
| Training | workflow separato Python 3.12; scritture registry già subordinate al flag previsto; non richiesto al runtime web |
| Quote | Smart Odds invariato nelle policy; corretto soltanto retry inizializzazione in avvio concorrente |
| Monitor | stato DB nella UI esistente e CLI esterna SELECT-only; workflow watchdog solo manuale |

Nessun secret è stato copiato in sorgenti, Docker, documentazione o report.
Il `.dockerignore` esclude env, database, artefatti privati e dipendenze locali.
I requisiti Python del target `ml-verification` sono fissati separatamente;
CatBoost nativo 1.2.8 e NumPy 2.2.6 sono strumenti di verifica, senza Python
nell'immagine produzione. Non sono cambiati pesi, formule, modelli o benchmark.

## Garanzie dello scheduler e confini

- Polling 15 s, target kickoff meno 15 minuti, ritardo ammesso massimo 60 s.
  Quote con età >300 s, timestamp assenti/futuri o provenienza non ammessa
  non autorizzano puntate. Il commit ricontrolla la finestra temporale.
- Modifiche kickoff prima della preparazione riallineano il job senza fetch
  superfluo. Il commit legge anche `matches` nella transazione: se una nightly
  ha cambiato data o risultato durante la preparazione, il batch viene rifiutato.
- Le lease dei job si rinnovano solo se ancora valide e mai oltre la finestra.
  Scadenza o crash comportano subentro/astensione, mai registrazione retroattiva.
- La modalità disabilitata resta viva senza aprire connessioni DB o provider.
  SIGTERM drena il tick, rilascia la lease e chiude il DB; un limite di arresto
  impedisce di attendere indefinitamente il drain.
- Heartbeat, ultimo tick, ultimo errore sicuro e decisioni sono persistenti;
  leggere health o overview non produce un heartbeat artificiale.
- Il watchdog indipendente rileva heartbeat >45 s, lease scaduta, tick fermo
  >90 s, errori persistenti, stato quote/crediti e liquidazioni arretrate.
  Può leggere Turso anche con backend irraggiungibile. È predisposto ma non
  pianificato: il rilevamento esterno resta manuale finché il proprietario non
  attiva un controllo periodico. Actions può ritardare; nessun SLA subminuto.
- Un tick sospeso può mantenere heartbeat fresco finché l'event loop risponde;
  il controllo sull'ultimo tick evita un falso stato sano. Non è dimostrato
  l'autoripristino di ogni chiamata DB bloccata. Un blocco sincrono completo
  richiede rilevamento esterno/restart dell'host; non si finge un timeout Python.

Smart Odds continua a riservare il budget prima delle richieste, condividere
cache e snapshot A/C e conservare costi sconosciuti dopo crash. Tutti i processi
devono usare lo stesso scope dell'account. Polling vuoto e letture informative
non fanno richieste a consumo. I 500 crediti non assicurano copertura completa
delle cinque leghe: l'esaurimento comporta una decisione saltata, non quote
inventate o acquisto di un piano.

## Verifiche e misure

- Backend: `npm test` (include build), **747 passati, zero fail/skip**;
  `npm run typecheck` e `npm run lint` superati.
- Frontend: `npm run test:ci -- --runInBand`, **175 test/27 suite passati**;
  typecheck, lint e build superati. La fixture della pagina è stata adeguata
  al nuovo stato UNKNOWN quando il worker non è stato osservato.
- Linux C: caricamento artefatto reale, 1.000 inferenze, parità JSON/nativa,
  casi errore; test CatBoost Linux **4/4, zero skip**, incluso training sintetico.
  [Misure e comandi ML](hostless-linux-verification.md).
- E2E Linux senza rete: backend di produzione con autenticazione, due worker,
  timer 15 s, tre partite contemporanee, un solo trasporto quote simulato,
  sei decisioni/giocate A/C, SIGKILL e subentro, zero duplicati, sei liquidazioni
  idempotenti. Saldi finali fixture 102.700 centesimi per portafoglio: sono
  risultati del test contabile, **non rendimento reale**.
  [Riproduzione e limiti](hostless-local-acceptance.md).
- Test multi-processo: cache quote condivisa, recupero dopo SIGKILL con costo
  UNKNOWN conservativo, election worker, guardie immutabili e capitale iniziale
  una sola volta. Corrette le race di inizializzazione sia Smart Odds sia ResearchStore.
- Compose: build/avvio backend e frontend, health HTTP diretto e proxy nginx,
  login con password di test, DB file isolato. Porte **3101/3100** per preservare
  i servizi già presenti su 3001/3000; nessuna `.env` reale caricata.
  Comando: `./scripts/test-hostless-compose.ps1`.
- Comando worker di produzione avviato senza env/DB/provider, rete disabilitata:
  rimane attivo e registra `worker_disabled`; arresto SIGTERM riuscito. I container
  temporanei creati per i test sono stati fermati, preservando quelli preesistenti.
- YAML, riferimenti locali e `git diff --check`: verificati prima della consegna.
  Il build frontend segnala soltanto Browserslist datato;
  non è stato aggiornato il lock senza necessità.

Campioni Linux con quota CPU limitata, senza rete esterna:

| Carico | Limite del test | Risultato |
| --- | --- | --- |
| Backend produzione con health/auth/liquidazione sintetica | container E2E complessivo 0,25 vCPU/512 MiB | picco RSS backend 90,2 MiB |
| Worker, tre incontri insieme A/C e registrazione | stesso container con orchestratore e due worker | picco RSS worker 97,9 MiB; coorte 1,37 s; CPU worker 346 ms |
| Riavvio e subentro dopo scadenza lease simulata | stesso E2E | 1,30 s dopo avanzamento del clock oltre la lease; non tempo reale totale del crash |
| Liquidazione sei puntate sintetiche | stesso E2E | 105,9 ms, secondo tentativo zero nuove liquidazioni |
| Componente C, artefatto addestrato reale 4,7 MB | 0,25 vCPU/256 MiB | RSS circa 82–85 MiB; p95 inferenza circa 0,34–0,85 ms nelle ripetizioni |
| Storico locale 8.834 righe/5 leghe + C reale + fit A e C | 0,25 vCPU/256 MiB, processo misurato fresco | picco 145,4 MiB; lettura DB 1,91 s; primi tre fit A+C 5,70 s; venti 22,50 s; totale 25,29 s/CPU 6,01 s |
| Stesso campione completo, ripetizione | 0,25 vCPU/512 MiB | picco 141,4 MiB; lettura DB 2,11 s; primi tre fit A+C 2,80 s; venti 15,31 s; totale 18,40 s/CPU 4,23 s |

Le differenze tra campioni non sono attribuibili alla sola RAM: carico locale
e throttling variano. Le misure E2E non usano un C addestrato: sono il test
contabile con artefatto minimo esplicito. Il campione di dimensionamento separato
usa invece storico e candidato reali locali, senza quote o puntate; non include
calibrazione finale, rete Turso/provider, ledger, molti artefatti nel registry
o traffico HTTP contemporaneo. Da qui il margine consigliato di 512 MiB worker.
La CPU indica tempo cumulativo, non una percentuale stabile. Questi test non
giustificano ridurre i limiti T−15.

Le misure definitive E2E e sullo storico locale sono documentate negli allegati;
i JSON grezzi sono file locali ignorati sotto `backend/artifacts/`.
Non è stato usato il DB Turso remoto e non sono stati consumati crediti reali.
Immagine locale finale `footpredictor-hostless:local`:
`sha256:418fb7e6c890b0e4fc923154461d2bc80d77582493d9989caa438fced0d64b1c`.
Confrontati gli hash dei sei moduli compilati principali nell'immagine con la
build locale verificata: coincidono. Nessuna immagine pubblicata su registry remoto.

## Gratuito e condizioni dell'account

La documentazione Hostless corrente distingue la nuova politica PAYG condivisa
(0,5 vCPU, 1 GiB RAM e 512 MiB storage) dai cicli e piani precedenti. Il pool è
dell'account, non del singolo processo. Un web e un worker da 0,25 vCPU ciascuno
lo impegnerebbero interamente per la CPU, prima di considerare altre risorse.
I volumi durevoli hanno fatturazione separata e qui non servono.
[Billing ufficiale](https://docs.hostless.cloud/billing/costbreakdown).

Gli account legacy possono avere limiti di conteggio differenti, inclusi una
sola app in esecuzione e fino a due worker; non segue che un nuovo worker sia
gratuito o dimensionabile come desiderato nell'account esistente. Non aggiungere
una carta per sbloccare una funzione senza decisione del proprietario.
[Limiti ufficiali](https://docs.hostless.cloud/plans/free-tier).

Minuti Actions, rate/quote Turso, traffico reale, regionalità e latenze non sono
stati misurati. Nessuna risorsa a pagamento è stata creata o attivata. Il build
segnala advisory npm preesistenti: non è stata attestata la loro applicabilità
né attribuita al task una garanzia generale di sicurezza.

## File dell'intervento

Questa lista distingue il lavoro corrente dalle numerose modifiche preesistenti
del workspace. Nessun file estraneo è stato ripristinato o incluso in un commit.

Configurazione e avvio:

- `.env.example`, `README.md`, `docker-compose.yml`
- `backend/package.json`, `backend/Dockerfile`, `backend/.dockerignore`
- `frontend/Dockerfile`, `scripts/test-hostless-compose.ps1`

Backend e strumenti:

- `backend/migrations/019_research_worker.sql`
- `backend/src/index.ts`, `backend/src/db/DatabaseService.ts`
- `backend/src/research/ResearchWorkerCoordinator.ts`
- `backend/src/research/ResearchRuntime.ts`, `backend/src/research/ResearchStore.ts`
- `backend/src/research/ResearchOverview.ts`
- `backend/src/services/odds-provider/SmartOddsRequestStore.ts`
- `backend/scripts/research-worker.js`, `backend/scripts/check-research-worker.js`
- `backend/scripts/research-ml-smoke.js`, `backend/scripts/hostless-resource-sample.js`
- `backend/scripts/hostless-integration.js`, `backend/scripts/hostless-integration-fixtures.js`
- `backend/ml/README.md`, `backend/ml/requirements-linux-verification.txt`
- `backend/ml/verify_linux_parity.py`, `.github/workflows/research-watchdog.yml`

Test e stato UI:

- `backend/test/nightly-maintenance.test.js`, `backend/test/research-worker.test.js`
- `backend/test/research-store.test.js`, `backend/test/research-runtime.test.js`
- `backend/test/research-overview.test.js`, `backend/test/research-watchdog.test.js`
- `backend/test/smart-odds-request-store.test.js`, `backend/test/smart-odds-process.test.js`
- `backend/test/fixtures/smart-odds-process.cjs`
- `frontend/src/features/research/ResearchAutomationStatus.tsx`
- `frontend/src/features/research/ResearchAutomationStatus.test.tsx`
- `frontend/src/features/research/ResearchPage.test.tsx`
- `frontend/src/features/research/researchTypes.ts`

Documentazione:

- `docs/github-actions-nightly-sync.md`, `docs/research-platform.md`, `docs/SYSTEM-DESIGN.md`
- `docs/operations/t15-readiness-2026-10-27.md`
- `docs/operations/hostless-deployment.md`, questo report
- `docs/operations/hostless-linux-verification.md`
- `docs/operations/hostless-local-acceptance.md`, `docs/operations/research-watchdog.md`

Route legacy, workflow nightly e script di sync erano già maintenance-only nel
lavoro locale preesistente: auditati, non riscritti senza bisogno. Rimossi
import/avvio scheduler dal web; nessuna dipendenza del modello è diventata
inutile per questa separazione. Niente pulizia estranea delle parti legacy
ancora usate per storico, compatibilità o liquidazione.

## Consegna operativa

La [procedura manuale](hostless-deployment.md) comprende checklist del
proprietario, variabili, creazione worker spento, dismissione della vecchia
registrazione, collaudo graduale e rollback senza cancellare storico/ledger.
Il [monitor esterno](research-watchdog.md) precisa configurazione e limiti.
Nessun commit, push, deploy, migrazione remota, cambio chiave o attivazione è
stato eseguito. Il prossimo passo dipende dall'accesso all'account e da una
successiva autorizzazione, non da un altro provider cloud.
