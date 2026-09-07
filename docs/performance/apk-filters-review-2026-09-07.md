# Filtri Android e release 1.1

- Budget: sei pulsanti su due righe sui telefoni; a 320 px tutti sono visibili e alti 44 px.
- Intervalli del grafico riferiti al giorno corrente, con movimenti ordinati per chiusura (fallback alla data di inserimento). Date mancanti o non valide escluse; periodi senza movimenti esplicitati.
- Select e date usano controlli HTML nativi anche nella WebView Android, evitando menu ritagliati e date inserite con tastiera numerica.
- Giocate: cambio vista ed esito non lasciano filtri contraddittori; pannello date contenuto nella larghezza mobile.
- Versione Android 1.1, versionCode 2. Script mobile:sync documentato.

## Verifiche

- 21 test mirati passati; typecheck e build produzione frontend passati.
- Docker backend/frontend ricostruiti; health backend ok.
- Browser isolato con risposte API simulate: layout 320 px, selezione Tutto/7G e input date verificati. Nessuna scrittura sul bankroll reale; nessun telefono fisico collegato.
- Suite completa: 114 passati, 10 falliti in quattro suite (App, Predictions, PredictionArchivePage, ScrapersPageView). Controllo separato sul commit precedente 7e3ac268: le stesse quattro suite falliscono (114 passati, 6 falliti); conteggi variabili per problemi asincroni. La suite completa non e verde e questi problemi preesistenti restano fuori dalla correzione dei filtri.
