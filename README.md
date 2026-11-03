# FootPredictor

Applicazione per analizzare partite di calcio, confrontare probabilità con quote
bookmaker reali e gestire puntate **virtuali**. Frontend React, backend
Node.js/Express/TypeScript, database libSQL/Turso, Docker Compose e client Android
Capacitor. Non invia puntate a bookmaker e non movimenta denaro reale.

Questo README è il punto di ingresso della documentazione corrente. Le guide
collegate hanno responsabilità distinte; gli esperimenti falliti sono conservati
nel catalogo delle scelte scartate e nei suoi dati di prova. Vecchi resoconti di
rilascio, roadmap e snapshot operativi non fanno parte della guida corrente.

## Documentazione di riferimento

| Argomento | Riferimento per il tema |
|---|---|
| Componenti, flussi, fonti e mercati | [Architettura](docs/SYSTEM-DESIGN.md) |
| Identità e confini A, A80 e C | [Indice dei modelli](docs/models/README.md) |
| Algoritmo A operativo | [Modello A](docs/models/MODEL-A.md) |
| Algoritmo C, registro e adozione | [Modello C](docs/models/MODEL-C.md) |
| Equazioni e parametri implementati | [Formulario](docs/FORMULARIO-sistema-scommesse.md) |
| Esperimenti falliti e applicabilità a C | [Scelte scartate](docs/FORMULARIO-scelte-scartate.md) |
| Training, benchmark e riproducibilità | [Research](docs/research-platform.md) |
| Azioni dell'app, quote, portafogli e manutenzione | [Operazioni](docs/operations/README.md) |
| Import, Nightly, recuperi e watchdog | [GitHub Actions](docs/github-actions-nightly-sync.md) |
| Configurazione di hosting | [Hostless](docs/operations/hostless-deployment.md) |
| Copia e ripristino dei dati | [Backup Turso](docs/operations/turso-backup.md) |
| Build e aggiornamento Android | [APK privato](docs/android-private-apk.md) |
| Dati diagnostici promozioni/retrocessioni | [Transizioni](docs/competition-transitions/README.md) |
| Gestione di segreti già esposti | [Sicurezza della cronologia](docs/security/history-cleanup.md) |

Le descrizioni seguono codice e configurazione del repository. Il modello C
effettivamente adottato, lo stato remoto, le quote disponibili e il consumo del
provider richiedono una verifica dell'installazione: non sono dedotti da vecchi
report o dalla presenza di un flag nel sorgente.

## Avvio con Docker

Servono Docker con Compose e una configurazione libSQL/Turso valida. Non esiste
un container MySQL o PostgreSQL. Per lo sviluppo usare un database dedicato:
l'avvio del backend inizializza lo schema del database configurato.

1. Creare `.env` da [.env.example](.env.example) soltanto se il file non esiste.
   Conservare la configurazione locale e sostituire i segnaposto, senza salvare
   credenziali in Git.
2. Configurare `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` e l'accesso amministratore.
   `SHARED_ADMIN_PASSWORD_HASH` deve contenere un hash scrypt valido. Il comando
   `npm --prefix backend run auth:hash`, dopo installazione e build backend,
   riceve la password da standard input: non passarla come argomento della shell.
   L'accesso in produzione è bloccato se la configurazione non è valida.
3. Configurare la chiave quote per le operazioni che richiedono il provider.
   Quote mancanti non vengono sostituite con prezzi sintetici utilizzabili.

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://localhost:3001/api/health
```

Interfaccia: `http://localhost:3000`. Backend: `http://localhost:3001/api`.
Le porte sono fissate nel Compose; `FRONTEND_PORT` non modifica `3000:80`.
Nginx del frontend inoltra `/api` al backend del Compose.

```powershell
docker compose logs -f backend frontend
docker compose down
```

Il Compose mantiene disabilitati import automatici all'avvio, scheduler web,
worker T−15 e nuove puntate automatiche. La Nightly finita appartiene a GitHub
Actions. Avviare il sito locale non avvia un secondo ciclo di gioco.

## Sviluppo senza Docker

Node 20 o successivo; usare i lockfile dei due package. I comandi npm non caricano
automaticamente il `.env` della radice: l'ambiente del processo deve essere già
configurato. Python e CatBoost servono alla ricerca, non al backend operativo.

```powershell
npm --prefix backend ci
npm --prefix frontend ci
npm --prefix backend run dev
```

In un altro terminale:

```powershell
npm --prefix frontend start
```

**Destinazione API:** il proxy CRA in [setupProxy.js](frontend/src/setupProxy.js)
punta al backend Hostless, anche se è in esecuzione un backend locale. Per usare
il backend locale, impostare `REACT_APP_API_URL=http://localhost:3001/api`
nell'ambiente del frontend prima di avviarlo, con CORS e sessione configurati per
l'origine locale. La documentazione non cambia automaticamente il proxy.

## Uso dell'app

Il dettaglio distingue analisi sportiva, proposte A/C e quote. Il primo calcolo
sportivo usa dati e quote salvati; aprire la scheda giocate può richiedere quote
reali al provider, entro i controlli di budget. L'anteprima C usa soltanto la
cache. Le puntate manuali richiedono conferma e verifica server di selezione,
quota, saldo ed esposizione; aprire un consiglio non registra una puntata.

A e C hanno portafogli virtuali separati, con ledger e liquidazioni. Lo storico
deterministico è attribuito ad A ma resta separato dai capitali dei portafogli
A/C. Le proposte archiviate senza capitale impegnato non sono puntate né ROI.
La [guida operativa](docs/operations/README.md) descrive queste distinzioni.

Understat è la fonte calcistica primaria; football-data.co.uk integra i campi
mancanti. Ogni quota conserva bookmaker e provenienza reali. Corner e falli
restano bloccati per le giocate; le player props hanno controlli e sezione
separati. Una buona calibrazione non dimostra un vantaggio economico.

## Verifica delle modifiche

Eseguire i controlli pertinenti, distinguendo build, validazione del modello e
verifica dell'installazione remota.

```powershell
npm --prefix backend test
npm --prefix backend run typecheck
npm --prefix backend run lint
npm --prefix frontend run test:ci
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run build
```

`backend test` include già la build. Per modifiche runtime verificare anche
Compose e healthcheck; per sole modifiche documentali verificare coerenza con
i sorgenti, collegamenti, asset necessari e `git diff --check`.
Le fixture [A operativo](backend/test/fixtures/operational-a/README.md) proteggono
sorgenti e comportamento. Non aggiornare i golden per far passare una modifica C.

Le istruzioni di lavoro sono in [AGENTS.md](AGENTS.md). L'APK viene generato
soltanto su richiesta esplicita; una modifica web o documentale non lo aggiorna.
