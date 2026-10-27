# Audit delle quote storiche A/C — 27 ottobre 2026

## Esito

L'archivio contiene quote reali utilizzabili per **analisi di snapshot prepartita**,
ma non una coorte indipendente sufficiente a validare il rendimento della nuova
pipeline A/C. **ROI, drawdown economico e CLV restano non disponibili.**

Questo audit non modifica il vecchio benchmark, non seleziona parametri sulle
745 partite finali e non scrive sul database remoto. I risultati numerici
ispezionabili sono nel [riepilogo JSON](research-odds-audit-2026-10-27.json).

## Fonte e metodo

Sono state eseguite soltanto query `SELECT` tramite un client libSQL separato,
senza inizializzare `DatabaseService`, applicare migrazioni o richiamare provider.
L'esportazione locale conserva i record sportivi necessari, senza credenziali.
Gli hash degli input sono registrati nel JSON.

Il perimetro comprende 7.476 partite concluse dei cinque campionati e 10.915
snapshot. `captured_at` è il momento di osservazione registrato nel database,
non il timestamp `last_update` del bookmaker. Quest'ultimo non è presente
nelle mappe numeriche storiche esportate: non viene ricostruito.

Per gli snapshot bulk privi di `match_id`, il nuovo adattatore tenta un
collegamento locale soltanto con competizione, kickoff esatto, squadra di casa
e squadra ospite. Riusa in composizione i normalizzatori di nomi già presenti.
Non inverte le squadre e non applica tolleranze di data o matching fuzzy.
Un abbinamento ambiguo resta escluso. Il nuovo identificativo risolto e il
metodo del collegamento sono metadati locali; il record remoto resta intatto.

Anche un collegamento tramite ID viene controllato sui nomi quando il match
concluso è disponibile. Sono quarantinati 95 record per i quali gli alias
esistenti non provano l'equivalenza. Alcuni contengono nomi plausibilmente
equivalenti, come Tottenham/Tottenham Hotspur o Atalanta/Atalanta BC: questo
controllo conservativo **non dimostra che gli ID siano sbagliati**.

## Copertura verificata

| Controllo | Numerosità |
|---|---:|
| Snapshot originali | 10.915 |
| Collegamenti già presenti per ID, dopo controllo nomi | 4.096 |
| Collegamenti recuperati localmente tramite fixture esatta | 2.480 |
| Snapshot prepartita con partizioni goal complete e reali | 6.228 |
| Di questi, riferiti a partite concluse | 6.095 |
| Partite concluse con almeno uno snapshot ammesso | 519 |
| Snapshot con freshness T−15 dimostrata | 0 |

I restanti 133 snapshot ammessi riguardano 20 partite future già collegate:
non contribuiscono ad alcuna misura storica di qualità o rendimento.

Le esclusioni principali sono: 4.336 record senza identità utilizzabile,
318 con kickoff del provider diverso dal kickoff archiviato, nove osservati
al kickoff o dopo, 24 sintetici o completati dal modello. Le categorie di
collegamento e quelle di ammissibilità sono controlli distinti, non devono
essere sommate fra loro.

I 519 match con prezzi precedenti al forecast originale si distribuiscono in
Bundesliga 59, La Liga 128, Ligue 1 124, Premier League 71 e Serie A 137.

| Fold originale | Match test | Match test con prezzi | Coorte calibrazione probabilistica con prezzi |
|---|---:|---:|---:|
| 0 | 739 | 0 | 0 / 387 |
| 1, ammesso allo sviluppo | 684 | 42 | 0 / 366 |
| 2, test finale già consultato | 745 | 477 | 41 / 335 |

Nel fold finale 473 dei 477 match hanno anche un prezzo osservato dopo il
termine di validazione dell'artefatto C. I 477 match sono conteggi di copertura:
non vengono utilizzati per tuning, selezione di soglie o fitting prudenziale.

I 42 match quotati del fold di sviluppo comprendono Bundesliga otto, La Liga
dieci, Ligue 1 dieci, Premier League quattro e Serie A dieci. Hanno copertura
1X2 per 37 match, totali goal per 13 e handicap asiatico per tre. Le coperture
si sovrappongono. Non esiste una copertura uniforme di tutti gli otto mercati.

## Quote football-data già archiviate

Tutte le 7.476 partite concluse hanno `fd_odds_json`. Il parser esistente sceglie
prima `AvgH/AvgD/AvgA`, poi le vecchie medie `BbAv*` e infine `B365*`; opera
analogamente sui totali. Il JSON conservato contiene soltanto mappe
`opening` e `closing`, senza colonna originale, bookmaker o momento di
osservazione. Non è possibile sapere retroattivamente se ogni prezzo fosse
una media oppure una quota dell'operatore di fallback.

Queste mappe rimangono dati analitici. Non diventano quote Eurobet o Bet365,
non dimostrano prezzi eseguibili e non vengono incluse nel ROI A/C.
L'importazione successiva del CSV non può essere trasformata nel timestamp
originario della quota. La provenienza delle colonne dovrà essere preservata
in una futura evoluzione additiva dell'ingest, senza riscrivere lo storico.

## Protocollo economico implementabile

Il nuovo adattatore conserva bookmaker effettivo, sorgente originale,
snapshot, mercato, selezione, linea e momento di osservazione. Le partizioni
devono provenire interamente dallo stesso operatore. Eurobet ha priorità
soltanto quando compare davvero con una partizione completa; altrimenti
viene scelto deterministicamente un altro operatore reale.

Gli alias legacy `1`, `X`, `2` vengono normalizzati conservando la chiave
originale. Due alias dello stesso esito con prezzi discordanti invalidano
la partizione. Quote sintetiche, stimate o completate dal modello vengono
escluse anche se qualche loro componente somiglia a un prezzo reale.

Un prezzo osservato alle 12:00 non viene trapiantato nel forecast delle
20:30 come se fosse ancora disponibile. La preparazione economica ricalcola
le feature e le previsioni A/C alle **12:00**, usando un artefatto già
cronologicamente validato a quell'istante. `updatedAt` resta assente;
`timestampEvidence=observed_snapshot` rende esplicita la semantica. Questo
protocollo è storico e prepartita, non un backtest T−15, di apertura o di
chiusura. Il percorso operativo continua a richiedere il vero timestamp
di aggiornamento e il limite di cinque minuti.

La preparazione esclude per costruzione il fold finale originale. Usa i
modelli dei fold di sviluppo già congelati e non modifica i relativi file.
Non promuove modelli o mercati e non inizializza portafogli.

## Confronto coerente V2 sugli snapshot di sviluppo

La preparazione ha ricostruito **42 previsioni A/C** al momento effettivo della
quotazione, senza riutilizzare i 745 match finali. I pesi CatBoost dei fold
originali restano congelati. Calibratore e trasformazione comuni V2 sono
identificati separatamente dall'hash della pipeline di analisi. Il nuovo
artefatto C ha una versione figlia con riferimento al modello originale.
La matrice finale e tutte le marginali rimangono coerenti; il vecchio report
non viene riscritto.

| Metrica, 42 partite di sviluppo | A | C |
|---|---:|---:|
| Log loss 1X2 | 0,928867 | 0,942743 |
| Brier multiclass | 0,548941 | 0,557067 |
| ECE della confidenza massima | 0,124083 | 0,175597 |

Il delta C−A della log loss è +0,013877, con intervallo appaiato al 95%
[−0,007262; +0,038741]; quello del Brier è +0,008126
[−0,005684; +0,022915]. Il campione copre soltanto **due settimane**:
**il confronto rimane inconcludente**, anche se le medie favoriscono A.
Sono 37 i match con una partizione bookmaker 1X2 completa per il confronto
senza margine. Questi numeri non sono confrontabili direttamente con la media
del vecchio benchmark: campione, istante di previsione e disponibilità quote
sono differenti.

Il Decision Engine ha prodotto 42 astensioni per ciascun modello. Sui prezzi
esaminati, A ha 169 esclusioni per EV centrale insufficiente e 36 per assenza
di calibrazione prudenziale indipendente; C ne ha rispettivamente 175 e 30.
Sono conteggi di selezioni candidate, non di partite distinte. Le giocate sono
zero e le metriche economiche restano **non disponibili**, senza trasformare
il capitale iniziale invariato in una prestazione misurata.

È stato eseguito anche un controllo diagnostico V2 con calibrazione identità,
predefinito senza scegliere il vincitore su queste 42 partite. Mantiene lo
stesso blending bookmaker e usa gli stessi input e prezzi:

| Metrica, controllo identità V2 | A | C |
|---|---:|---:|
| Log loss 1X2 | 0,933442 | 0,941840 |
| Brier multiclass | 0,551624 | 0,556733 |
| ECE della confidenza massima | 0,074421 | 0,117022 |

Anche questo confronto è inconcludente. Sul piccolo campione la correzione
isotonica aumenta l'ECE di entrambi; non basta a dimostrare una causa generale
o a scegliere un nuovo calibratore operativo. La precedente esecuzione V1
è conservata nei file `diagnostic-legacy-v1-*` come diagnostica del vecchio
postprocessing, non come nuovo benchmark ufficiale.

## Perché il ROI resta non disponibile

Il Decision Engine richiede almeno 50 match indipendenti nel bucket di
calibrazione prudenziale pertinente, con prezzi reali e risultati noti prima
della decisione. Il fold di sviluppo con quote ha solo 42 match e nessuna
coorte quotata di calibrazione precedente. I 41 match quotati della coorte
probabilistica finale non sono indipendenti dal fitting del calibratore,
oltre a essere meno di 50 già prima di suddividerli per mercato e bucket.

Usare le 745 partite finali per stimare residui favorevoli, scegliere soglie
o sbloccare puntate contaminerebbe il test. Non è stato fatto. Una simulazione
che si astiene per prove insufficienti non dimostra né profitto zero né
assenza di rischio: le metriche economiche rimangono `null`.

Le ultime osservazioni prepartita non provano inoltre una vera quota di
chiusura: il CLV non viene ricostruito attribuendo arbitrariamente tale ruolo
all'ultimo snapshot presente.

## Fonti gratuite e limiti correnti

La [pagina ufficiale football-data](https://www.football-data.co.uk/data)
descrive dati per privati, quote pre-chiusura e di chiusura, e contiene una
restrizione sugli utilizzi di prodotti di training con acquisizione
automatica/AI. L'autorizzazione per nuove acquisizioni automatiche o nuovi
usi di training non è stata stabilita in questo audit. Nessun CSV è stato
scaricato; nessun nuovo training usa queste quote. La pagina segnala anche
problemi di aggiornamento delle quote Pinnacle dal luglio 2025.

Lo [storico ufficiale The Odds API](https://the-odds-api.com/historical-odds-data/)
richiede un piano a pagamento. Non è stato abilitato né interrogato.
Non è stata introdotta una nuova fonte di provenienza o licenza incerta
per ottenere artificialmente un backtest economico completo.

## Comandi riproducibili

Da `backend`, dopo la build:

```powershell
node --env-file=../.env.production scripts/research-odds.js export --out artifacts/research/odds-audit-20261027/archive.json
node scripts/research-odds.js audit --archive artifacts/research/odds-audit-20261027/archive.json --report artifacts/research/run-20261027/report.json --out artifacts/research/odds-audit-20261027/audit.json
node scripts/research-odds.js prepare --archive artifacts/research/odds-audit-20261027/archive.json --report artifacts/research/run-20261027/report.json --models artifacts/research/run-20261027 --matches artifacts/research/matches.json --out artifacts/research/odds-audit-20261027/development-coherent-rows.json --probability-protocol coherent-v2 --calibration-mode isotonic_1x2
```

Solo `export` legge il database configurato, esclusivamente con `SELECT`.
Gli altri comandi leggono file e producono file locali. Il nuovo test
`research-historical-odds.test.js` verifica timestamp, provenienza, snapshot
comuni, partizioni bookmaker, collegamenti univoci, alias e rifiuti.
