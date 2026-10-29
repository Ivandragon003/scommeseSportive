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

## Baseline Hostless osservata prima della nuova release

Il pannello del backend `scommese-sportive-backend` mostra `Free / Running`.
Nella finestra del 29 ottobre 2026, 10:59–16:59 Europe/Rome, il riepilogo
ufficiale riporta 160 richieste, un errore server, 2,6 MiB trasferiti e un tempo
medio di risposta di 1.684,3 ms. L'ultimo campione di memoria visualizzato è
122,141 MiB alle 16:55.

La serie CPU visualizzata contiene soltanto 11 campioni e termina alle 11:45,
con valore 0 vCPU, mentre la memoria prosegue fino alle 16:55. Questo campione
vecchio non descrive il consumo CPU attuale, non dimostra assenza di throttling
e non identifica la causa degli avvisi precedenti. Non è disponibile una misura
remota confrontabile prima/dopo della nuova release, ancora non distribuita.
I risultati locali sopra riportati restano separati dalle metriche ufficiali.

## Dashboard ricerca: letture di metadati dopo il primo rilascio

Il monitor Hostless ha rilevato nuovamente throttling del backend il 29 ottobre
alle 17:55:33 UTC (18:55:33 Europe/Rome), sulla finestra 17:45:33–17:55:33 UTC:
11 campioni, picco 47,04%, ultimo campione 41%, limite 0,1 CPU e 256 MiB.
Nei log `GET /research/overview` ha richiesto 11.849 ms alle 17:53:03 UTC.
Queste osservazioni attestano il problema remoto; non ne isolano la causa.

L'audit del percorso GET ha individuato due letture complete evitabili:
`getModels()` caricava gli artefatti A/C per mostrarne soltanto metadati e
metriche; `listBenchmarks({ limit: 1 })` caricava l'intero ultimo report per
mostrarne soltanto data e warning di validazione. Il mapper conservava sia la
stringa JSON sia l'oggetto completamente decodificato. Nessuna inferenza C,
nuova calibrazione o valutazione del test finale avviene in questo endpoint.
I controlli dei trigger sono memorizzati per processo: possono contribuire al
primo accesso, ma non sono DDL ripetuto a ogni richiesta.

Le nuove letture `getOverviewModels()` e `getLatestValidationSummary()`
proiettano in SQL soltanto i campi consumati dalla dashboard. Il DTO, l'ordine
dei modelli e la scelta dell'ultima validazione restano identici, incluso lo
spareggio con `rowid`. Chiavi assenti, `null`, metriche scalari e documenti JSON
corrotti mantengono il comportamento precedente. I reader completi rimangono
disponibili al runtime e al lifecycle. Gli adapter parziali che non espongono
i nuovi metodi conservano il percorso precedente; un errore del nuovo reader
non attiva un fallback silenzioso. Il report PAIR completo resta necessario
per il confronto già esposto: non è stato ridotto o reinterpretato.

Le query effettive sono state misurate sul backup privato verificato delle
15:17:22 UTC, aperto con SQLite `mode=ro&immutable=1`. Mediane di cinque letture
successive alla prima, sul PC locale:

| Lettura | Byte dei valori prima | Dopo | Tempo SQLite prima → dopo |
| --- | ---: | ---: | ---: |
| Modelli A/C | 4.702.387 | 5.229 | 20,18 → 11,26 ms |
| Ultima validazione | 4.401.358 | 254 | 15,32 → 12,21 ms |
| Totale | 9.103.745 | 5.483 | — |

La riduzione dei valori restituiti è **99,9398%**; non rappresenta una riduzione
delle righe percorse o fatturate da Turso. Il JSON viene ancora esaminato dal
database per estrarre i metadati. Sullo stesso dump risultano due modelli, un
report C, nessun report PAIR, zero puntate/job/decisioni e due movimenti iniziali
del ledger: le aggregazioni contabili hanno quindi un carico minimo in questo
snapshot. L'impronta SHA-256 del backup è rimasta invariata:
`883d673eec9c864582e495c8f8dc1eaa24d0e1c0f9befcc092847ce7344390d7`.

La decodifica completa in Node dei record già memorizzati, senza rete, richiedeva
circa 41 ms reali e 47 ms CPU mediani. Non spiega da sola gli 11,849 secondi
remoti: trasferimento libSQL, decodifica del protocollo, attese, concorrenza e
throttling non sono stati separati sul runtime Hostless. Il miglioramento remoto
e la risoluzione dell'incidente restano da verificare dopo il rilascio di questo
intervento, mantenendo gli stessi limiti gratuiti.

Controlli mirati, dalla directory `backend`:

```powershell
npx tsc --project tsconfig.json
npm run typecheck
npx eslint src/research/ResearchStore.ts src/research/ResearchOverview.ts test/research-overview-metadata.test.js --max-warnings=0
node --test --test-concurrency=1 test/research-overview-metadata.test.js test/research-overview.test.js test/research-lifecycle.test.js
node --test --test-concurrency=1 test/research-store.test.js
```

Esito: compilazione senza pulire `dist`, typecheck, lint e **57/57 test**
superati. I sette nuovi test confrontano integralmente il DTO vecchio/nuovo,
vietano le due letture complete sostituite e conservano i reader del lifecycle.
Le fixture sono isolate in memoria; non sono un nuovo benchmark predittivo.
Nessuna chiamata provider, modifica del database remoto, nuova dipendenza,
cache persistente o indice è stata introdotta. La suite completa e il collaudo
remoto restano gate separati di pubblicazione.

## Letture Turso: indice del batch lineup, verifica del 30 ottobre

L'Analytics ufficiale Turso consultato nella notte tra il 29 e il 30 ottobre
ha individuato un costo diverso dai payload della dashboard: la pulizia dei
contenitori lineup orfani in `FootballDataService.ts` risultava eseguita tre
volte, con circa 36,85 milioni di righe lette per esecuzione e zero scritture.
Il totale approssimato di 110,55 milioni spiega circa il 98,5% delle
112.234.122 letture mostrate in quel riepilogo. Non viene attribuito questo
consumo ai modelli o ai benchmark. Il periodo e il residuo del piano vanno
letti nel pannello ufficiale; questi valori non sono una proiezione mensile.

La query cerca batch senza riferimenti né in `player_lineup_snapshots` né in
`player_injury_refresh_batches`. L'indice snapshot esistente cominciava con
`match_id, team_id, is_official`: non permetteva una ricerca puntuale sulla
sola colonna `batch_id`. Ogni batch poteva quindi scandire ripetutamente gli
snapshot. La tabella injury disponeva già dell'indice UNIQUE con prefisso
`batch_id, team_id`.

La migrazione additiva `022_lineup_batch_read_index.sql` crea soltanto
`idx_lineup_snapshots_batch ON player_lineup_snapshots(batch_id)`, con
`IF NOT EXISTS`. La query applicativa, i dati, la retention, i modelli e i
portafogli restano invariati. Il normale runner delle migrazioni scopre il
nuovo file; i test mirati lo applicano direttamente in memoria senza bootstrap.

Verifica offline sul restore privato `target-cli-export-20261029T185811Z`,
aperto in sola lettura con `mode=ro&immutable=1`: 1.066 contenitori, 69.697
snapshot lineup e 286 record di refresh injury. Sono state copiate in memoria
soltanto queste tre tabelle, conservando schema, indici e tutti i valori.
La query `DELETE` esatta è stata letta dal sorgente e realmente eseguita sul
clone prima e dopo l'indice, con chiavi esterne abilitate. Il backup originale
non è stato migrato o modificato.

| Misura locale, SQLite 3.49.1 | Prima | Dopo l'indice |
| --- | ---: | ---: |
| Tempo della stessa DELETE | 1.484,889 ms | 0,682 ms |
| Istruzioni VM approssimate, contatore ogni 1.000 | 147.385.000 | 12.000 |
| Righe applicative cancellate | 0 | 0 |
| Ricerca snapshot nel piano | SCAN sull'indice match | SEARCH sull'indice batch |

`EXPLAIN QUERY PLAN` conferma `SEARCH snapshot USING COVERING INDEX
idx_lineup_snapshots_batch (batch_id=?)`, al posto della scansione ripetuta.
Anche il controllo dei riferimenti snapshot necessario alla DELETE usa il
nuovo indice. Tutti i conteggi e gli hash dei valori delle tre tabelle sono
rimasti identici; nessuna violazione di chiave esterna. SHA-256 del restore
prima e dopo: `03df131729ea4352c3e235b0c16821ccbaa013c2294df9219fac7497d8883618`.

La costruzione locale dell'indice ha richiesto 26,865 ms e circa 627.000
istruzioni VM; la seconda applicazione è un no-op (0,010 ms nel campione).
L'indice contiene logicamente 69.697 riferimenti e il clone è cresciuto di
767 pagine da 4.096 byte, **3.141.632 byte, circa 3 MiB**. Questa è una stima
di spazio basata sulle pagine allocate nel clone: l'estensione `dbstat` non è
disponibile nel Python locale. La creazione legge lo storico una volta e
costruisce quelle entrate; i futuri inserimenti/cancellazioni di snapshot
mantengono anche questo indice. `rowsAffected = 0` indica assenza di modifiche
alle righe applicative, non costo zero di costruzione o garanzia sulle unità
fatturate da Turso. Il consumo reale del rilascio va confrontato nell'Analytics.

Controlli ripetibili, dalla directory `backend`, con il build corrente:

```powershell
node --test --test-concurrency=1 test/lineup-batch-read-index.test.js test/football-data-service.test.js
npx eslint test/lineup-batch-read-index.test.js --max-warnings=0
```

Esito: **39/39 test** superati. I nuovi test verificano applicazione ripetuta,
valori invariati, piano indicizzato e identità della query, confrontando batch
orfano, solo injury, solo snapshot ed entrambi. Solo l'orfano viene rimosso e
una seconda pulizia non cambia nulla. Nessuna nuova compilazione, connessione
remota, chiamata provider o applicazione della migrazione in produzione è stata
eseguita per questa prova. Il beneficio sulle righe lette remote resta da
misurare dopo il rilascio; è distinto dal precedente -99,9398% sui byte della
dashboard, che non dimostrava una riduzione delle righe lette.

Il gate integrale precedente alla migrazione 022, con entrambe le ottimizzazioni I/O incluse, ha
eseguito la suite backend in Linux/Node 20, senza rete, con 2 CPU e 1 GiB:
**886 test, 885 PASS, zero errori, uno skip opzionale del runtime Python
CatBoost**. La revisione indipendente del diff ha inoltre superato 49 test
mirati senza rilevare problemi bloccanti. Questi esiti non attestano ancora
la risoluzione del throttling sul servizio Hostless.

### Applicazione sul database personale: 30 ottobre, 00:43 Roma

Il pannello ufficiale dell'account `selloneciompi` ha mostrato, prima del fix,
112,23 milioni di righe lette su 500 milioni, circa 1.250 scritte su 10 milioni,
1,57 GB di sync su 3 GB e 525,98 MB di storage su 5 GB. Piano Starter Free,
ciclo 1 ottobre–1 novembre, prossima fattura mostrata $0,00. La query orfani
risultava eseguita tre volte, circa 36,85 milioni di righe lette per chiamata:
circa il 98,5% delle letture osservate era attribuibile a questa query.
Le medie arrotondate del pannello non sostituiscono contatori esatti per query.

La 022 è stata applicata realmente sul solo database canonico personale alle
23:43:57 UTC del 29 ottobre, 00:43:57 Roma del 30 ottobre, con batch atomico:
creazione dell'indice e registrazione del nome completo della migrazione.
Il controllo remoto prima/dopo conferma `SEARCH snapshot USING COVERING INDEX
idx_lineup_snapshots_batch (batch_id=?)`, al posto di `SCAN snapshot`.
Anche il controllo FK della DELETE pianificata usa il nuovo indice.

Sono invariati i conteggi delle tre tabelle tecniche e gli hash di portafogli,
ledger, budget, sessioni budget e puntate legacy. Nessuna DELETE di collaudo
è stata eseguita in produzione; il piano è stato letto con `EXPLAIN QUERY PLAN`.
Nessun nuovo token o servizio, richiesta al provider quote o riavvio Hostless.
Il backend già pubblicato usa immediatamente l'indice persistente: il suo
codice applicativo rimane `63d7cb96`; il nuovo file serve anche alle successive
installazioni. Le prove private sono in
`backend/artifacts/backups/personal-migration-20261029/consumption-audit-20261030/`.

Compilazione, typecheck, 39 test mirati, lint e revisione indipendente superati.
Il piano remoto indicizzato è verificato; il nuovo costo fatturato della
successiva pulizia reale e il ritmo ordinario di più Nightly restano da
misurare. I 112,23 milioni già consumati non vengono annullati dal fix.
La precedente riduzione dei byte non era una misura di righe fatturate:
[Turso spiega la distinzione fra righe restituite e righe esaminate](https://turso.tech/blog/tips-for-maximizing-your-turso-billing-allowances-48a0fca163e9).
Non è ancora dimostrato, sulla sola prova locale o sul primo giorno di
migrazione/collaudo, il consumo di un intero mese ordinario sotto 500 milioni.
