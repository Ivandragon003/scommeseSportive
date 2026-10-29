# Migrazione al Turso personale: preparazione e verifica

Il mandato del 29 ottobre richiede di trasferire FootPredictor dal database del
collaboratore a un database dell'account personale, conservando Hostless,
GitHub Actions, dati e due portafogli A/C. Questa guida descrive gli strumenti
preparati; non attesta un'importazione o un cutover remoto.

## Confini della migrazione

- Conservare il database originale e i backup precedenti. Non importare sopra
  un database con dati senza una verifica distinta delle conseguenze.
- Identificare account, organizzazione, piano gratuito, capacità disponibile e
  overage prima di creare/importare il nuovo database. I limiti pubblici del
  provider non sostituiscono i dati dell'account autenticato.
- Riutilizzare soltanto accessi autorizzati. Non recuperare secret write-only,
  stampare token o inserirli nel repository. La verifica offline non usa token.
- Il backup del mattino è uno snapshot storico: un nuovo dump deve includere
  migrazioni, registry, portafogli e altre scritture avvenute successivamente.
- Un'importazione iniziale resta una copia isolata. Non collegare la nightly al
  nuovo DB mentre il backend continua a scrivere sul vecchio.
- Prima del cutover definitivo e dell'attivazione remota delle nuove
  registrazioni virtuali serve la conferma esplicita dell'utente sul piano
  concreto e sui controlli superati.

Il flusso ufficiale di [migrazione/import SQLite](https://turso.tech/blog/migrating-and-importing-sqlite-to-turso-just-got-easier)
accetta un file SQLite. Se è richiesta la modalità WAL, predisporla su una copia
destinata all'upload, eseguire il checkpoint e chiudere la connessione; non
modificare il ripristino archivio verificato. Il normale flusso della dashboard
può evitare trasferimenti manuali di token. L'import non cambia le connessioni
dell'applicazione da solo.

## Due esportazioni coerenti, due ripristini nuovi

Usare la [procedura di backup esistente](turso-backup.md) prima sulla sorgente,
poi sul database personale importato, ciascuno in una directory privata nuova.
Per un backup SQL, ogni directory deve contenere `database.sql`, `restore.db` e `manifest.json`.
Prima del dump remoto controllare host, accessi, quote e costi; non passare
`--quota-reviewed` se la verifica non è stata effettuata.

I manifest devono attestare il dump ufficiale completo, il ripristino leggibile,
integrità `ok`, zero violazioni FK e SHA-256 del file ripristinato. Un archivio
parziale, un hash non coincidente o un file con journal non vuoto blocca la
comparazione.

È accettato anche il formato distinto `turso-sqlite-snapshot-v1`, metodo
`official_CLI_db_export`: la [CLI ufficiale v1.0.34](https://github.com/tursodatabase/turso-cli/blob/v1.0.34/internal/cmd/db_export.go)
esporta un file SQLite e, quando
presente, il WAL mediante `db export --output-file`, senza dati in stdout.
Non viene dichiarato come GET `/dump`. Il layout di archivio supportato è
`export/database.db` e l'eventuale `export/database.db-wal`, mantenuti intatti;
`restore.db` deve essere una nuova copia locale sottoposta a checkpoint.
Il manifest registra motore libSQL, comando/versione CLI, completamento,
dimensioni e SHA-256 dei file originali, checksum del descrittore e verifica
del ripristino. Il verificatore controlla gli archivi prima e dopo il confronto,
rifiuta percorsi esterni, motori/formati diversi e metadata incompleti.
I precedenti controlli del dump SQL restano invariati.

## Verifica offline della parità

Dalla directory `backend`:

```powershell
node scripts/verify-turso-migration.js `
  --source-manifest artifacts/backups/<sorgente>/manifest.json `
  --target-manifest artifacts/backups/<personale>/manifest.json `
  --expected-source-host <host-sorgente>.turso.io `
  --expected-target-host <host-personale>.turso.io
```

Entrambi gli host sono obbligatori, distinti e devono corrispondere esattamente
ai manifest. Non si accettano URL con token. I due `restore.db` sono risolti nelle
rispettive directory dei manifest. Il wrapper verifica gli hash prima e dopo
la lettura e passa al processo Python soltanto un ambiente minimo, senza
credenziali del database o dei provider. Python 3 standard è sufficiente;
`--python` o `BACKUP_PYTHON` selezionano l'interprete già autorizzato.

Il [verificatore](../../backend/scripts/verify-turso-migration.js) usa il
[lettore SQLite offline](../../backend/scripts/verify-turso-migration.py) con
`mode=ro&immutable=1` e controlla:

- integrità SQLite e vincoli FK di entrambi i ripristini;
- schema SQL di tabelle, indici espliciti, trigger e viste, preservando default,
  vincoli e letterali; sono normalizzati soltanto i terminatori CRLF;
- conteggio e checksum SHA-256 di ogni tabella applicativa;
- `sqlite_sequence`, quando presente, per conservare i contatori AUTOINCREMENT;
- corrispondenza fra conteggi effettivi e manifest e immutabilità dei ripristini.

I checksum distinguono NULL, interi a 64 bit, REAL, UTF-8 e BLOB e conservano
la molteplicità delle righe duplicate. Non dipendono dall'ordine di inserimento
o dai rowid fisici. Il lettore elabora una riga alla volta e ordina checksum a
blocchi di 4.096 righe; le fusioni aprono al massimo 32 blocchi. I file temporanei
contengono soltanto checksum e sono rimossi al termine. La memoria dipende dal
blocco e dalla riga più grande, non dalla dimensione complessiva del DB.

Gli oggetti SQLite interni `sqlite_*` sono esclusi, salvo `sqlite_sequence`;
statistiche dell'ottimizzatore e dettagli fisici non sono una parità di dati
applicativi. Una differenza nello schema SQL non è dichiarata equivalente
automaticamente: richiede analisi. L'output riporta nomi tabelle, conteggi e hash,
mai righe, SQL, sessioni o credenziali. Conservarlo comunque fra gli artifact
privati della migrazione.

`snapshotParity=true` e codice di uscita `0` attestano **soltanto la parità dei
due snapshot esportati**. `liveParityVerified` resta sempre `false`: scritture
successive sul database sorgente non sono coperte. Se il confronto fallisce il
processo termina con codice diverso da zero; non corregge o riscrive dati.

## Cutover da presentare all'utente

### Collaudo additivo sullo snapshot reale

Il 29 ottobre le migrazioni `020_research_nightly.sql` e
`021_research_prospective.sql` sono state collaudate su una nuova copia locale
del ripristino sorgente delle 15:18:10 UTC. È stata usata l'immagine finale
`footpredictor-nightly-backend:acceptance`, ID
`sha256:a36eaf7244778a9fc17e2509fad3c17f987ff342b07c09a69030acb862474ab1`,
con rete disabilitata, 1 CPU e 512 MiB. Il normale costruttore di
`DatabaseService` ha eseguito `initialize`, verificato tramite `execute`:
nessun avvio del server web, provider o esecuzione alternativa dei file SQL.
La connessione era soltanto `file:` con un token fittizio non valido per Turso.

Il controllo completo dei dati reali ha conservato le 52 tabelle applicative
originarie, con la sola eccezione prevista delle due append a
`schema_migrations` (20 → 22 righe): tutte le righe precedenti, comprese
sessioni, modelli, giocate, portafogli e registri contabili, mantengono conteggi
e checksum. I 125 oggetti di schema ispezionati prima del collaudo restano
invariati. Le due migrazioni aggiungono **cinque tabelle vuote** e tre indici,
portando gli oggetti ispezionati a 133. Integrità `ok`, zero violazioni FK.

Un secondo avvio in un processo Docker nuovo ha confermato l'idempotenza:
stessi dati, schema e registro migrazioni dopo il primo avvio. Il ripristino
originale non è stato montato nel container e il suo SHA-256 prima/dopo è
invariato. Le prove private sono in
`backend/artifacts/backups/personal-migration-20261029/local-additive-rehearsal-20261029T171058Z/rehearsal-report.json`.
Il collaudo riguarda la copia locale; migrazioni remote e cutover restano
passaggi separati da approvare sul piano concreto.

### Passaggio coordinato delle connessioni

Preparare una lista esplicita di tutti i writer/reader: backend Hostless,
nightly, training, calibrazione e manutenzione/monitoraggio residui. Verificare
prima che Hostless possa applicare la configurazione prevista: una coda di
deployment bloccata non autorizza uno switch parziale.

Dopo la conferma sul piano concreto: sospendere le scritture in modo controllato,
attendere i job in corso, eseguire dump e sincronizzazione finali, ripetere
parità/integrità, aggiornare insieme URL e secret, verificare ogni connessione e
solo allora riattivare le operazioni. Il rollback deve conservare i dati nuovi:
non sovrascrivere la produzione con uno snapshot vecchio senza riconciliazione.
Il DB originale rimane disponibile e non viene eliminato.

Le metriche ufficiali di letture, scritture, storage e limiti vanno consultate
nel nuovo account Turso; non vengono trasferite dal vecchio account insieme ai
dati. I contatori applicativi e le stime mensili devono mantenere questa
distinzione.

## Verifiche locali eseguite

[Test isolati](../../backend/test/turso-migration-verification.test.js): parità
con inserimenti in ordine diverso, tipi numerici/NULL/Unicode/BLOB, duplicati,
trigger, indici, vincoli e AUTOINCREMENT; rilevamento di variazioni di valore,
tipo, molteplicità, indice, sequenza, hash e manifest; rifiuto di journal pendenti
e di host inattesi; assenza di dati privati negli errori. Una fixture di 140.003
righe senza chiave verifica anche la fusione dei blocchi mantenendo i ripristini
immutati. Queste prove non attestano un trasferimento remoto.

```powershell
node --test test/turso-migration-verification.test.js
```
