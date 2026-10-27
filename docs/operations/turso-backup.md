# Backup Turso e verifica del ripristino

Lo script `backend/scripts/backup-turso.js` non avvia l'applicazione e non
applica migrazioni. Legge il database remoto con il token già autorizzato
nell'ambiente. Il ripristino scrive esclusivamente un **nuovo file locale**:
non esiste un comando di restore verso produzione.

## Metodo e limiti

Il metodo è quello della [CLI ufficiale Turso, `db shell .dump`](https://github.com/tursodatabase/turso-cli/blob/main/internal/cmd/db_shell.go):
GET HTTPS `/dump`, token nell'header Authorization, nessun token nell'URL.
Il [server libSQL](https://github.com/tursodatabase/libsql/blob/main/libsql-server/src/connection/dump/exporter.rs)
legge schema e dati in una transazione coerente. Lo script rifiuta redirect,
host inattesi, errori HTTP, dimensioni oltre il limite e dump privi del COMMIT finale.
Se `/dump` non è disponibile sul database corrente, la procedura si arresta:
non sostituisce automaticamente l'export con letture non coerenti.

Download, hash e controlli iniziali/finali leggono il file a blocchi, senza
caricarlo interamente in una stringa JavaScript. Il ripristino locale usa
**Python 3 e la libreria standard sqlite3**, senza pacchetti aggiuntivi: legge
una sola istruzione SQL completa per volta, preservando transazione, trigger,
virgolette e testo su più righe. La memoria dipende dall'istruzione più grande,
non dalla dimensione totale del dump. Schema con estensioni specifiche libSQL
non supportate da SQLite causa un errore esplicito di verifica, senza fallback.
Questa dipendenza serve solo al backup offline; non riguarda l'inferenza A/C.
Il processo Python è isolato e non riceve credenziali Turso o del provider quote.

`preflight` legge schema, page size e page count. Non può verificare piano,
letture residue o trasferimento residuo dell'account: servono il pannello Turso
o la CLI di gestione già autenticata. Controllare questi dati **prima** di
passare `--quota-reviewed`. Questo flag attesta un controllo dell'operatore,
non è una prova automatica del piano gratuito. Il limite di download limita
lo spazio locale, non garantisce da solo l'assenza di consumo sul provider.

Il dump e il database ricostruito contengono dati privati, sessioni e storico.
Conservarli in una directory privata fuori Git, per esempio sotto
`backend/artifacts/backups/` già ignorata. Nessuna copia viene caricata su
servizi esterni. Su Windows verificare anche i permessi della directory:
i mode POSIX non sostituiscono le ACL di Windows.

## Comandi dalla directory backend

Caricare le credenziali già esistenti tramite l'ambiente privato. Con Node
che supporta `--env-file`, è possibile leggere il file locale senza copiarne
il contenuto nella shell o nella conversazione:

```powershell
node --env-file=../.env.production scripts/backup-turso.js preflight --expected-host <host-Turso-verificato>
```

Dopo aver verificato identità del DB, quota account e spazio locale sufficiente,
creare la directory padre privata `artifacts/backups`. La directory finale deve
essere nuova e non esistere ancora. Il limite seguente è soltanto un esempio:
sceglierlo in base alla dimensione effettiva e al margine disponibile. Il dump
SQL può essere più grande del database: 512 MiB non costituiscono un limite
sufficiente garantito per un database vicino a quella dimensione.

```powershell
node --env-file=../.env.production scripts/backup-turso.js backup --expected-host <host-Turso-verificato> --out artifacts/backups/<data-ora-univoca> --max-bytes 536870912 --quota-reviewed
```

Il risultato contiene `database.sql`, `restore.db` e `manifest.json`.
Il manifest conserva orari, host, SHA256, dimensione, conteggio di ogni tabella
nel dump ricostruito, integrity check e numero di violazioni delle chiavi esterne.
Il conteggio è riferito allo snapshot ripristinato; non viene presentato come
un conteggio remoto atomico distinto. `complete=true` richiede integrity `ok`
e zero violazioni FK. Un errore lascia eventuali file parziali a disposizione
dell'operatore: non considerarli backup verificati.

Per provare nuovamente il ripristino in un altro file locale nuovo:

```powershell
node scripts/backup-turso.js verify --dump artifacts/backups/<data-ora>/database.sql --database artifacts/backups/<data-ora>/second-restore.db
```

Lo script cerca `python` nel PATH. Per scegliere l'interprete locale usare
`--python C:/percorso/python.exe` oppure `BACKUP_PYTHON`; non sono richiesti
token o accessi remoti per `verify`.

Il codice di uscita è diverso da zero in caso di integrity check fallito o
violazioni FK. Il log non stampa righe del DB, SQL, credenziali o errori grezzi
dei driver. La copia di produzione rimane invariata.

## Prima di migrazioni e rollback

Conservare il riferimento privato al manifest e verificare che l'host coincida
con quello di backend, worker e Actions. Provare le migrazioni necessarie su
una copia del ripristino, confrontando schema e conteggi; non sul file archivio.
Un backup ripristinabile non autorizza a sovrascrivere la produzione: un restore
remoto con dati più vecchi richiede piano di riconciliazione e autorizzazione.
La schedulazione periodica del backup richiede storage privato, quota e retention
effettivamente verificati; questo script, da solo, non configura backup automatici.

Verifica locale della procedura: `node --test test/backup-turso.test.js`.
Le fixture sono sintetiche e non dimostrano l'esecuzione di un backup remoto.
