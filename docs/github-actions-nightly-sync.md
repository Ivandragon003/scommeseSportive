# Nightly GitHub Actions

Questa è la procedura corrente di importazione, manutenzione e registrazione
delle giocate **virtuali** A/C. La configurazione eseguibile è in
[nightly-sync.yml](../.github/workflows/nightly-sync.yml), nello
[script del ciclo](../scripts/ci/nightly-sync.sh) e nel
[processo A/C](../backend/scripts/research-nightly.js). Per portafogli, azioni
manuali e quote consultare la [guida operativa](operations/README.md).
Le impostazioni remote effettive e l'esito dell'ultima esecuzione vanno
verificati su GitHub e nel database: questo documento non certifica un run live.

## Orario e protezione dai duplicati

Il workflow dichiara tre trigger con timezone `Europe/Rome`: principale alle
**03:07**, recuperi alle **04:17** e **05:27**. GitHub può avviarli in ritardo;
non è uno scheduler al minuto e non realizza un'esecuzione T−15 dal kickoff.
La concorrenza `nightly-sync`, con `cancel-in-progress: false`, serializza i run.

Prima di npm, build e accesso al DB, il
[guard](../backend/scripts/nightly-schedule-guard.js) legge le API GitHub.
Un completamento A/C valido richiede nello stesso job i passi riusciti
`Run nightly sync` e `Confirm enabled A/C completion`. Un semplice badge verde,
una cancellazione o un run saltato non provano quel completamento.
Un successo valido della giornata italiana evita un secondo ciclo normale;
metadati incerti o identità incoerente bloccano l'ammissione.
Lease e vincoli DB proteggono ulteriormente dalle doppie registrazioni.
Un recupero dopo errore può ripetere import e richieste: non garantisce zero
consumi aggiuntivi.

La finestra A/C parte dall'esecuzione effettiva e termina alla successiva
Nightly prevista. `RESEARCH_NIGHTLY_WINDOW_HOURS`, se impostata, ammette
1–48 ore. Retry, kickoff modificati e partite iniziate sono ricontrollati;
non si ricostruiscono giocate retroattive.

## Flusso effettivo

1. Avvia un backend temporaneo sul runner, sul DB configurato nei secret,
   con `NODE_ENV=ci`, bootstrap e scheduler interni disabilitati. Attende
   `/api/health` e termina il processo al termine del job.
2. Importa Understat Top 5 con cinque stagioni e dettagli partita.
   Applica il supplemento HTTP/CSV football-data.co.uk ai valori mancanti,
   con quote storiche distinte dalle statistiche. Aggiorna, se abilitati,
   i [riferimenti fra competizioni](competition-transitions/README.md).
3. Sincronizza le giocate legacy, liquida le A/C esistenti tramite
   `POST /api/research/settle` e aggiorna l'audit delle prediction concluse.
   Le liquidazioni precedono il gate per le nuove giocate.
4. Se Understat riesce, prepara le cache persistenti di calibrazione sul runner.
   Un warmup fallito produce un avviso; il calcolo completo resta disponibile
   su richiesta. Il riuso richiede dati, configurazione e hash del codice coerenti.
5. Se `RESEARCH_NIGHTLY_ENABLED=true`, aggiorna i kickoff Top 5 dal calendario
   eventi e avvia il processo finito A/C. I gate obbligatori falliti impediscono
   nuove decisioni valide; lo script conserva l'errore e termina con fallimento.
6. Con `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` registra i consigli dei
   rispettivi motori: A usa `PredictionService`, i mercati squadra supportati
   e lo stake consigliato; C usa il proprio percorso gol e stake 1%.
   La policy limita l'esposizione al 5% e una giocata per partita/famiglia.
   Quote reali, bookmaker, freschezza, capitale e kickoff sono verificati anche
   nella transazione. Con flag recommendation spento resta il percorso diagnostico.
7. Se i gate obbligatori riescono, esegue la learning review; recupera lo stato
   finale e segnala il completamento. Errori della liquidazione legacy,
   dell'audit prediction e del warmup sono avvisi distinti dai gate obbligatori.

Il ciclo non chiama la registrazione legacy `/api/automation/place-valid-bets`,
che risponde `410`. Non piazza scommesse presso bookmaker. Giocatori e
formazioni restano sospesi nella configurazione del workflow; una chiave
API-Football presente non li abilita da sola.

## Limiti per la raccolta prospettica A

La Nightly non è un generatore universale di previsioni A. Nel percorso
recommendation `ResearchRecommendationRuntime.prepare` invoca
`PredictionService.predict` solo dopo aver ottenuto almeno una quota app
reale e fresca. Mancanza di quote, matching, cache-only o budget provider
possono quindi impedire l'inferenza A, non soltanto la giocata. Una
decisione già registrata, origini diagnostiche mancanti o entrambe le
famiglie già puntate possono escludere il lavoro prima dell'inferenza.
Capitale ed esposizione virtuale sono invece verificati dopo il calcolo.

La finestra effettiva del job termina alla successiva Nightly, mentre il
protocollo prospettico richiede una prima previsione tra T−24h e T−60min.
Ritardi del job e variazioni del calendario non permettono di equiparare
le due finestre. Visite utente, worker T−15 ritirato e baseline diagnostica
research non sostituiscono un generatore A con copertura verificata.

Il workflow non passa `MODEL_A_PROSPECTIVE_*` al runner e non configura
persistenza dello spool. Il CLI tenta il drain nel `finally` ordinario;
non installa lo shutdown web su SIGTERM e il timeout shell può terminarlo.
Il timer risultati vive solo mentre quel processo è in esecuzione:
abilitare il recorder sul web non lo abilita automaticamente nella Nightly.
La raccolta richiede prima una decisione su processo, calendario e storage,
senza introdurre dipendenze da quote per la sola previsione sportiva.
Stato e blocchi nel [passaggio di consegne A](models/MODEL-A-FASE-4-HANDOFF.md).

## Configurazione

| Impostazione | Comportamento dichiarato |
| --- | --- |
| Secret `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | DB condiviso del job; verificare che corrisponda a web e altri workflow |
| Secret `ODDS_API_KEY` | Quote bookmaker; solo server/runner |
| Variable `ODDS_API_ACCOUNT_SCOPE` | Default `primary`; stesso scope per chiavi dello stesso account, anche dopo rotazione |
| Variables `RESEARCH_NIGHTLY_ENABLED`, `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` | Due opt-in distinti, entrambi con fallback `false` |
| `RESEARCH_NIGHTLY_MINUTE` | `7` nel workflow; allineare dashboard e monitor. Il runtime isolato ha default `0` |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | `300`, freschezza alla decisione notturna, non al kickoff |
| `RUN_ODDS_SYNC`, `ODDS_INFORMATIONAL_NETWORK_ENABLED` | `false`: niente raccolta informativa generale; il feed essenziale A/C resta distinto |
| `ODDS_EXTRA_EVENT_NETWORK_ENABLED` | `true` nel workflow: mercati per evento di A soggetti a cache, costo e disponibilità |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false`; il worker continuo è ritirato |
| `RESEARCH_NIGHTLY_TIMEOUT_SECONDS` | `1200` per il processo A/C; job complessivo massimo 180 minuti |

I default locali sono in [.env.example](../.env.example); i valori remoti
non derivano automaticamente dal file locale. I flag Hostless dichiarano
lo stato al web, ma non avviano il job GitHub. Budget e cache provider sono
persistenti e condivisi: le soglie locali non attestano il piano o il residuo
reale dell'account. Quote mancanti, obsolete o sintetiche non diventano quote
bookmaker per evitare un'astensione.

## Recupero controllato

Prima di ritentare, verificare giornata italiana, commit, stato dei run,
assenza di una Nightly attiva, completamenti già riusciti e causa dell'errore.
Un tentativo della giornata precedente non recupera una diversa giornata.

- **Errore ordinario prima del completamento:** correggere la causa, poi
  avviare la Nightly della giornata corretta conservando guard e idempotenza.
- **Fixture mancanti dopo un successo A/C odierno:** input manuale
  `recover_missing_fixtures=true`. È un'eccezione esplicita al salto giornaliero,
  non un ricalcolo delle decisioni già registrate.
- **Astensioni per blocco tecnico recuperabile:** input
  `recover_technical_failures=true`, `recovery_source_policy` con hash SHA-256
  della policy originale e `recovery_day` nel formato `YYYY-MM-DD`
  (vuoto significa oggi a Roma). Il recupero richiede A/C e recommendation
  abilitate, fonti verificate e kickoff futuro; crea una policy figlia e
  preserva giocate esistenti e decisioni non tecniche. Controlla i recuperi
  già conclusi anche al commit.

Il [planner tecnico](../backend/scripts/recover-recommendation-technical.js)
legge il DB e scrive soltanto un piano privato locale. Da `backend`, con
credenziali già caricate in ambiente e preferibilmente token RO dedicato:

```powershell
node scripts/recover-recommendation-technical.js plan --source-policy <hash-originale> --day <YYYY-MM-DD> --out artifacts/recovery/<nome-univoco>.json
```

Richiede dipendenze e build backend coerenti. La produzione del piano non
esegue il recupero e non prova nuove giocate.

Per un errore DNS Understat, controllare separatamente DNS e HTTPS della
fonte ufficiale, senza DB o provider quote:

```powershell
Resolve-DnsName understat.com
Invoke-RestMethod 'https://dns.google/resolve?name=understat.com&type=A'
Invoke-RestMethod 'https://cloudflare-dns.com/dns-query?name=understat.com&type=A' -Headers @{accept='application/dns-json'}
```

Il workflow manuale [Source connectivity diagnostic](../.github/workflows/source-connectivity.yml)
prova DNS/HTTPS pubblici dal runner senza credenziali. Usa endpoint stagionali
codificati: verificarne la pertinenza prima di interpretare il risultato.
Un HTTP raggiungibile non dimostra copertura importata. Non sostituire
Understat, non fissare IP storici, non disabilitare TLS e non allentare il
matching football-data per superare il gate. Ricontrollare il supplemento
dopo il recupero della fonte primaria.

## Monitoraggio e prova del risultato

Il [watchdog](../.github/workflows/research-watchdog.yml) parte ogni ora al
minuto 37, dopo `Nightly Sync` e manualmente. Usa
[check-research-nightly.js](../backend/scripts/check-research-nightly.js),
indipendente dal backend Hostless: non avvia l'app, non migra il DB, non
contatta il provider quote e non registra giocate.

- `RESEARCH_NIGHTLY_MONITOR_ENABLED=true` richiede un completamento A/C
  programmato; il default remoto dichiarato nel workflow è `false`.
  `expect_enabled=true` lo richiede per il controllo manuale.
- `RESEARCH_NIGHTLY_DB_MONITOR_ENABLED=true` attiva il controllo DB separato.
  Richiede `TURSO_DATABASE_URL` e `TURSO_WATCHDOG_READONLY_TOKEN` dedicato:
  non ripiega sul token di scrittura.
- Gli errori osservati, gli stalli recenti, le liquidazioni arretrate e la
  coerenza contabile restano distinti dall'aspettativa di una nuova Nightly.
  Un errore di accesso non è un esito sano.
- `RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS` è un'eccezione stretta per
  run storici senza job, ancora queued e di una giornata precedente.
  Non cancella run o allarmi generici; un run che riparte torna segnalato.

Da `backend`, con ambiente privato già configurato:

```powershell
npm run research:watchdog -- --github-only
npm run research:watchdog -- --database-only
```

Il primo richiede `GITHUB_TOKEN` e `GITHUB_REPOSITORY`, senza build o accesso DB.
Il secondo richiede dipendenze/build e token RO; esegue SELECT e non crea schema.
Senza opzioni, il controllo DB è `NOT_CHECKED` se mancano le sue credenziali.
Exit code `0` indica controlli superati; `1` indica problemi.

Per attestare il recupero servono passi Sync e marker A/C riusciti, gate dati
coerenti, controllo GitHub e controllo DB superati. Zero giocate può essere
una corretta astensione: verificare decisioni, motivi, quote, ledger e
liquidazioni, senza forzare una puntata. Una Nightly riuscita non dimostra
redditività o completamento futuro del ciclo sportivo.

Il riepilogo in-app della giornata precedente è preparato dopo reconcile
con contabilità stabile e reso visibile dalle 09:00 Europe/Rome.
Il GET non lo crea e non invia email: verificare la riga effettivamente
preparata, non dedurla dal solo badge del workflow.

## Calibrazione, arresto e rollback

[Prepare prediction calibration](../.github/workflows/calibration-warm.yml)
prepara cache sul DB configurato per push pertinenti o avvio manuale;
esclude i cambi esclusivamente `backend/src/research/**`.
[Research training](../.github/workflows/research-training.yml) gestisce il
training separato: un risultato di benchmark non promuove automaticamente C.

Per fermare le nuove giocate recommendation disabilitare
`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED`, conservando workflow completo,
import e liquidazioni. `RESEARCH_NIGHTLY_ENABLED=false` disabilita tutto il
processo A/C ma non le liquidazioni esistenti eseguite prima nello script.
La sola CLI A/C o un retry saltato non sostituiscono il ciclo manutentivo.
Non riattivare `AUTO_BET_*` o il worker T−15. Preservare ledger, input,
snapshot, versioni e migrazioni; usare soltanto rollback di codice compatibili
con lo schema e [backup verificati](operations/turso-backup.md).
