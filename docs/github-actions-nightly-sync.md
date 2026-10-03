# GitHub Actions per sync notturna

La nightly è orchestrata da GitHub Actions. Il backend web serve UI e API;
il collector delle formazioni vicino al kickoff rimane indipendente.

## Flusso

- Avvio di un backend temporaneo con bootstrap e tutti i collector periodici disabilitati.
- Import Understat su stagione corrente e quattro precedenti, con verifica di copertura.
- Supplemento HTTP/CSV `football-data.co.uk`: riempie solo i campi mancanti di
  tiri, tiri in porta, falli, corner, cartellini e arbitro; conserva le quote
  storiche di apertura/chiusura nella loro colonna dedicata. Non fornisce il possesso.
- Aggiornamento dei riferimenti per le transizioni tra competizioni e dei
  kickoff/formazioni quando il provider configurato è disponibile.
- Settlement delle prediction, raccolta quote reali tramite il provider
  configurato e registrazione delle giocate nel budget interno secondo i flag
  del workflow. Non vengono effettuate puntate sui siti bookmaker.
- Learning review solo quando i gate obbligatori sono soddisfatti.
- Stato finale e log come artifact GitHub Actions; un gate fallito mantiene il run fallito.

Riferimenti: [workflow](../.github/workflows/nightly-sync.yml) e
[script](../scripts/ci/nightly-sync.sh). Le quote sintetiche restano interne;
bookmaker e provenienza delle quote reali vengono conservati.

## Consumo del database

I CSV storici già verificati evitano nuovi download, ma la copertura nel DB
continua a essere controllata. Il supplemento legge solo le finestre stagionali
richieste. Le righe già identiche non generano UPDATE; le condizioni SQL
proteggono comunque le scritture concorrenti. Le statistiche cambiano solo se
la fonte può riempire un campo mancante e le quote solo quando cambiano.
Le medie vengono ricalcolate sulle sole squadre con statistiche modificate,
anche quando un'altra stagione è incompleta. Il gate di completezza rimane obbligatorio.
Se la retention elimina partite, si ricalcolano invece tutte le squadre per
rimuovere dai valori derivati lo storico eliminato; le elaborazioni già in
corso vengono invalidate prima di attendere il download supplementare.

Per Rennes–PSG del 23 agosto 2026, Ligue 1 2026/27, la
[LFP ha invertito il campo](https://ligue1.com/fr/articles/l1_article_5699-j1-psg-rennes-inverse-l1-2627).
Understat conserva l'ordine PSG–Rennes. Solo per questa partita, risultato
ufficiale 2–2 e un unico candidato inverso nella stessa data, il supplemento
orienta statistiche e quote per squadra. Il JSON delle quote conserva ordine
originale della fonte, mapping e riferimento ufficiale. L'identità primaria
rimane invariata: l'etichetta casa/trasferta Understat resta una discrepanza
nota. Nessun matching inverso generico viene abilitato.

Il batching riduce le richieste di rete; i contatori Turso di righe lette e
scritte devono essere misurati separatamente. Non cancellare lo storico per
risolvere un limite di letture.

## Un solo orchestratore

`NIGHTLY_ORCHESTRATOR=github_actions` è il default anche per un avvio diretto
con Node. Disabilita bootstrap, scheduler Understat, quote e learning persino
quando vecchi flag in ambiente sono `true`. Docker Compose imposta questo
valore esplicitamente. API manuali e collector formazioni restano disponibili.

Per una scelta esplicita di esecuzione nel backend si può impostare
`NIGHTLY_ORCHESTRATOR=backend` e abilitare i relativi flag. In quel caso
disabilitare prima il workflow GitHub e mantenere un unico processo scheduler.
Gli aggiornamenti si applicano dopo il riavvio/redeploy dei processi esistenti.

## Configurazione e verifica

Secrets obbligatori: `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN`.
`ODDS_API_KEY` abilita la raccolta quote prevista dal workflow;
`API_FOOTBALL_KEY` è necessaria per i relativi aggiornamenti di kickoff/formazioni.
Non pubblicare i valori dei secrets nei log o nel repository.

L'orario previsto è **03:00 Europe/Rome**: cron `0 1 * * *` in estate e
`0 2 * * *` in inverno. Lo script sceglie il cron attivo dall'offset e dal
trigger originale, anche in caso di ritardo GitHub; l'altro run termina senza
sync. Il gruppo di concurrency impedisce sovrapposizioni tra run del workflow.
Un run verde con `Skip scheduled run` non dimostra che la sync sia riuscita.

Dopo il push, la CI verifica il codice. Per verificare l'intera nightly contro
il DB configurato usare `Actions → Nightly Sync → Run workflow` e controllare
gate, copertura delle stagioni, snapshot e conclusione del run effettivo.
Questa verifica esegue gli import e le scritture del normale job.
