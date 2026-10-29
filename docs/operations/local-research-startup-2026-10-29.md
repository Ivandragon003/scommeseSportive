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
| Suite backend completa Windows | 768/768 superati, circa 18,604 s |
| Typecheck e lint backend | Superati |
| Controlli mirati Windows | 70/70 superati |
| Test store su Linux | 31/31 superati |
| Variante equivalente di stress 200 × 4, 800 processi | Zero errori, risultato confermato dal tool |
| Stress finale separato | Esito non recuperabile dopo interruzione, non conteggiato |

La revisione non ha individuato blocchi per database locali persistenti o
protocolli remoti. Per lo stress finale separato, il container temporaneo è
terminato ed è stato rimosso automaticamente dopo l'interruzione; la sessione
non è recuperabile. Il suo tentativo non viene sommato alle prove riuscite.

Queste prove verificano recupero della contesa locale e assenza di scritture
duplicate nelle fixture. Non certificano avvio, uptime o puntualità di un
worker Hostless e non modificano lo stato di produzione descritto nel
[report operativo](production-status-2026-10-29.md).
