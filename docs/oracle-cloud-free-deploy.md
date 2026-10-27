# Deploy remoto gratuito e processo T−15

Guida aggiornata il 27 ottobre 2026. Il repository contiene la configurazione;
non viene dichiarato un server remoto già attivo o puntuale. Servono un account
disponibile, risorse gratuite, credenziali del database e verifica operativa.
Non attivare piani a pagamento per superare un blocco del gratuito.

L'utente ha scelto di mantenere tutto locale, senza commit o push, e ha
confermato di non avere una VM. Questa rimane una guida per un'eventuale
attivazione futura: nessuna infrastruttura è stata creata. La nightly remota
precedente risulta ancora attiva; la sua disattivazione non è stata distribuita.

## Scelta dell'host

La soluzione più compatibile è una VM Linux sempre accesa con Docker Compose,
lo stesso backend Node/Express e lo stesso Turso remoto. L'inferenza CatBoost
usa alberi JSON in TypeScript; il container web non richiede Python. Training
e benchmark si eseguono separatamente dal ciclo decisionale, evitando di
occupare CPU nella finestra di kickoff.

Oracle Always Free è un candidato, non un requisito o una garanzia di servizio.
La documentazione corrente indica A1 fino a 2 OCPU/12 GB complessivi, capacità
regionale variabile e possibile recupero delle istanze inattive. Verificare
la label Always Free, quote e risorse nel proprio account prima di crearle.
L'attivazione richiede verifica dell'identità e può richiedere una carta;
non passare automaticamente a Pay As You Go.

| Servizio | Esito per questo progetto |
|---|---|
| Oracle Always Free VM | Riusa Compose e processo persistente; capacità e continuità da verificare nell'account |
| GitHub Scheduled Workflows | Adatto alla nightly e al training periodico; ritardi e job persi impediscono di garantire T−15 |
| Cloudflare Workers Free | CPU 10 ms per cron, memoria 128 MB: non esegue adeguatamente questo monolite; nessun secondo scheduler introdotto |
| Host che sospende processi inattivi | Non soddisfa un processo decisionale sempre acceso senza una verifica specifica |

Non è stata dimostrata una soluzione gratuita con SLA sufficiente a garantire
ogni singola decisione a T−15. Il sistema misura il ritardo e si astiene fuori
finestra; non trasforma un disservizio in una puntata retroattiva.

## Configurazione effettiva

Usare i file esistenti [docker-compose.yml](../docker-compose.yml),
[.env.example](../.env.example) e [script deploy](../scripts/deploy-prod.sh).
Le precedenti istruzioni riferite a `docker-compose.prod.yml` e
`.env.production.example` non corrispondevano ai file presenti e sono ritirate.

1. Preparare un host Linux con Docker Engine/Compose e orologio sincronizzato.
   Seguire la [guida ufficiale Docker](https://docs.docker.com/engine/install/ubuntu/)
   compatibile con distribuzione e architettura; non esporre Docker su Internet.
2. Copiare il repository nella versione verificata e creare `.env` da
   `.env.example`. Inserire soltanto sul server i secrets Turso, odds e hash
   dell'accesso amministratore. Il backend non deve partire in produzione
   senza la configurazione di autenticazione prevista dal progetto.
   Conservare i terminatori LF degli script shell secondo `.gitattributes`:
   una copia da Windows con CRLF può fallire prima di eseguire la manutenzione.
   Verificare `bash -n scripts/ci/nightly-sync.sh` nell'ambiente Linux di arrivo.
3. Mantenere `NIGHTLY_ORCHESTRATOR=github_actions`; la nightly continua sul runner
   e i collector duplicati nel container rimangono disabilitati. Non abilitare
   insieme un secondo import notturno nel backend.
4. Mantenere inizialmente `RESEARCH_T15_SCHEDULER_ENABLED=false`. Attivare prima
   la manutenzione, osservare lo stato e preparare modelli/mercati validati.

```dotenv
TZ=Europe/Rome
NIGHTLY_ORCHESTRATOR=github_actions
AUTO_SYNC_ON_BOOT=false
UNDERSTAT_SCHEDULER_ENABLED=false
ODDS_SNAPSHOT_SCHEDULER_ENABLED=false
LEARNING_REVIEW_SCHEDULER_ENABLED=false
PLAYER_DATA_ENABLED=false
PLAYER_AVAILABILITY_ENABLED=false
LINEUP_REFRESH_SCHEDULER_ENABLED=false
RESEARCH_T15_SCHEDULER_ENABLED=false
ODDS_PRIMARY_PROVIDER=odds_api
ODDS_API_T15_KEY=
ODDS_API_ACCOUNT_SCOPE=primary
ODDS_API_MONTHLY_CREDITS=500
ODDS_API_RESERVE_CREDITS=50
ODDS_INFORMATIONAL_NETWORK_ENABLED=false
ODDS_EXTRA_EVENT_NETWORK_ENABLED=false
```

Nel workflow/script nightly mantenere anche `RUN_ODDS_SYNC=false`. La chiave
non autorizza da sola richieste informative; T−15 usa una politica essenziale
separata. Tutti i processi con lo stesso account provider devono condividere
Turso e `ODDS_API_ACCOUNT_SCOPE`, anche se usano chiavi ruotate: cambiare scope
per simulare nuovi crediti romperebbe la contabilità. Altri client esterni che
usano la stessa quota non sono deduplicabili dal backend e richiedono controllo.
La chiave opzionale `ODDS_API_T15_KEY` seleziona un accesso già autorizzato;
una seconda chiave non implica un nuovo budget della sottoscrizione.
La migrazione additiva `018_smart_odds.sql` persiste budget, cache, lease e
registro delle richieste; includerla in backup e restore.

`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ODDS_API_KEY` e
`SHARED_ADMIN_PASSWORD_HASH` devono avere i valori privati già autorizzati.
Nessun esempio contiene credenziali reali. L'APK e il browser usano il medesimo
backend autenticato; non ricevono secrets del DB o dei provider.

## Avvio e accesso

Dalla root sul server:

```bash
docker compose up -d --build backend frontend
docker compose ps
curl --fail http://localhost:3001/api/health
```

Con il Compose esistente frontend e backend espongono rispettivamente 3000 e
3001 sull'host. Configurare firewall e proxy HTTPS prima dell'accesso pubblico:
non presumere che il backend sia già su rete privata perché il frontend usa
`/api`. Il client Android richiede un URL HTTPS accessibile secondo la guida
[APK](android-private-apk.md). La pubblicazione di un dominio/proxy va verificata
separatamente; un container healthy non la prova.

`restart: unless-stopped` riparte con Docker ma non offre alta disponibilità.
Verificare il riavvio del servizio Docker dopo un reboot e il collegamento al
DB remoto. Il codice non crea una seconda copia del database per la VM.

## Gate prima di abilitare le decisioni

Verificare tutti i seguenti punti con evidenze conservate:

- La nightly aggiornata termina senza creare nuove puntate; la route legacy
  `/api/automation/place-valid-bets` risponde `410` anche con i vecchi flag.
- Il registry contiene artefatti A/C compatibili e i mercati autorizzati hanno
  evidenze di validazione. L'assenza di C o di calibrazione non si sostituisce
  silenziosamente con A sotto un'etichetta C.
- I due portafogli shadow sono separati e i saldi si ricostruiscono dai movimenti.
- Le quote reali mantengono bookmaker e timestamp provider; età massima cinque
  minuti e crediti del piano sufficienti per il carico scelto.
- La pagina quote e `GET /api/research/odds-status` distinguono residuo osservato
  e pianificazione: nessun header significa residuo sconosciuto. Verificare
  con richieste gratuite il rollover provider prima di ammettere consumo nel
  nuovo mese; il reset UTC locale non è una garanzia del provider.
- Gli orari sono UTC, i job persistono dopo un riavvio e concorrenza/retry non
  duplicano decisioni o stake.
- Target, durata di preparazione, commit e ritardo sono osservabili. Per una
  partita alle 20:45 il target è 20:30, con tolleranza fino alle 20:31.
- Un test di ritardo oltre finestra produce `MISSED`, senza recupero; nessuna
  puntata viene creata dopo il kickoff.
- La liquidazione di un risultato confermato aggiorna una sola volta il ledger.
- Backup e restore isolato sono stati eseguiti e controllati.

Solo dopo questi gate impostare `RESEARCH_T15_SCHEDULER_ENABLED=true` sull'unico
processo decisionale remoto e ricreare il container backend. Il runner nightly
resta con il flag a `false`. La tolleranza +60 secondi e polling 15 secondi sono
vincoli implementati: l'affidabilità effettiva richiede misure remote, anche
durante chiamate provider lente, partite simultanee e training.

## Controlli periodici e recupero

Consultare Confronto A/C e `GET /api/research/overview`: ultimo heartbeat,
job futuri/mancati, errori, versioni, mercati e portafogli. Controllare anche
il run nightly effettivo; il run saltato per il gate ora legale non prova una
sincronizzazione riuscita. Osservare consumo CPU/memoria, latenza DB, crediti
odds e ritardi rispetto al target. Il telefono può restare spento.

La rilevazione di un host completamente spento richiede un monitor esterno.
Non considerare una riga di stato nel suo DB come prova di una notifica esterna.
Nessuna notifica per singola puntata è necessaria. Riepilogo giornaliero e
segnalazioni tecniche deduplicate richiedono un canale effettivamente
configurato e verificato, senza invii non autorizzati.

Se il nuovo deploy regredisce, disabilitare nuove decisioni, conservare DB ed
evidenze e ripristinare l'immagine precedente compatibile. La procedura di
[backup e rollback](research-platform.md#backup-e-rollback) preserva puntate
aperte e versioni originarie; non cancellare tabelle research o storico legacy.

## Costi e fonti ufficiali

Obiettivo: zero costi ricorrenti entro i limiti dei servizi già disponibili.
Non sono stati attivati VM, piani paid, domini o subscription in questa guida.
The Odds API Starter offre 500 crediti/mese: il carico di cinque leghe può
superarli e in tal caso il sistema deve astenersi. Gli endpoint storici del
provider richiedono un piano paid e non vengono introdotti come dipendenza.
Spegnere quote notturne e rete informativa riduce la domanda, ma non garantisce
copertura completa: la [simulazione offline](performance/odds-demand-2026-10-27.md)
calcola 447 crediti per ottobre 2026 e 654 nel mese storico più oneroso del
calendario disponibile. Non sono consumi misurati né prove di disponibilità.
La [scheda quote](operations/smart-odds-2026-10-27.md) e l'[audit dei provider](operations/odds-provider-audit-2026-10-27.md)
documentano i limiti; Eurobet gratuito e un fallback fresco non sono dimostrati.

Riferimenti controllati il 27 ottobre 2026:

- [Oracle Always Free risorse e reclaim](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
- [Oracle Free Tier FAQ](https://www.oracle.com/cloud/free/faq/).
- [GitHub ritardi del cron](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
- [Cloudflare Workers limiti](https://developers.cloudflare.com/workers/platform/limits/).
- [The Odds API piani](https://the-odds-api.com/) e [storico](https://the-odds-api.com/historical-odds-data/).

Per fonti, audit dei modelli e stato dei requisiti vedere
[piattaforma A/C](research-platform.md). La precedente guida allo scraping
Eurobet è superata: il runtime corrente usa The Odds API e non garantisce
copertura Eurobet.
