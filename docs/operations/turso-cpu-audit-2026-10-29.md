# Audit locale Turso e CPU — 29 ottobre 2026

## Perimetro e metodo

Misure offline sul backup privato verificato del 29 ottobre, completato alle
10:27:57 UTC, precedente alle nuove tabelle research applicate in produzione.
Il file `restore.db` è stato aperto esclusivamente con SQLite
`mode=ro&immutable=1`. SHA256 iniziale e finale:
`2f8ba4bfe25e919eaa5ee0adad8bf9e05caf3246a10a5ade25c44554b24a15fe`.
Le prove di scrittura copiano soltanto la tabella partite in un DB in memoria;
non modificano il backup originale. Nessuna connessione remota, chiamata quote,
migrazione, operazione Hostless o modifica matematica dei modelli.

Lo snapshot contiene 8.834 partite, 10.915 snapshot quote, 183.913 previsioni e
128 profili di calibrazione. Le dimensioni riportate sono byte di JSON locale,
non traffico effettivamente fatturato da Turso. Tempi e contatori SQLite locali
non certificano consumi o prestazioni del servizio remoto.

Risultati, query catturate e script ripetibili restano nella directory privata
ignorata `backend/artifacts/turso-cpu-audit-20261029/`. I report versionati non
contengono righe private, sessioni, credenziali o payload sportivi completi.

## Modifiche misurate

### Quote storiche usate da calibrazione e backtest

`getHistoricalOddsDetailMap` legge soltanto la selezione reale e la provenienza
necessarie. Prima trasferiva e decodificava anche tutti i bookmaker, fallback,
completamenti sintetici e diagnostica non utilizzati dal risultato.

| Misura | Prima | Dopo |
| --- | ---: | ---: |
| Righe restituite | 4.061 | 4.061 |
| JSON serializzato | 21.003.357 byte | 7.101.664 byte |
| Query SQLite, mediana di 5 letture | 113,77 ms | 62,01 ms |
| Istruzioni VM SQLite indicative | circa 300.000 | circa 183.000 |
| Selezione e parsing Node, mediana di 5 prove dopo riscaldamento | 126,17 ms | 45,90 ms |
| CPU Node della stessa prova, mediana | 141 ms | 62 ms |

Il JSON trasferito nel campione diminuisce del 66,2%. I 297 risultati finali
sono profondamente identici, incluse quota di ingresso/chiusura, bookmaker,
timestamp e motivi di esclusione. I test coprono anche snapshot successivi al
calcio d'inizio, provenienze sintetiche e supplementi Eurobet storici.

Il piano rimane una scansione dell'indice snapshot con ricerca della partita
per chiave e ordinamento temporaneo. **Non diminuiscono le righe percorse né
il numero di query**: il beneficio dimostrato riguarda dati trasferiti, parsing
e CPU locale. Non è una prova di minori righe lette fatturate da Turso.

### Import di partite identiche

L'upsert conserva gli stessi campi e la semantica `COALESCE`: un valore nullo
in ingresso non cancella un dato già disponibile. Una condizione SQL evita
l'UPDATE quando tutti i valori non nulli sono già uguali, senza letture
preventive aggiuntive e senza nuovi indici.

Replay di tutte le 8.834 partite del backup, ripetuto tre volte:

| Misura | Prima | Dopo |
| --- | ---: | ---: |
| Operazioni inviate per replay | 8.834 | 8.834 |
| Righe modificate SQLite per replay | 8.834 | 0 |
| Mediana locale, preparazione parametri esclusa | 153,61 ms | 156,70 ms |

Il contenuto completo della tabella rimane identico prima/dopo, inclusi campi
non interessati dall'upsert. Il campione non dimostra una riduzione CPU per
questo percorso: dimostra l'eliminazione degli UPDATE inutili. Le richieste
batch e le ricerche per chiave restano necessarie. Il contatore pubblico
`committedCount` continua a indicare gli elementi elaborati, anche invariati.
Il dump non contiene trigger su `matches`; non sono stati rimossi trigger o
modificati vincoli. I test verificano separatamente tutti i campi modificabili,
valori zero, nulli, JSON e gestione dei batch.

## Altre query controllate

| Percorso | Piano osservato | Esito locale |
| --- | --- | --- |
| Partite future in finestra | indice parziale `idx_matches_upcoming_date`, intervallo data | 2 righe, circa 0,04 ms |
| Storico Serie A per calibrazione | indice competizione e ordinamento temporaneo | 1.900 righe, circa 58 ms |
| Riepiloghi delle cinque leghe | indice competizione, aggregazione richiesta | 5 righe, circa 33 ms |
| Profilo persistente di calibrazione per chiave | indice primario cache | lookup senza scansione completa, circa 0,006 ms nel caso chiave assente |
| Conteggi archivio previsioni | scansione `predictions` e raggruppamento temporaneo | 183.913 righe aggregate, circa 189 ms, 13 risultati |

I conteggi globali delle previsioni richiedono ancora l'aggregazione dell'intero
archivio. Non è stato introdotto un indice aggiuntivo o un riepilogo persistente
senza una misura della frequenza reale e del relativo costo sulle scritture.
Le letture partite già escludono `raw_json` per impostazione predefinita; nel
backup questi payload occupano complessivamente 289.179.066 byte. Non sono
stati cancellati o trasformati.

## Calibrazione e avvisi CPU Hostless

Il benchmark esistente `node benchmarks/calibration-cache.js`, eseguito sul
build locale, usa 1.900 partite sintetiche e i modelli effettivi:

| Percorso | Tempo locale | CPU osservata | Fit storici |
| --- | ---: | ---: | ---: |
| Calcolo completo a cache fredda | 4.944 ms | 5.484 ms | 45 |
| Cache nello stesso processo | inferiore alla risoluzione riportata | 0 ms riportati | 0 |
| Profilo persistente in un nuovo servizio | 9 ms | 0 ms riportati | 0 |

I profili ottenuti sono identici. Lo zero riportato dal contatore CPU non
significa assenza di istruzioni. Questa è una dimostrazione locale della
differenza tra ricalcolo e riuso, non una nuova ottimizzazione matematica.
La calibrazione persistente richiede comunque il caricamento degli input per
verificarne l'impronta; la cache in memoria evita ulteriori letture durante la
sua validità. Errori di checksum/configurazione restano cache miss, senza
fallback probabilistici silenziosi.

L'impronta della calibrazione include il codice compilato del backend:
anche modifiche di persistenza invalidano prudentemente i profili. La
preparazione della calibrazione deve quindi usare il build definitivo prima
di pretendere che il web trovi la cache già pronta. Non è stato cambiato
questo contratto per riutilizzare profili senza verificarne la compatibilità.

Le email Hostless del 29 ottobre attestano episodi di throttling del backend
e recuperi successivi; da sole non attribuiscono la causa a CatBoost o SQL.
Il benchmark esclude latenza Turso, HTTP e limiti CPU Hostless. Il timeout in
coda del deployment è un fenomeno distinto, precedente all'esecuzione del
processo. Non viene dichiarato risolto né quello né il throttling remoto.

## Verifica ripetibile

Dalla directory `backend`, dopo compilazione coordinata:

```powershell
npx tsc --project tsconfig.json
node --test --test-concurrency=1 test/database-io-optimization.test.js test/performance-optimization.test.js test/team-averages-batch.test.js test/historical-odds-temporal.test.js test/calibration-deployment.test.js
npx eslint src/db/DatabaseService.ts test/database-io-optimization.test.js --max-warnings=0
node benchmarks/calibration-cache.js
```

Esito di questa verifica: **31/31 test**, compilazione e lint mirati superati;
`git diff --check` senza errori whitespace. La prima fixture di test usava NULL
anche su colonne obbligatorie e ha correttamente ricevuto un vincolo NOT NULL:
la fixture è stata corretta senza allentare i vincoli applicativi.
La suite completa rimane un controllo separato dell'integrazione finale.

Per ripetere le misure sullo stesso backup, dalla radice del progetto e con
i file privati conservati:

```powershell
python backend/artifacts/turso-cpu-audit-20261029/audit-local.py
node --expose-gc backend/artifacts/turso-cpu-audit-20261029/historical-odds-cpu.js
```

Nessuna cancellazione di storico, nuova dipendenza o indice introdotto.
Il parsing completo degli snapshot resta disponibile agli altri endpoint che
ne consumano i dettagli; non è codice diventato inutilizzato.

## Proiezione quote della nuova nightly

`forecastRemainingNightlyOddsDemand` aggiunge una stima separata dai simulatori
T−15 storici, che restano invariati per ripetere i benchmark precedenti. Raggruppa
una richiesta per lega con incontri nella finestra tra due nightly future delle
03:00 Europe/Rome; A e C condividono lo snapshot. Lo slot di richiesta determina
il mese contabile UTC, anche quando un incontro cade nel mese UTC successivo.
I passaggi di ora legale producono finestre reali di 23 o 25 ore. Orari e durata
personalizzati sono parametri espliciti, senza importare i modelli per stimare
il calendario.

Con tre mercati e una regione, il controfattuale di tutte le cinque leghe ogni
giorno di un mese di 31 giorni richiede 155 richieste, **465 crediti**, lasciandone
35 prima dei retry. Conservare integralmente 50 crediti di riserva ammetterebbe
soltanto 450 crediti, quindi non tutti quei gruppi. La semantica del manager
resta invariata: la riserva protegge le richieste informative; la nightly
essenziale può usarla, sempre entro il massimo mensile di 500.

Una riserva di pianificazione di un retry per il 10% dei gruppi, arrotondato
per eccesso, porta il controfattuale a 171 richieste e **513 crediti**: la
simulazione mostra gruppi saltati per il limite, senza aumentare il budget.
I costi effettivi rimangono quelli misurati dal provider e dal manager atomico.

La previsione usa soltanto i calendari osservati e gli slot programmati ancora
futuri: non riaddebita una nightly trascorsa e non propone recuperi retroattivi.
Leghe senza incontri, identità duplicate, conflitti, rinvii e orari ignoti sono
gestiti esplicitamente. Disponibilità conservative fornite dal manager possono
limitare ulteriormente gli scenari. Copertura completa, presenza delle quote,
bookmaker e freschezza restano **non verificati** dalla stima. Finestre
personalizzate sovrapposte possono sovrastimare richieste già evitate dalle
decisioni persistenti: il forecast non legge quel registro.

Verifica mirata: `test/nightly-odds-demand.test.js` insieme a
`test/odds-demand-simulation.test.js`; compilazione isolata del modulo senza
pulire `dist`, vecchie simulazioni preservate e nessuna chiamata provider/DB.
