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

## Controlli locali

Build e lint superati. Le tre suite quote hanno 40/40 test passati su Linux
Node 20, senza rete, con 2 CPU e 1 GiB. Su Windows Node 24 tutte le asserzioni
passano, ma il driver nativo termina il file con `0xC0000005`: quel controllo
non è dichiarato verde. Gli otto test del probe usano fetch simulato e passano
senza richieste al provider. Questi test non dimostrano un ciclo sportivo reale.
