# Recupero Nightly e configurazione quote — 30 ottobre 2026

## Incidente osservato

Il run GitHub `41024605166`, cron invernale previsto alle 03:00 Roma,
è stato creato alle 08:09:51 UTC / 09:09:51 Roma. La sincronizzazione dati e
la preparazione delle calibrazioni sono terminate; il passo A/C delle 09:16
ha analizzato quattro incontri, senza registrare puntate, e li ha saltati.
Il provider ha restituito header `used=500`, `remaining=0`, `last=0`.
Tre richieste successive sono state negate localmente dal budget condiviso.
Il precedente run `41016280133` verde era soltanto il cron estivo inattivo:
non attestava un aggiornamento o una decisione A/C.

Il codice classificava tutti i 401/403 come autenticazione e scartava il
codice del provider. Inoltre aggiornava la quota in memoria solo sui successi:
il budget persistente era zero, mentre il riepilogo mostrava `null`.
Il corpo originale dell'errore non è conservato e non viene ricostruito.

Una verifica gratuita della credenziale locale già esistente ha restituito
HTTP 200, 295 crediti usati e 205 residui, costo zero. Le due osservazioni
non giustificano una rotazione per aggirare il limite: occorre riallineare
tutti i client alla configurazione canonica e riconciliare lo stato errato
con una prova fresca, preservando lo storico dei tentativi.

## Correzioni del trasporto quote

- `OUT_OF_USAGE_CREDITS` è riconosciuto come `odds_credit_budget_exhausted`
  anche quando il provider risponde HTTP 401. `INVALID_KEY` resta un errore
  di autenticazione.
- Solo codici esplicitamente ammessi e i tre header numerici sono conservati:
  niente corpo arbitrario, chiavi, URL autenticati o header privati nei log.
- La quota osservata viene aggiornata anche sulla risposta fallita. Un errore
  privo di header validi non produce una quota inventata.
- L'esaurimento dei crediti non attiva il cooldown di autenticazione né un
  fallback con nuove richieste. Limite 500, riserva 50, cache e prenotazioni
  atomiche rimangono invariati. Cambiare chiave non ripristina il budget.

## Prova remota gratuita

Il workflow manuale `Odds API Smoke` ha ora `quota_only=true` predefinito.
Questo job riceve soltanto `ODDS_API_KEY`: non riceve credenziali Turso e non
installa dipendenze o inizializza il database. Esegue una sola richiesta a
`https://api.the-odds-api.com/v4/sports/`, con timeout, senza redirect o retry.
Stato, quota, costo e codici sicuri sono gli unici dati pubblicati.
L'endpoint è [gratuito secondo la documentazione ufficiale](https://the-odds-api.com/liveapi/guides/v4/).
Una risposta con zero crediti residui può verificare la validità della chiave,
ma non autorizza la successiva acquisizione di quote.

```powershell
gh workflow run odds-api-smoke.yml -f quota_only=true
```

Il vecchio smoke quote resta disponibile solo con `quota_only=false`, con
le precedenti condizioni di rete. Non è il test diagnostico predefinito.

## Stato operativo al primo rilascio della correzione

Il secret GitHub è stato riallineato alla credenziale canonica esistente
alle 09:29 UTC; la stessa configurazione è stata salvata su Hostless come
write-only e riletta dopo il ricaricamento della pagina. Il backend richiede
un nuovo deployment per caricare il valore salvato. La registrazione A/C
GitHub è temporaneamente spenta durante questa verifica; la liquidazione
delle puntate esistenti e lo storico restano preservati.

La riconciliazione del budget, il nuovo deployment, i trigger di recupero e
il collaudo A/C reale non sono attestati da questo primo checkpoint.
I dettagli successivi devono essere aggiunti soltanto dopo verifica remota.
Nessuna nuova chiave, account, piano o risorsa a pagamento è stata creata.

## Recupero dello scheduler

La nuova programmazione usa `timezone: Europe/Rome`: 03:07 principale,
04:17 e 05:27 di recupero. La policy decisionale, il monitor e la dashboard
di produzione ricevono `RESEARCH_NIGHTLY_MINUTE=7`; il default locale resta
zero per compatibilità. Il cambio d'ora è gestito dalla timezone nativa.

Il gate legge soltanto metadati GitHub prima di installazione e build. Verifica
data Roma e successo effettivo dello step `Run nightly sync`, seguito nello
stesso job dal marker `Confirm enabled A/C completion`. Una manutenzione
con A/C disabilitate non consuma la giornata. Un marker riuscito con timestamp
incoerenti blocca il gate; un workflow
verde che ha saltato il lavoro non esaurisce la giornata. Un successo reale
impedisce nuove elaborazioni; un errore può essere recuperato. Errori API o
metadati insufficienti bloccano il gate. Concorrenza seriale e vincoli del DB
restano attivi. Il recupero non promette una sola richiesta giornaliera dopo
una vera failure: cache e budget atomico limitano anche i tentativi successivi.

L'orfano `40940944902` può essere riconosciuto con la sola variabile esplicita
`RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS`. Solo quel run, se ancora queued,
privo di job e di giornata precedente, resta informativo. Non viene cancellato.
Ogni riattivazione genera `github_acknowledged_orphan_revived`, anche dopo
36 ore e anche se termina, senza nascondere fallimenti correnti o altri stalli.

GitHub [documenta ritardi e possibili eventi persi](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
specialmente al minuto zero. Questi controlli aumentano la resilienza, ma non
garantiscono le 03:07. La puntualità va misurata sui prossimi trigger reali.

## Rilascio e riconciliazione verificati

Il backend `013209419ef25b949525485a92fb0448ed5d6b8b` è LIVE, deployment
`6ae468ad1a67b8db20f91272`. Health HTTP 200 e vecchia route automatica HTTP 410.
Sono attive le 58 variabili salvate, compreso il minuto 7 e la chiave quote
write-only. Nessuna risorsa CPU/RAM o piano è stato modificato.

Il probe GitHub `41035190734`, alle 09:41 UTC, ha verificato HTTP 200,
used 295, remaining 205 e lastCost 0. I CI `41035190628` e `41036240205`
sono riusciti, così come le preparazioni cache `41035190648` e `41036240296`.

Alle 10:01:04 UTC una riconciliazione operativa atomica ha corretto i soli
campi quota del budget `odds_api/primary/2026-10` da 500/0 a 295/205,
sulla base di prove fresche concordanti. Anchor 15, reset flag, limite 500
e riserva 50 sono conservati. Un evento `QUOTA_RECONCILED` documenta la
correzione; richieste, risultati, cache, eventi preesistenti e dati finanziari
mantengono i loro hash. Non è un reset mensile né un cambio di account per
aggirare la quota. Le prove e l'approvazione monouso sono conservate privatamente.
La registrazione resta sospesa fino all'avvio controllato del collaudo remoto.

## Verifica locale del rilascio

Build e lint superati. Le tre suite quote hanno 40/40 test passati su Linux
Node 20, senza rete, con 2 CPU e 1 GiB. Su Windows Node 24 tutte le asserzioni
passano, ma il driver nativo termina il file con `0xC0000005`: quel controllo
non è dichiarato verde. Gli otto test del probe usano fetch simulato e passano
senza richieste al provider. Questi test non dimostrano un ciclo sportivo reale.
