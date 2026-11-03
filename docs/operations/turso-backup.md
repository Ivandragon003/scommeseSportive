# Backup Turso e verifica del ripristino

[backup-turso.js](../../backend/scripts/backup-turso.js) legge il DB remoto
senza avviare l'applicazione o applicare migrazioni. Il restore crea soltanto
un **nuovo file locale**: lo script non ripristina dati in produzione e
non configura backup automatici.

## Prerequisiti e limiti

Occorrono Node con dipendenze backend installate e Python 3 con la libreria
standard `sqlite3` per la verifica offline. Il download usa HTTPS `/dump`,
token nell'header Authorization, host atteso esplicito e nessun redirect.
Controlla limite di dimensione ed envelope della transazione con COMMIT
finale; se l'export non è disponibile si arresta, senza fallback a letture
indipendenti delle tabelle.

Il ripristino usa [restore-turso-backup.py](../../backend/scripts/restore-turso-backup.py)
per leggere una sola istruzione completa alla volta e verificare integrità,
chiavi esterne e conteggi. Estensioni libSQL incompatibili con SQLite causano
un errore esplicito. Python non riceve credenziali DB o provider quote.

`preflight` legge schema, page size e page count. Non conosce piano,
consumi residui o trasferimento dell'account: controllarli nel pannello o
nella CLI di gestione già autenticata, prima di `--quota-reviewed`.
Il flag dichiara il controllo dell'operatore; non prova automaticamente la
gratuità. Il limite di download protegge lo spazio locale, non evita il
consumo del provider.

Dump, database e manifest contengono dati privati, sessioni e storico.
Conservarli fuori Git in una directory privata, per esempio
`backend/artifacts/backups/` già ignorata. Verificare anche le ACL Windows:
i mode POSIX non proteggono da soli una directory Windows. Non caricare
backup su servizi esterni senza un mandato specifico.

## Comandi

Da `backend`, caricare le credenziali autorizzate nell'ambiente privato.
Il file locale canonico è `.env` nella root; non serve una copia
`.env.production`. Con Node che supporta `--env-file`:

```powershell
node --env-file=../.env scripts/backup-turso.js preflight --expected-host <host-Turso-verificato>
```

Verificare host canonico, quota account e spazio libero. Creare la directory
padre privata `artifacts/backups`; la directory finale deve essere nuova.
Scegliere il limite effettivo considerando che un dump SQL può superare le
dimensioni del DB. Il valore seguente è solo un esempio di 512 MiB:

```powershell
node --env-file=../.env scripts/backup-turso.js backup --expected-host <host-Turso-verificato> --out artifacts/backups/<nome-univoco> --max-bytes 536870912 --quota-reviewed
```

Produce `database.sql`, `restore.db` e `manifest.json`. Il manifest contiene
orari, host, hash SHA-256, dimensione e verifica del DB locale ricostruito.
`complete=true` richiede integrity `ok` e zero violazioni FK; i conteggi
appartengono allo snapshot ripristinato. File parziali o `complete=false`
non sono backup verificati.

Per ripetere il restore in un altro file locale nuovo:

```powershell
node scripts/backup-turso.js verify --dump artifacts/backups/<nome>/database.sql --database artifacts/backups/<nome>/second-restore.db
```

Per scegliere Python usare `--python C:/percorso/python.exe` oppure
`BACKUP_PYTHON`; `verify` non richiede accessi remoti. Il codice di uscita è
diverso da zero se integrità o FK falliscono. Gli errori non stampano SQL,
righe DB, token o messaggi grezzi dei driver.

## Migrazioni e rollback

Prima di intervenire sul DB verificare che web, Nightly e altri processi
puntino allo stesso canonico e conservare il manifest privato. Provare
migrazioni e confronti su una **copia** del ripristino, preservando l'archivio.
Un restore remoto richiede un piano esplicito di riconciliazione: dati più
vecchi possono perdere giocate, liquidazioni, sessioni e aggiornamenti.
Un backup verificato non autorizza a sovrascrivere o cancellare produzione.

Una schedulazione periodica richiede storage privato, quota, frequenza e
retention definiti e verificati: non deriva dalla presenza dello script.
Il test locale ripetibile è `node --test test/backup-turso.test.js` da backend;
usa fixture sintetiche e non dimostra un backup remoto eseguito.
