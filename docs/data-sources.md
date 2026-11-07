# Fonti dati e sostituibilità

Verifica documentale: 6 novembre 2026. Questa guida distingue integrazioni
implementate, copertura dichiarata e uso consentito. Non certifica disponibilità
del provider, dati completi dell'account, accuratezza di ogni partita o licenza
individuale dell'applicazione. Le ricevute dei probe e i conteggi correnti
restano negli artefatti privati, non sono un calendario operativo permanente.

## Contratto corrente

Understat resta la fonte primaria di partite, risultati, xG e statistiche.
Il supplemento football-data.co.uk riempie soltanto campi mancanti in fixture
primarie già concluse, preservando zeri osservati e priorità con COALESCE.
The Odds API resta il provider delle quote correnti; i CSV storici non ne
sostituiscono freschezza, timestamp e provenienza. API-Football è opzionale
e non è attivato dalla presenza della chiave.

football-data.org è integrato nel calendario del collector di ricerca, con
mapping revisionato e opt-in. Esiste inoltre un collector indipendente di
calendario e risultati, in una cache SQLite dedicata: non richiede Understat,
non modifica matches/teams, non attiva il collector scientifico e non promuove
snapshot a input predittivi. Nessun risultato alternativo sostituisce
silenziosamente un valore primario.

Il payload originale delle partite football-data.org può includere anche
`referees`; il formato normalizzato del collector di calendario non conserva
questo campo. Una manutenzione esplicita può recuperarne il solo arbitro
principale (`type=REFEREE`) quando è univoco e il campo operativo è NULL.
Richiede partita conclusa, punteggio, data e mapping revisionato concordanti,
prova originale conservata, cache ancora valida e protezione del valore
nella stessa transazione. Nomi esistenti e identità in quarantena restano
preservati. Questo riuso non attiva un nuovo import automatico né attesta
la disponibilità delle statistiche comprese negli add-on del provider.

## Alternative esaminate

Il percorso operativo opt-in è ora collegato alla Nightly tramite
`NIGHTLY_SOURCE_MODE=verified-alternatives`. Usa le sei tabelle cache condivise
del target esistente, inizializzate soltanto con consenso esplicito; nessun
nuovo servizio o piano a pagamento. SourceFeedStore attesta l'ultimo tentativo
FDO e NightlyCsvCache conserva tentativi/snapshot CSV senza rinnovare
artificialmente acquiredAt. Il calendario ammette previsioni solo in stato
`TIMED`; `SCHEDULED` indica una data approssimativa nella
[definizione ufficiale](https://docs.football-data.org/general/v4/match.html#_status_workflow_explained).
Controlli e procedura sono nella [guida Nightly](github-actions-nightly-sync.md).

Il bootstrap delle cache usa batch atomici compatibili anche con il trasporto
HTTP libSQL/Turso: ogni istruzione in forma di oggetto esplicita `args`, con
array vuoto quando non ha parametri. I test verificano il serializzatore HTTP
dell'SDK oltre all'esecuzione SQLite locale, senza contattare il DB operativo.

| Fonte | Copertura utile dichiarata | Limite per questa pipeline |
|---|---|---|
| [football-data.org Free](https://www.football-data.org/pricing), [copertura](https://www.football-data.org/coverage) | Calendario e risultati ritardati delle cinque leghe; 10 chiamate/minuto | Non fornisce nel Free base le statistiche complete/xG necessarie; le statistiche sono un add-on. Un calendario disponibile non certifica l'aggiornamento delle feature. |
| [football-data.co.uk CSV](https://football-data.co.uk/data.php), [schema](https://football-data.co.uk/notes.txt) | Risultati, tiri/SOT, cartellini e altre statistiche squadra; quote storiche | Gli snapshot correnti esaminati contengono anche HxG/AxG: il parser li conserva come candidati non verificati, senza importarli come xG Understat. Definizione, fornitore e confrontabilità restano da attestare; niente boxscore giocatore. |
| [API-Football Free](https://www.api-football.com/news/post/how-to-get-all-data-from-a-league-with-api-football), [piani](https://www.api-football.com/#pricing) | Endpoint per fixture, rose e statistiche delle stagioni ammesse; 100 richieste/giorno | La guida del 26/10/2026 limita il Free a Year−4..Year−2: 2022–2024 nel 2026. Non risolve gratuitamente la stagione corrente; coverage=true non garantisce ogni campo o gara. |
| [Sportmonks Free](https://www.sportmonks.com/football-api/free-plan/) | Superliga danese e Premiership scozzese | Nessuna delle cinque leghe richiesta nel Free permanente; un trial non è sostenibilità gratuita. |
| [StatsBomb Open Data](https://github.com/hudl/open-data), [indice](https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json) | Eventi, xG e formazioni di partite storiche selezionate | Non è un feed corrente completo delle cinque leghe. Non sostituire xG di fornitori diversi senza confronto e nuova tracciabilità. |
| [API Ninjas](https://api-ninjas.com/api/football), [piani](https://api-ninjas.com/pricing) | Fixture, risultati finali e rose dichiarati per le cinque leghe | Il Free esaminato vieta caching/storage: non dimostra compatibilità con la persistenza prevista dall'app. Non documenta la copertura xG necessaria. |
| [OpenLigaDB](https://www.openligadb.de/), [schema](https://github.com/OpenLigaDB/OpenLigaDB-Samples) | Calendari e risultati comunitari, Bundesliga documentata | Non copre in modo verificato tutte le cinque leghe, xG e statistiche individuali richieste; nessuno SLA viene dedotto. |
| [PitchAPI](https://pitchapi.dev/) | Dichiara 77 leghe, Top5, xG dei tiri, statistiche e giocatori, gratuitamente | Serve una chiave non presente nelle integrazioni. Nessuna verifica autenticata o autorizzazione ai dati attestata; termini, conservazione e upstream non verificati. La definizione SOT descritta non è automaticamente quella dei nostri mercati. |
| [OpenFootball JSON](https://github.com/openfootball/football.json) | Calendari e risultati comunitari, licenza CC0 e aggiornamento giornaliero dichiarato | Non fornisce xG/statistiche individuali; date/orari non attestano sempre il kickoff UTC necessario. Non è integrato come fallback operativo. |

Non è stata dimostrata una sostituzione gratuita completa di Understat per
le feature correnti A/C. Questa conclusione riguarda le fonti esaminate,
non l'inesistenza di altre offerte. I dati xG mancanti restano mancanti:
gol reali, quote o previsioni del nostro modello non sono xG osservati.

## Riutilizzo dello storico Understat

L'indisponibilità HTTP di Understat non rende automaticamente inutilizzabili
gli xG già salvati. Per una previsione futura, una copia acquisita prima del
kickoff dimostra che quei valori erano disponibili a quell'istante; non prova
quando furono pubblicati originariamente, né consente un replay storico
rigorosamente prospettico. `created_at` della fixture non è il timestamp
di acquisizione degli xG e `source` della riga non certifica ogni campo.

Controllare per squadra e lega le gare effettivamente concluse, quelle ancora
non importate e i campioni osservati consumati dal modello. Non esiste un
numero di giorni dopo il quale gli xG scadono automaticamente, né un benchmark
che autorizzi una nuova soglia di freschezza. Le probabilità possono cambiare
legittimamente dopo un risultato nuovo; il cambiamento, da solo, non misura
un peggioramento. Un'inferenza riuscita o un confronto con input invariati
non validano invece l'uso dei fallback in presenza di nuove lacune.

Gli xG CSV restano esclusi anche durante un'interruzione della fonte primaria.
La verifica ordinaria di una previsione futura e la verifica della disponibilità
temporale richiesta dal pilot scientifico sono controlli distinti. Nessuno dei
due autorizza a saltare i gate Nightly, riutilizzare una calibrazione con
fingerprint diverso o sostituire i parametri operativi con valori di default.

Nello staging isolato il seed conserva anche possesso, zeri/NULL e l'eventuale
`created_at` originale, senza sostituirlo con l'orario della prova. Un campo
omesso dal seed non dimostra che fosse mancante nel database operativo. Per
confrontare i modelli usare una copia di tutti gli input effettivamente letti;
una proiezione più stretta va dichiarata come tale. Il seed non è un backup
completo e non viene usato come attestazione di pubblicazione storica.

La revisione dei calendari e referti ufficiali distingue Troyes (Understat 172),
Le Havre (282) e Le Mans (295), senza rinominare o fondere le squadre. Il
[programma originale del Toulouse](https://www.toulousefc.com/play/blog/2026/10/le-programme-du-week-end-24-et-25-octobre-2026)
documentava il rinvio di Toulouse–Troyes alla domenica, non un conflitto fra
Troyes e Le Havre. La precedente quarantena indiscriminata dell'ID 172 è
sostituita dal controllo circoscritto `ReviewedSourceIdentity`: nello scope
FL1/2026 verifica ID football-data.org 531/533/535 e nomi attestati, anche in
apply di piani precedenti e dentro la transazione. Un nome cosmetico non
autorizza un'associazione errata; il supplemento conserva matching per data,
squadre e risultato. Le altre identità mantengono i propri controlli.

Le date provvisorie dei calendari non diventano orari confermati. Le rettifiche
ufficiali del kickoff hanno una protezione separata, descritta nel
[contratto delle osservazioni](data-observation-contract.md). La risoluzione
dell'identità non riscrive previsioni passate né rimuove le esclusioni del
protocollo di addestramento C o dell'holdout.

## Diritti e conservazione

- [football-data.org](https://www.football-data.org/about) richiede chiave
  riservata e attribuzione, con condizioni per applicazione e conservazione;
  loghi/foto hanno diritti separati. L'attribuzione richiesta è
  “Football data provided by the Football-Data.org API”.
- La pagina [football-data.co.uk](https://football-data.co.uk/contact.php)
  ammette uso personale e ricerca accademica con download manuale o automazione
  leggera, al massimo due volte alla settimana, senza necessità di contatto per
  tale uso. Esclude usi commerciali e progetti AI/data-training con richieste
  pesanti. Non dedurre da questo un permesso per import giornalieri, training
  o redistribuzione. Il percorso Nightly corrente usa `NightlyCsvCache`, con
  prenotazioni persistenti condivise: al massimo due raccolte in sette giorni,
  almeno 84 ore dopo una raccolta riuscita. Tentativi falliti o interrotti
  consumano la prenotazione; il passaggio da una cache senza storico attestato
  impone una prima attesa di sette giorni. Questo limite tecnico non certifica
  diritti ulteriori o richieste compiute da altri client. I probe non aggirano HTTP429.
- [API-Football](https://www.api-football.com/terms) e
  [Sportmonks](https://www.sportmonks.com/terms-of-service/) pongono condizioni
  su applicazioni, rivendita e diritti terzi. Nessun aggiramento delle quote
  mediante account multipli e nessuna licenza sulle immagini dedotta dall'API.
- [StatsBomb](https://github.com/hudl/open-data/blob/master/LICENSE.pdf)
  impone condizioni di attribuzione, distribuzione e sfruttamento commerciale
  anche sulle analisi. “Open” non autorizza ogni prodotto o redistribuzione.
- [API Ninjas](https://api-ninjas.com/tos) distingue valutazione gratuita e
  uso con conservazione; [OpenLigaDB](https://www.openligadb.de/) dichiara
  ODbL, con attribuzione e condizioni della banca dati da valutare separatamente
  dalla licenza del codice e dalle immagini.

Questi sono riscontri dei testi pubblicati, non una conferma individuale del
fornitore sul caso d'uso. Nessun servizio a pagamento viene attivato dal codice
di questa verifica.

## Dati effettivamente richiesti

| Modello/mercati | Input numerici necessari | Opzionali e limiti |
|---|---|---|
| A: 1X2, doppia chance, DNB, goal/OU, BTTS, handicap | Risultati storici, identità/date, parametri per lega e squadre, calibrazione compatibile | Il codice ammette fallback senza xG e senza parametri, ma ciò non dimostra affidabilità. Poisson-xG è opzionale; un percorso risultati-only va validato e il fit deve essere adeguato. |
| A: tiri | Tiri per sede, tiri concessi, campioni osservati, intensità gol | Non indipendente dalla componente gol; arbitro/giocatori/contesto usano i fallback esistenti. |
| A: tiri in porta | Tiri totali e SOT, campioni per entrambi, intensità gol | Il rapporto SOT/tiri non può essere supportato dal solo campione SOT. |
| A: gialli e booking points | Gialli, anche rossi per booking points, campioni e contesto/intensità gol | Arbitro e falli possono usare prior: non diventano osservazioni. Rossi soli non sono un mercato operativo separato. |
| A: player props | Identità non ambigua, minuti/presenze, statistiche del mercato, ammissibilità formazione e quota reale | Marcatore richiede xG/90 positivo; la rosa senza osservazioni non basta. Funzioni opzionali restano disabilitate nei default. |
| C: tutti i mercati gol | Baseline A80, artefatto e calibrazione compatibili, storia risultati, feature xG/tiri/campioni/forma/Elo | Un fallback a 1.3 o 0 e una copertura storica non attestano freschezza o equivalenza di un nuovo fornitore xG. Non esiste un mercato C gol separabile da quella matrice. |

Le soglie statistiche esistenti di A sono almeno 8 osservazioni per squadra e
20 complessive; le props applicano le proprie soglie. Il minimo fit C di 30
partite è di lega, non per squadra e non è una soglia di xG recenti. Nessuna
nuova soglia di freschezza o di accuratezza viene inventata per sbloccare i
mercati. Quote reali, campioni e dati prepartita restano requisiti distinti.

I dati HxG/AxG dei CSV non entrano nelle colonne home_xg/away_xg né nelle
feature C: il campo opzionale `unverifiedXg` conserva soltanto i numeri osservati
e lo stato `provider_semantics_unverified`. Valori assenti o invalidi rimangono
null; zero autentico rimane zero. Servono definizione ufficiale, provenienza,
confronto sulle stesse partite e verifica del cambio di distribuzione prima
di qualsiasi piano di import approvato. Cambiare fornitore xG può richiedere una
validazione di compatibilità, anche senza cambiare le formule.

## Raccolta indipendente e verifiche ripetibili

`FootballDataOrgFeed` riusa il trasporto HTTPS già presente e valida scope,
identità, stati, punteggi e calendario completo delle cinque leghe. IDs del
provider hanno namespace separati; un risultato FINISHED richiede due interi
osservati, senza convertire mancanti o booleani in zero. La cache conserva
hash, timestamp di acquisizione e aggiornamento, tentativi ed errori. Non
conosce l'istante di pubblicazione e non dichiara inputAvailableThrough verified.

Il collector è inerte all'import e senza `--collect`; richiede esplicitamente
un file nuovo o una cache dedicata riconosciuta. Rifiuta URL remoti e database
operativi. Non legge automaticamente .env, non stampa chiavi, non avvia
scheduler e non effettua retry automatici. Usa al massimo cinque richieste per
invocazione. Cache valide, tentativi interrotti, errori di credenziali/429 e
scope mantengono 15 minuti di attesa. Solo errori transitori espliciti
(rete, timeout, JSON non valido, HTTP5xx o fixture invalida) consentono un nuovo
tentativo dopo 60 secondi, alla successiva invocazione: nessun loop di retry.
Il distanziamento persistente minimo di 7 secondi resta obbligatorio. Usare una sola cache per
account e rispettare anche gli altri client che consumano lo stesso piano.

Dopo build, dalla directory backend, con FOOTBALL_DATA_ORG_API_KEY già
configurata nell'ambiente del processo:

```powershell
New-Item -ItemType Directory -Force artifacts/source-feeds | Out-Null
npm run data:collect -- --collect --database artifacts/source-feeds/calendar.sqlite --season 2026
```

Questo comando raccoglie dati autentici nella sola cache; non avvia la
Nightly e non importa nel DB operativo. Rieseguirlo entro il cooldown non
ripete le richieste. Un fallimento più recente o dati scaduti restano espliciti,
anche se lo snapshot precedente è conservato per ispezione. I risultati non
vengono usati automaticamente per liquidare giocate.

Il resoconto distingue capacità della fonte e ammissibilità del modello:
consente l'ispezione dei dati acquisiti, ma restituisce ABSTAIN senza
probabilità per input predittivi non verificati. Non allenta i gate globali
della Nightly e non sostituisce il protocollo scientifico. La separazione del
gate per mercato richiede evidenze e stato dei modelli che il solo calendario
non può attestare.

## Percorso per una sostituzione esplicita

### Import nella pipeline, in staging

`SourceFeedImport` collega cache e schema matches/teams con piano separato
dall'applicazione. Richiede mapping esplicito revisionato per competizione e
stagione, identità univoche, snapshot corrente e hash del piano. Completa
soltanto gol mancanti compatibili e aggiorna kickoff di partite future; i
risultati conclusi con data discordante restano in conflitto. Fonte e ID
preesistenti, xG e altri valori noti non sono sovrascritti. La provenienza
dei soli campi modificati viaggia in raw_json, preservandone gli altri dati.

L'opzione separata allowCreateFixtures crea soltanto fixture future con
entrambe le squadre revisionate/esistenti, ID football_data_org_<providerId>
e statistiche/xG NULL. Non inventa ID Understat o risultati. La successiva
importazione CSV riconosce anche queste identità, senza coinvolgere il
calendario scientifico, che conserva il proprio contratto.

`SourceSupplementImport` riusa parsing e riempimento COALESCE esistenti su
CSV già acquisiti: hash, scope, data esatta, squadra e risultato devono
coincidere. Non scarica CSV, non importa quote né candidati xG; conserva gli
zeri e registra provenienza per i campi completati. Match ambigui o discordanti
restano esclusi. Le transazioni di entrambi gli import annullano il gruppo
selezionato su errore o modifica concorrente; non si dichiara atomicità fra
cache sorgente e DB target separati.

Il comando `npm run data:stage` accetta soltanto un file target **nuovo**.
Inizializza lo schema locale, verifica la copia dei campi esportati, importa
i dati ammissibili e ricostruisce le medie squadra, senza fit o calibrazioni.
Il seed non è un backup completo: raw_json, account, modelli e portafogli non
vengono esportati automaticamente. La copia verifica NULL e identità; il seed
conserva la propria provenienza separata dalle osservazioni importate.

```powershell
npm run data:stage -- --stage --sandbox artifacts/source-feeds/prova.sqlite --source-cache artifacts/source-feeds/calendar.sqlite --seed-matches seed.json --mapping mapping.json --season 2026
```

Il mapping deve avere versione reviewed-source-mapping-v1, reviewedAt,
reference e teams per nome del campionato. Il seed contiene i campi matches
esportati esplicitamente; non viene letto il DB operativo. `--collect` è
un opt-in separato per aggiornare la sola cache FDorg. I CSV locali si
specificano con `--csv-directory` e `--csv-acquired-at`; l'orario dichiarato
non diventa una prova indipendente di disponibilità prima della partita.

Di default un piano con conflitti non viene applicato. Il comando
di sandbox può richiedere esplicitamente `--apply-verified-subset`: applica
le entry verificate vincolate all'hash atteso, senza modificare quelle BLOCK.
Il piano resta blocked, il risultato partial e il comando segnala esito non
completo. Non certifica la coorte e non autorizza un'applicazione operativa.
Un hash garantisce integrità, non è una firma del provider o una licenza.

Staging restituisce ABSTAIN senza probabilità e non richiede quote quando
l'input alternativo non ha validazione adeguata. Non inizializza il pilot,
non registra nuove giocate e non modifica workflow o gate Nightly. Le librerie
di import non sono esposte automaticamente dalle route operative.

### Benchmark degli xG

Le note ufficiali COUK esaminate descrivono le statistiche standard ma non
definiscono HxG/AxG o il relativo modello/fornitore. La similarità numerica
e la presenza delle colonne non risolvono questa lacuna. Understat non è
assunto come verità: delta e correlazioni descrivono accordo fra fonti,
non accuratezza delle chance o del modello predittivo.

`backend/scripts/benchmark-alternative-inputs.js` verifica hash, cronologia e
scope degli snapshot già disponibili senza eseguire fit, inferenza o
ricalibrazione. È un controllo di fattibilità, non un confronto predittivo
completato. Per un confronto fedele servono la storia alternativa disponibile
prima dei target, le revisioni/acquisizioni e una coorte ammissibile: gli xG
postpartita del target non possono diventare input prepartita dello stesso
match. Cambiare solo feature xG mantenendo lambda e matrice della vecchia
baseline non riproduce il percorso della fonte alternativa.

Nessun benchmark non valutabile diventa un GO. Esperimenti futuri devono
essere distinti, versionati e autorizzati, con C e calibrazioni congelati,
stesse finestre cronologiche, esclusioni/holdout rispettati e confronto di
calibrazione e affidabilità sulle stesse partite. Non basta una differenza
media inferiore o una correlazione elevata per autorizzare la sostituzione.

### Requisiti prima dell'uso operativo

Un'eventuale sorgente secondaria va prima provata in staging isolato: ID
provider separati, mapping esatto di squadra/partita, kickoff e stato, timestamp
di acquisizione, conflitti e valori mancanti espliciti. Misurare sulla stessa
finestra copertura per campo, aggiornamento e disaccordi; un HTTP 200 o uno
schema corretto non dimostrano accuratezza. Il piano di import nel DB operativo,
i diritti, i budget e la scelta del primario richiedono approvazione separata.

Conservare le formule non rende equivalenti dati o xG di fornitori differenti.
Non riattivare FBref, FotMob, Transfermarkt o scraping alternativo come fallback
silenzioso. Il calendario di ricerca e la validazione prospettica rimangono
separati dalla normale automazione A/C.
