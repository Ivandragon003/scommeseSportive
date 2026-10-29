# Avvio concorrente ResearchStore locale: correzione del 29 ottobre 2026

La CI della revisione documentale `ed9e58ad`, run
[40864133445](https://github.com/Ivandragon003/scommeseSportive/actions/runs/40864133445),
ha evidenziato un errore reale nell'avvio concorrente sul database locale.
Il codice applicativo era lo stesso di `122fd360`, la cui CI precedente era
verde: il problema dipende dalla contesa, non da una modifica dei documenti.

## Causa riprodotta

Con le dipendenze fissate nel [lockfile](../../backend/package-lock.json),
`@libsql/client` 0.14.0 e driver nativo `libsql` 0.4.7, un `SQLITE_BUSY`
durante `PRAGMA journal_mode=WAL` o `BEGIN` può lasciare uno statement non
finalizzato sulla connessione inattiva del client `file:`. Riprovare soltanto
l'operazione può riutilizzare quella connessione e far fallire il successivo
`COMMIT` con `SQL statements in progress`.

Il riscontro usa errori prodotti dal driver reale su file temporanei e due
client concorrenti, non soltanto eccezioni simulate. Nel driver locale,
`transaction()` stacca la connessione dal client dopo un `BEGIN` riuscito;
il ramo di errore può invece conservarla per l'uso successivo.

## Correzione limitata

[ResearchStore](../../backend/src/research/ResearchStore.ts) conserva
l'inizializzazione lazy del WAL, la coda di scrittura e i limiti del backoff
esistenti. Dopo un errore di contesa, e soltanto con protocollo `file`,
stacca la connessione inattiva mediante una transazione `deferred` vuota,
esegue rollback e chiude quella transazione prima del retry delle guardie o
del `BEGIN` di scrittura.

Non chiude il client condiviso, non interviene sulle connessioni possedute
da transazioni già aperte e non ripete callback di scrittura o `COMMIT`.
Per i protocolli remoti il nuovo recupero non esegue alcuna operazione:
il comportamento Turso rimane invariato. Non sono cambiate dipendenze,
modelli, regole economiche o dati di produzione.

La correzione riguarda database locali persistenti `file:`. Non introduce
supporto alle normali scritture su database in memoria: quel limite era già
presente e le prove su file non lo rimuovono.

## Verifiche ripetibili

I [test dello store](../../backend/test/research-store.test.js) aggiungono tre
regressioni:

- Contesa reale sul PRAGMA WAL: il client recupera, crea le guardie e produce
  esattamente due aperture di portafoglio, mantenendo i trigger di immutabilità.
- Contesa reale sul `BEGIN`: la lettura già aperta resta utilizzabile e le
  quattro scritture di inizializzazione vengono eseguite una sola volta.
- Protocollo remoto: il retry non apre la transazione `deferred` di recupero
  e non chiude il client condiviso.

Dalla directory `backend`, dopo la build del codice modificato, il controllo
mirato è:

```powershell
node --test --test-concurrency=1 test/research-store.test.js
```

`npm test` esegue invece build e suite backend completa. Risultati locali
comunicati durante la verifica della patch:

| Controllo | Risultato |
| --- | --- |
| Prima suite backend completa Windows della correzione | 768/768 superati, circa 18,604 s |
| Typecheck e lint backend | Superati |
| Controlli mirati Windows | 70/70 superati |
| Test store su Linux | 31/31 superati |
| Variante equivalente di stress 200 × 4, 800 processi | Zero errori, risultato confermato dal tool |
| Stress finale separato | Esito non recuperabile dopo interruzione, non conteggiato |

La revisione della correzione non ha individuato blocchi per database locali
persistenti o protocolli remoti; non sostituisce i gate di esecuzione successivi.
Per lo stress finale separato, il container temporaneo è
terminato ed è stato rimosso automaticamente dopo l'interruzione; la sessione
non è recuperabile. Il suo tentativo non viene sommato alle prove riuscite.

## Verifica successiva: gate Windows non superato

Durante il gate completo della successiva patch di osservabilità quote,
777 asserzioni singole sono passate, ma il processo del file ResearchStore
è terminato con crash nativo `0xC0000005`, pur avendo passato le sue 31
asserzioni. Il gate Windows complessivo **non è passato**. Il precedente
768/768 resta un risultato storico vero, non l'esito dell'ultimo gate.

L'indagine limitata ha prodotto questi riscontri: su baseline precedente a
`cc842005`, 12 run con 11 successi e un `SQLITE_BUSY` legacy, senza crash nativo;
il file corrente può andare in crash anche con il vecchio corpus di 26 test,
escludendo i cinque nuovi test di lock; un riproduttore del solo driver con
1.360 cicli di contesa non è andato in crash. Non è dimostrato che il crash
sia preesistente o causato dalla correzione. Nessuna modifica speculativa o
nuova dipendenza è stata applicata.

Il gate Linux Node 20 è preparato da 534 soli file tracciati, circa 10 MB,
senza credenziali e con rete disabilitata. I suoi 2 CPU/1 GiB sono limiti
della suite QA, non risorse richieste per il worker di produzione. Il primo
run ha contato 777 test: 772 superati, quattro fallimenti dei test backup
per Python assente nell'immagine QA, un opzionale saltato. Dopo aver aggiunto
`python3` e `python-is-python3` alla sola immagine privata, il nuovo gate Linux
completo è riuscito: **777 test, 776 superati, un opzionale CatBoost saltato,
zero fallimenti**. Il gate Windows con crash nativo resta non superato. Il
Dockerfile di produzione non è stato modificato: l'inferenza CatBoost rimane
in Node senza Python.

La successiva correzione di osservabilità quote è stata pubblicata in
`60a6baac`, con CI `40889233354` riuscita: 777 test backend, 776 passati,
un opzionale saltato, zero fallimenti. Anche calibrazione `40889233171`
riuscita, warmup compreso. Questo non risolve il limite nativo
Windows. Il gate cache SELECT-only dall'immagine di produzione `60a6baac`
al Turso reale è passato: 40 profili per passaggio, 80 hit validi, 100 SELECT,
zero fit/scritture/provider. Non esercita il percorso di scrittura nativo locale.
Deployment backend manuale richiesto alle 15:18 CET e in coda; al checkpoint
15:21 web LIVE ancora `122fd360`, senza nuovo deploy frontend.

Queste prove verificano recupero della contesa locale e assenza di scritture
duplicate nelle fixture. Non certificano avvio, uptime o puntualità di un
worker Hostless e non modificano lo stato di produzione descritto nel
[report operativo](production-status-2026-10-29.md).
