# Calendario e decisioni A/C — 30 ottobre 2026

## Problema verificato

Il recupero `41038096151` ha eseguito correttamente A/C su quattro incontri,
ma non ha coperto tutto il calendario del giorno. L'audit RO delle 10:46 UTC
trova Nice–Rennes (`understat_32017`) ancora il 31 ottobre alle 17:15 Roma.
Il [comunicato ufficiale del Nice](https://www.ogcnice.com/index.php/fr/article/131046/nice-rennes-avance-a-vendredi-19h.html)
del 26 ottobre anticipa la partita al 30 ottobre alle 19:00.

Il controllo reale `GET events` del provider, alle 10:53 UTC, conferma
`2026-10-30T18:00:00Z`: HTTP 200, costo zero, quota invariata 304/196.
La [documentazione ufficiale](https://the-odds-api.com/liveapi/guides/v4/#get-events)
specifica che questo endpoint non consuma crediti e non contiene quote.

| Partita | Orario Roma, 30 ottobre | Verifica prima della correzione |
| --- | --- | --- |
| Le Havre–Paris Saint-Germain | 19:00 | A/C valutati; astensione |
| Nice–Rennes | 19:00 | Esclusa: data DB rimasta al 31 ottobre |
| Elversberg–Mainz 05 | 20:30 | A/C valutati; astensione |
| Villarreal–Espanyol | 21:00 | A/C valutati; astensione |
| Lille–Lens | 21:05 | A/C valutati; astensione |

La finestra notturna non è spostata di un giorno: la mattina del 30 ottobre
valuta gli incontri futuri fino al 31 ottobre alle 03:07 Roma. Il quinto
incontro manca perché la data memorizzata è errata, non per una finestra
diretta al pomeriggio del giorno successivo.

## Quote disponibili e registrazione automatica

Per i quattro incontri valutati erano disponibili 58 quote reali negli
snapshot condivisi. Il consiglio della schermata pronostici e la Nightly
A/C usano selettori differenti: il consiglio visibile non implica una
registrazione automatica nei due portafogli.

A/C richiedono EV centrale almeno 4%, almeno 50 incontri distinti per
mercato e fascia di probabilità, e EV prudenziale almeno 1%. I campioni
sono separati per famiglia, versione e configurazione; devono avere un
risultato ufficiale disponibile prima della decisione. Il campione
prudenziale del recupero era zero. Alcune quote non superavano il valore
centrale; le altre non avevano ancora le evidenze richieste.

Le 58 osservazioni CALIBRATION congelate sono 29 per modello su quattro
incontri, non 58 partite concluse. Si raccolgono anche durante un'astensione:
non occorre piazzare puntate per costruire il campione. Nessuna soglia o
regola del modello viene abbassata per produrre una giocata.

## Correzione e recupero controllato

La patch collega l'endpoint già esistente di sincronizzazione kickoff alla
nightly: calendario Top 5 aggiornato dopo l'import Understat e prima della
selezione A/C, usando soltanto `GET events`. In caso di errore il gate dati
impedisce nuove decisioni operative; manutenzione e liquidazioni restano
preservate. Con A/C disabilitata non si aggiunge questa richiesta.

Il nuovo input manuale `recover_missing_fixtures`, disattivato per default,
serve a recuperare partite entrate nella finestra dopo una correzione del
calendario. Richiede una precedente elaborazione A/C completa e riuscita
nella giornata Roma e assenza di altri run attivi. Non cambia il comportamento
dei cron o degli avvii ordinari. Il vincolo persistente sugli input esistenti
esclude le partite già valutate prima di nuove inferenze o richieste quote.

Stato a questo checkpoint: patch e test in verifica, pubblicazione e recupero
reale di Nice–Rennes ancora da attestare. Nessuna puntata sul quinto incontro
è dichiarata registrata. L'audit successivo deve dimostrare cinque incontri
complessivi, dieci decisioni, immutabilità delle otto precedenti e saldi corretti.

Resta da osservare il primo trigger automatico del nuovo programma e il ciclo
con risultati ufficiali. La correzione del calendario non dimostra redditività
dei modelli né garantisce una puntata per ogni incontro.
