# Migrazione al Turso personale: adozione e verifica

Il mandato del 29 ottobre richiede di trasferire FootPredictor dal database del
collaboratore a un database dell'account personale, conservando Hostless,
GitHub Actions, dati e due portafogli A/C. Il database personale esistente è
stato adottato come punto di verità con una scelta esplicita del punto di
ripristino. Le verifiche e i limiti effettivi sono descritti qui sotto.

## Stato verificato del 29 ottobre

Il database operativo è `footpredictor` dell'account personale `selloneciompi`,
gruppo `default`, SQLite/libSQL, regione `aws-eu-west-1` (Irlanda). L'ID
`01a1888a-2901-7dd6-8c05-a39cbf83c815` è rimasto invariato: la copia non è
stata eliminata o ricreata durante l'adozione.

L'utente ha scelto come baseline il dump acquisito tra **15:17:22 e 15:18:10
UTC**, ossia **16:17–16:18 Europe/Rome**. Questo è il punto di ripristino
accettato (RPO). Il successivo blocco della sorgente (`BLOCKED` sulle letture,
HTTP 403 sul GET `/dump`) ha impedito un nuovo backup finale della sorgente.
Eventuali delta dopo quel punto non sono verificati: **non si dichiara parità
con il database attuale del collaboratore**. Gli export successivi della
copia personale non rendono più recente il contenuto sorgente copiato.

Sulla copia esistente sono state applicate solo le additive
`020_research_nightly.sql` e `021_research_prospective.sql`. La verifica
integrale del backup finale ha conservato i dati delle **52 tabelle
applicative originarie**, con la sola append delle due versioni nel registro
`schema_migrations` (20 → 22). Al checkpoint di adozione le cinque tabelle
nuove risultavano vuote; con tre indici aggiuntivi gli oggetti di schema
ispezionati passano da 125 a 133.
Il database adottato contiene quindi **57 tabelle applicative**. Integrità
`ok`, zero violazioni FK, sequenze e tutti gli altri checksum originari
invariati rispetto alla baseline accettata.

L'unico export nativo finale dopo le migrazioni è terminato alle
**18:58:45 UTC**: snapshot di 525.860.864 byte e WAL di 168.952 byte,
conservati entrambi intatti. Il ripristino è stato effettuato su un nuovo clone
locale; confronto completo superato alle 19:00:59 UTC. Il WAL contiene parte
dello stato finale e non va separato dallo snapshot archiviato. Le prove
private sono sotto
`backend/artifacts/backups/personal-migration-20261029/target-cli-export-20261029T185811Z/`:
`manifest.json` e `canonical-adoption-parity.json`. Non sono file da pubblicare
nel repository.

### Collegamenti e credenziali effettivi

Il nuovo deployment Hostless `6ae39db2025871fe6d073d62`, revisione
`63d7cb96`, è LIVE. Backend e GitHub sono stati collegati al database personale;
anche `.env.production` locale è stato aggiornato, con la vecchia
configurazione archiviata privatamente. Sono stati verificati health HTTP 200,
vecchia route `place-valid-bets` HTTP 410, dashboard autenticata e confronto
di 30 giorni. A e C mostrano ciascuno 1.000 euro, zero impegnati e zero giocate
shadow: i due portafogli restano indipendenti.

Sono state create tre credenziali distinte, limitate al **solo database**:

| Uso | Permessi | Scadenza UTC |
| --- | --- | --- |
| Backend Hostless | Lettura/scrittura | 5 marzo 2030, 18:54:52 |
| GitHub manutenzione/Nightly | Lettura/scrittura | 5 marzo 2030, 18:54:55 |
| Watchdog e probe manuale | Sola lettura | 5 marzo 2030, 18:54:59 |

Non sono token di gruppo e non consentono attach ad altri database. I valori
restano esclusivamente nei file privati protetti e nei secret dei servizi;
non sono presenti nel frontend o in questa guida. La chiave RO è stata
verificata realmente con SELECT riuscita e operazione senza righe (`WHERE 0`)
rifiutata dal server. Non è stato necessario alterare dati per questa prova.
Le scadenze finite richiedono rinnovo prima del marzo 2030.

La preparazione cache GitHub `40937894463` e il nuovo smoke RO `40945351072`
sono terminati con successo. Il monitor aggiornato `4dff28f4` è pubblicato,
con CI `40944506327` SUCCESS, dieci test mirati e revisione DST superati.
La nightly è attiva: il run `40944747548`, creato alle 19:57:46 UTC su
`4dff28f4`, è SUCCESS, job concluso alle 20:04:35 UTC. Il passo A/C è durato
dalle 20:04:20.587 alle 20:04:28.263 UTC, con finestra fino alle 02:00 UTC del
30 ottobre: zero analizzati, nuove puntate, skip ed errori; settlement 0/0/0,
quota `null` e nessuna nuova evidenza prospettica. Audit RO 20:10:52 UTC:
`missedMatches=2` conta due partite già iniziate, `understat_31643`
Frosinone–Lecce 17:30 UTC e `understat_31642` Fiorentina–Atalanta 19:45 UTC,
nell'intervallo 02:00→20:04:20 UTC. Per queste due partite nessun job o decisione di modello creato.
Il motivo `missed_nightly_interval=1` conta una segnalazione di intervallo,
non una partita.
Nessun evento eleggibile nella finestra restante, nessuna puntata retroattiva.
Il precedente evento `40940944902` resta orfano con metadata `queued`, zero
job e fuori dal gruppo anche dopo il successo del nuovo run.

Audit RO reale delle 20:07 UTC PASS: quattro fingerprint finanziari invariati;
A/C 100.000 centesimi ciascuno, zero impegnati e zero puntate. Restano preservati
258 record legacy, 197.314 previsioni, 8.834 partite e 10.915 snapshot quote.
Il run persistito è `COMPLETED`; la dashboard conferma Nightly riuscita alle
21:04 Roma e prossima esecuzione il 30 ottobre alle 03:00 Roma.

Monitor GitHub, controllo DB periodico RO e attese delle 03:00 sono attivi,
con opt-in separato dal flag delle puntate. `RESEARCH_NIGHTLY_MONITOR_ENABLED`
e `RESEARCH_NIGHTLY_DB_MONITOR_ENABLED` sono entrambi `true`. Il watchdog con
attese attive `40946558140` è SUCCESS: tutti i passi GitHub e DB RO completati
in 26 secondi. Stalli recenti oltre quattro ore, contabilità, quota ed errori
non dipendono dall'aspettativa programmata. Il ciclo completo con partita
reale, eventuale giocata, risultato e liquidazione resta ancora da osservare.

La sorgente originale è stata ritirata dai collegamenti operativi, **non
eliminata**. Il nostro accesso management Turso riguarda solo il personale.
La dismissione della sorgente richiede il proprietario; SQL distruttivo non
sostituisce l'eliminazione del database tramite management. Il vecchio
controller di eliminazione della copia inutilizzata è stato ritirato e
rifiuta il database ora canonico.

### Piano e contatori osservati

Lettura unica della CLI ufficiale alle **19:33:57 UTC**: organizzazione
personale, piano `starter`, **Overages disabled**. Nessun cambio piano è stato
effettuato. Questi sono contatori datati dell'account, non stime del carico
futuro:

| Risorsa | Utilizzo osservato | Limite |
| --- | --- | --- |
| Storage | 526 MB | 5,0 GB |
| Righe lette | 0,1 milioni | 500 milioni |
| Righe scritte | meno di 0,1 milioni | 10 milioni |
| Embedded sync | 1,6 GB (52%) | 3,0 GB |
| Database | 1 | 100 |
| Locations | 2 | 3 |

Il reset indicato è il 1 novembre 2026 alle 00:00 UTC. Controllare nuovamente
la quota prima di ulteriori export; un backup nativo di circa 526 MB consuma
una parte significativa del budget sync. Le quote del vecchio account non
sono deducibili da questi contatori personali.

## Confini della migrazione

- Conservare il database originale e i backup precedenti. Non importare sopra
  un database con dati senza una verifica distinta delle conseguenze.
- Identificare account, organizzazione, piano gratuito, capacità disponibile e
  overage prima di creare/importare il nuovo database. I limiti pubblici del
  provider non sostituiscono i dati dell'account autenticato.
- Riutilizzare soltanto accessi autorizzati. Non recuperare secret write-only,
  stampare token o inserirli nel repository. La verifica offline non usa token.
- Il backup del mattino è uno snapshot storico distinto da quello adottato.
  Senza una scelta esplicita del RPO, un nuovo dump deve includere migrazioni,
  registry, portafogli e altre scritture avvenute successivamente.
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

## Procedura per successivi cambi di database

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
Quel collaudo riguardava la copia locale e non attestava un rilascio remoto.
L'applicazione remota e l'adozione successive sono descritte nello stato
verificato all'inizio di questa guida.

### Passaggio coordinato delle connessioni

Preparare una lista esplicita di tutti i writer/reader: backend Hostless,
nightly, training, calibrazione e manutenzione/monitoraggio residui. Verificare
prima che Hostless possa applicare la configurazione prevista: una coda di
deployment bloccata non autorizza uno switch parziale.

Dopo la conferma sul piano concreto: sospendere le scritture in modo controllato,
attendere i job in corso, eseguire dump e sincronizzazione finali, ripetere
parità/integrità, aggiornare insieme URL e secret, verificare ogni connessione e
solo allora riattivare le operazioni. Se la sorgente è bloccata, l'adozione di
un punto precedente richiede la scelta esplicita e documentata del RPO, come
nel caso sopra: non è un fallback automatico. Il rollback deve conservare i
dati nuovi: non sovrascrivere la produzione con uno snapshot vecchio e non
tornare automaticamente alla sorgente bloccata. Per una regressione del
codice mantenere il database personale, sospendendo prima i writer.

Se la sorgente torna leggibile, confrontare in isolamento baseline iniziale,
sorgente recuperata e personale aggiornato. Riconciliare gli eventi per chiave
e provenienza, senza sommare saldi o duplicare finanziamenti/liquidazioni. Le
cache derivate possono essere ricostruite. Conservare la sorgente e i backup
finché i conflitti materiali non siano risolti.

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
