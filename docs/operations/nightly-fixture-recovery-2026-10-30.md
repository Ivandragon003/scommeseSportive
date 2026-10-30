# Calendario e decisioni A/C — 30 ottobre 2026

## Stato verificato dopo il recupero

Il [run `41044931407`](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41044931407)
è SUCCESS alle 11:08:12 UTC / 12:08:12 Roma, revisione `fd97d145`.
La CI `41044683537` della stessa revisione è SUCCESS sia Backend sia Frontend.
47 test mirati e la revisione indipendente sono passati, senza abbassare
soglie o modificare i modelli. La modifica riguarda workflow, guard e shell
GitHub: backend Hostless `01320941` e frontend `fb0e30f8` restano LIVE.

Il calendario ha controllato 800 incontri futuri e aggiornato 43 orari,
incluso Nice–Rennes al 30 ottobre alle 19:00 Roma. Cinque chiamate calendario
sono riuscite con costo zero. La nuova elaborazione A/C, dalle 11:07:41 alle
11:08:04 UTC, ha valutato soltanto Nice–Rennes: un input, due decisioni,
zero puntate, errori o partite perse. Le altre quattro sono escluse con
`decision_already_recorded`, prima di nuove richieste quote o inferenze.

L'audit RO delle 11:10:02 UTC è PASS: cinque input, dieci decisioni e dieci
verifiche d'inferenza A/C complessive. I quattro input e le otto decisioni precedenti
conservano identità e digest registrati; tutti i sette hash finanziari sono
identici ai baseline. Restano 258 giocate legacy e due portafogli virtuali
indipendenti da 1.000 euro, zero impegnati.

La dashboard autenticata è stata ricaricata: mostra cinque partite confrontate
e il registro con dieci decisioni A/C, incluse le due nuove delle 12:07 Roma.

Nice dispone di 17 quote reali, fonte `odds_api`, bookmaker Codere (IT),
BetOnline.ag, Coolbet, GTbets, Marathon Bet e Pinnacle. L'età massima
dell'aggiornamento al freeze è 72,647 secondi. A e C producono distribuzioni
diverse e coerenti, ma si astengono: A ha 14 quote sotto soglia EV e tre
senza calibrazione sufficiente; C rispettivamente dodici e cinque. Il
campione prudenziale resta zero per entrambi.

Sono congelate 16 nuove osservazioni CALIBRATION, sette A e nove C: totale
74 su cinque incontri, non 74 partite indipendenti. Zero FUTURE_TEST,
risultati ufficiali e liquidazioni. Una nuova acquisizione quote ha consumato
tre crediti inclusi: usati 304→307, residui 196→193. Nessun altro caller
rilevato nell'audit, nessun servizio o piano a pagamento aggiunto.
Il watchdog indipendente successivo, `41045882229`, è SUCCESS.

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

Pubblicazione, recupero e audit sono completati come riportato sopra.
Non è stata forzata alcuna puntata sul quinto incontro.

Resta da osservare il primo trigger automatico del nuovo programma e il ciclo
con risultati ufficiali. La correzione del calendario non dimostra redditività
dei modelli né garantisce una puntata per ogni incontro.
