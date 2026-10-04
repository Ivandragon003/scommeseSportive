# Integrità della validazione applicativa — 4 ottobre 2026

Implementazione del solo primo punto del report GitHub: correggere la validazione
esistente prima di valutare nuovi algoritmi. Nessun de-vig power/Shin, modello
bayesiano, nuovo provider o sblocco di mercati è incluso.

## Garanzie temporali

- Il training e gli aggregati pre-match includono soltanto partite con esito
  disponibile: kickoff + due ore. Le partite simultanee e quelle ancora in corso
  non diventano precedenti solo perché compaiono prima nell'array.
- Gli xG realizzati del target non entrano nella previsione. Dove disponibili,
  gli xG attesi provengono dai precedenti nel relativo campo; il training può
  usare gli xG di partite concluse. Il contesto viene ricostruito in memoria.
- Il fitting storico usa un riferimento temporale esplicito, senza modificare
  l'orologio globale. I pesi temporali non dipendono dalla data odierna durante
  la ricostruzione di un vecchio fold.
- La calibrazione del backtest usa previsioni fuori campione dei fold precedenti,
  con etichette già disponibili. Lo stesso principio vale per apprendere i pesi
  del confronto con il mercato. Il primo fold senza evidenza mantiene il fallback
  identità/euristico, senza fit sulle proprie etichette.
- Le recensioni post-match attuali non forniscono una cronologia affidabile della
  disponibilità: il backtest non applica il loro tuning corrente al passato.

## Calibrazione runtime

Il precedente replay del modello attuale sui risultati storici è sostituito da
forecast cronologici. Si ricostruiscono Dixon–Coles e Poisson-xG dal solo passato,
separatamente per competizione, con refit settimanale e fino a 450 target recenti.
Servono almeno 30 precedenti disponibili; i campioni deboli mantengono i fallback
già previsti. Le soglie per famiglia restano quelle della configurazione esistente.

Un whitelist pre-match impedisce al target di portare xG, tiri, cartellini o
risultato realizzato nel predittore. I dati di risultato vengono usati dopo per
costruire le etichette. I pareggi DNB sono push e non diventano sconfitte binarie;
statistiche mancanti non sono convertite in zero. I booking points usano gialli
+ 2 × rossi.

L'apprendimento del blending usa le quote d'ingresso e probabilità calibrate con
etichette antecedenti al relativo forecast. Non usa la curva finale per valutare
i suoi stessi campioni e non sostituisce le quote d'ingresso con quelle di chiusura.

Lo storico è caricato una sola volta per profilo, gli aggregati sono calcolati in
memoria. Restano cache di sei ore e deduplicazione dei caricamenti concorrenti;
il fit del modello invalida la cache pertinente. Non sono aggiunte query o
scritture DB per ogni forecast. La prima ricostruzione richiede più CPU del replay
precedente; le richieste successive riusano il profilo.
Un controllo di generazione impedisce ai caricamenti iniziati prima del fit
di ripopolare cache obsolete o di sostituire i nuovi caricamenti concorrenti.

Gli export storici sono riusati anche tra cutoff differenti: cache condivisa per
competizione (massimo otto export, TTL sei ore), con caricamenti concorrenti
deduplicati. I profili distinti restano limitati a 32 entry con rimozione degli
scaduti e riuso LRU, evitando una lettura completa DB per ogni replay storico.
Il replay ordinario continua a usare modello e statistiche squadra correnti:
è retrospettivo, non un backtest OOS integrale; la garanzia temporale qui riguarda
il nuovo percorso di calibrazione e il backtester ufficiale.

La ricostruzione runtime cede il controllo all'event loop tra batch di forecast e
tra fit delle curve, evitando di bloccare tutte le richieste per l'intera durata
del profilo. Il primo caricamento resta più lento del riuso dalla cache.
Le richieste frontend di prediction/replay hanno un timeout dedicato di due
minuti; il proxy Docker lascia 150 secondi per queste sole route. Questo margine
non elimina eventuali limiti del proxy esterno di deployment.

## Quote e copertura

Gli snapshot di ingresso devono avere quota reale non vuota, provenienza valida,
timestamp interpretabile e kickoff noto, e devono precedere il kickoff. La
chiusura deve appartenere allo stesso bookmaker e cadere tra ingresso e kickoff.
Quote sintetiche/completate restano escluse dai risultati economici ufficiali.

Non esiste un timestamp storico della decisione per ogni partita: l'ingresso
è l'ultimo snapshot valido prima del kickoff. Questo non certifica che fosse
disponibile un'ora prima. Date senza orario non vengono usate per inventare
timestamp dei bookmaker. I CSV football-data conservano le semantiche distinte
di apertura/chiusura e timestamp assenti; le medie di mercato non dimostrano
eseguibilità presso un singolo bookmaker.

## Metriche e compatibilità

`backtest-engine-v5-oos` distingue i nuovi risultati dai report precedenti;
le formule del modello e la selezione dei mercati non sono nuovi esperimenti.
Il campo additivo `probabilityMetrics` descrive previsioni ed esiti indipendentemente
dall'EV, dalle quote o dalla scelta di giocare. Le osservazioni complete restano
interne alla ricostruzione: `includeProbabilityObservations: true` è un opt-in
del motore per gli harness di analisi. API e persistenza ordinarie conservano le
metriche aggregate, evitando di salvare o rileggere migliaia di righe diagnostiche.

La famiglia primaria goal comprende sette eventi: homeWin, draw, awayWin,
over15, over25, over35, btts. Cartellini/booking points, gialli, tiri e tiri in porta
hanno metriche separate: valori assoluti fra famiglie non sono intercambiabili.
La LL/Brier principale riguarda queste previsioni goal; metriche sulle singole
giocate restano diagnostica della selezione, con una popolazione diversa.

Le osservazioni distinguono `raw`, `calibrated` e `blended`. La metrica principale
usa il blending corrente prima dei filtri EV/confidenza; senza una quota reale
ammessa il valore resta quello calibrato. I report conservano `probabilityMetrics`
separata dalla diagnostica delle giocate filtrate; Top 5 aggrega per numero di
osservazioni, anche per le leghe senza giocate.

ROI resta profitto/totale puntato, con solo quote reali ammesse. Nessuna quota
reale implica nessuna giocata economica, ma non impedisce di misurare le
probabilità. Fold sovrapposti non devono contare ripetutamente la stessa partita.
Il numero di mercati ammessi dalla strategia prudente preesistente resta invariato;
la scelta unica `singleBestAlways` continua a essere misurata separatamente.

Il backtest applicativo usa finestre di fixture configurabili e parte con
calibrazione identità nel primo fold, se manca evidenza OOS antecedente. Il retest
offline aveva invece 450 forecast di riscaldamento per lega e refit settimanali:
le garanzie di separazione temporale sono allineate, ma i campioni/finestre non sono
identici e non si confrontano direttamente le metriche assolute.

Il retest offline pubblicato il 3 ottobre aveva già escluso gli xG del target e
separato la calibrazione OOS: questa modifica corregge il percorso applicativo,
non riscrive quei risultati né promuove varianti precedentemente scartate.
Un miglioramento dell'integrità può ridurre rendimenti apparenti: non equivale
alla dimostrazione di maggiore profitto.

## Verifica

Regressioni mirate verificano esclusione di dati futuri e simultanei, disponibilità
degli esiti, forecast invarianti agli xG del target, scoring senza giocate, cutoff
delle quote, coerenza bookmaker, cache e timestamp di fitting storico. La verifica
usa dati locali e DB finti: nessun accesso a provider o database di produzione.
Suite completate: 507 test backend e 130 frontend, typecheck e lint di entrambi.
Build e healthcheck sono verificati con Docker e libSQL locale isolato, con
scheduler automatici disattivati; nessuna connessione al Turso di produzione.

Prova locale di costo runtime, con 3.000 partite sintetiche, 450 target,
fitting DC/Poisson effettivo e fixture di quote 1X2 per il blending: circa 18,4 s
per il profilo iniziale, 0,061 ms per quello in cache, una lettura dello storico.
Durante il caricamento asincrono sono progrediti 179 heartbeat dell'event loop
(intervallo richiesto 50 ms; massimo gap osservato 352 ms). Sono misure di questo
host e di un dataset sintetico, non SLA né evidenza di miglioramento predittivo.
La prima richiesta può quindi richiedere tempo, pur mantenendo reattività e
riuso del lavoro nelle richieste successive.
