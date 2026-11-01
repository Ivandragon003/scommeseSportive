# Nome esatto delle giocate — 1 novembre 2026

## Problema e modifica

Giocate e Archivio trasformavano le selezioni registrate in sole descrizioni:
«Vittoria Torino» ometteva il segno `1`, «Torino o pareggio» ometteva `1X`.
La presentazione ora mantiene sia il nome della giocata sia la spiegazione.

| Selezione registrata | Presentazione |
| --- | --- |
| `homeWin` | 1 — Torino vincente |
| `draw` | X — Pareggio |
| `awayWin` | 2 — Squadra ospite vincente |
| `double_chance_1x` | 1X — Torino o pareggio |
| `double_chance_x2` | X2 — Squadra ospite o pareggio |
| `double_chance_12` | 12 — Una delle due squadre vince |
| `dnb_home` | DNB 1 — Torino; pareggio rimborsato |
| `dnb_away` | DNB 2 — Squadra ospite; pareggio rimborsato |
| `over25` / `under25` | Over 2.5 gol / Under 2.5 gol |

I nomi delle squadre derivano dalla partita archiviata; se assenti si usano
«squadra di casa» e «squadra ospite». Nessun nome viene ricavato dall'identificativo.
Le sigle riguardano esclusivamente la presentazione: non cambiano selezione,
quota, stake, risultato o liquidazione registrati. Nessuna modifica al backend,
al metodo A operativo, al modello C o alla Nightly.

Il Torino registrato in Frosinone–Torino è `dnb_away`: la presentazione corretta
è «DNB 2 — Torino; pareggio rimborsato», non `X2`. Quote e importi non cambiano.

Le soglie gol compatte, intere e decimali vengono distinte: `under275` significa
Under 2.75, `under3` significa Under 3 e `team_home_over_15` Over 1.5 gol della
squadra di casa. Le soglie statistiche seguono il proprio formato; i punti
cartellino restano distinti dai soli gialli. Non vengono attivati nuovi mercati.
Le soglie usano il punto decimale come nei nomi dei mercati bookmaker; importi
e quote conservano la formattazione italiana già presente.

Gli handicap mostrano tipo, esito, squadra e aggiustamento soltanto quando la
quota archiviata conserva mercato, lato e linea coerenti con la selezione.
Gli alias asiatici A/C hanno convenzioni diverse: senza quei dettagli la UI
segnala «dettaglio non disponibile», senza dedurre o invertire un segno.

## Verifica e distribuzione

Superati 74 test mirati su cinque suite, typecheck e lint frontend. I test
distinguono vittoria, doppia chance e DNB, controllano soglie intere e quarti,
statistiche e segni handicap. Il test della pagina conserva quota e importo
registrati e verifica l'assenza di chiamate di puntata.

Il commit runtime è `5fd5d7b2abce8d9a7b7ec0b687d31a2f78f97ffd`.
La [CI](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41328991910)
supera 363 test frontend e 1.305 backend, con un opzionale saltato, oltre a build,
lint e typecheck. Il primo tentativo backend aveva un errore `ENOTEMPTY` nella
pulizia della fixture di backup; il secondo, sullo stesso sorgente, passa.
Non si considera corretta quella possibile instabilità: non è stata modificata
nel task delle etichette. L'intero backend è identico a quello precedente.

Il frontend Hostless `6ae76fbdd25b7a9e9970a6fd` risulta **Deployed LIVE** dal
commit indicato. Alle 17:06:24 UTC i 15 sorgenti runtime interessati corrispondono
a quelli pubblicati nelle 13 source map JavaScript, comprese le route separate.
Asset principale: `main.fcea6569.js`, SHA256
`454f3d72185cd7ab17b4cc37a9b1aa1e73c9aa0745038cfa37dd44dcb20bcc38`.

La prova browser autenticata mostra effettivamente «Under 2.5 gol» su
Frosinone–Torino C, «DNB 2 — Torino; pareggio rimborsato» su A,
«Under 3.5 gol» su Strasbourg–Auxerre e «X — Pareggio» su Lazio–Cagliari.
Alle 17:06:48 UTC tutte le **24 righe delle giocate**, comprese quote, importi,
esiti e fonte, coincidono esattamente con la lettura precedente al deploy;
anche disponibile, impegnato e patrimonio dei due portafogli sono identici.
La cattura contiene solo GET alle API di sessione, stato e portafogli, senza
richieste fallite o chiamate di analisi, registrazione o liquidazione.
Screenshot prima/dopo e risposte integrali restano locali.

Il [pacchetto Android 1.1.8](../android/releases/1.1.8-2026-11-01.md), codice 10,
contiene gli stessi sorgenti verificati, con 363 test e parità dei 23 asset.
Un deploy web non aggiorna gli asset della 1.1.7: per le nuove etichette su
telefono occorre installare il nuovo APK. La firma rimane quella debug esistente;
telefono fisico e login Android autenticato non sono stati verificati.
