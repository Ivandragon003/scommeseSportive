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

La verifica completa del pacchetto e gli identificativi di pubblicazione vengono
completati dopo il controllo della pagina realmente servita. La nuova UI Android
richiede l'APK 1.1.8, codice 10: un deploy web non aggiorna gli asset della 1.1.7.
