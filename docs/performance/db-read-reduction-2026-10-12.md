# Pausa giocatori e riduzione letture — 12 ottobre 2026

## Decisione e implementazione

Su richiesta dell'utente, `PLAYER_DATA_ENABLED` è false per default. Nessuna
tabella o riga storica viene eliminata. Import giocatori, ricostruzione delle
statistiche derivate, letture delle rose nel predittore, endpoint giocatori,
copertura giocatori e player props sono sospesi. I mercati `player_*` vengono
esclusi dalle richieste quote. Le formazioni richiedono anche il flag master:
un vecchio flag availability true non aggira la pausa.

Il frontend nasconde sezioni giocatore/props/formazioni e disabilita il relativo
import. Gli APK precedenti ricevono risposte disabilitate dagli endpoint dopo
il deploy backend, ma conservano la vecchia interfaccia fino a una nuova build.
I dettagli partita Understat restano importati per le statistiche squadra;
possono contenere dati grezzi giocatore. Il settlement dello storico resta disponibile.
Senza rose il contesto e la confidenza delle previsioni possono cambiare;
non si dichiara equivalenza numerica con le previsioni precedenti.

## Partite

- Una lettura iniziale per lega/stagione: gli ID confermati dal batch completano
  la verifica senza rileggere tutta la stagione. I commit parziali includono
  soltanto le scritture confermate. La copertura obbligatoria resta verificata.
- Le medie vengono ricalcolate sulle squadre delle partite concluse modificate,
  senza ricalcolare tutte le squadre della lega. La retention ricalcola tutte
  le squadre per rimuovere dai derivati lo storico eliminato.
- Cache in memoria di 10 minuti per riepilogo e copertura storica squadra,
  con condivisione delle richieste concorrenti, copie isolate dei risultati e
  invalidazione locale. Le modifiche da altri processi sono visibili entro la
  scadenza; processi diversi hanno cache diverse.
- Selezionare una squadra nella UI non ricarica più elenco squadre e riepilogo.

La regressione Understat verifica cinque letture stagionali anziché dieci per
una lega e il ricalcolo delle sole due squadre modificate. È una misura del
percorso applicativo, non del contatore di righe Turso. Restano letture per
modello, arbitri, supplemento, quote, settlement e storico partite.

## Produzione e limiti

Il fallimento osservato dell'11 ottobre è un blocco esplicito delle letture SQL,
non una prova di corruzione del DB. Ripristinare i dati non certifica la
disponibilità delle letture. Il numero di utenti non misura il lavoro nightly.
L'utente conferma successivamente che il blocco è risolto: l'intervento serve
ora a conservare le letture disponibili. Su sua richiesta la cache passa a
10 minuti, senza avviare sync di produzione solo per misurare il consumo.
Occorre pubblicare codice/frontend/workflow e riavviare il backend con
`NIGHTLY_ORCHESTRATOR=github_actions` per evitare scheduler duplicati. Le
modifiche locali non cambiano i processi già distribuiti.

Misurare le righe lette nel pannello Turso prima e dopo un run effettivo e
controllare il motivo del blocco dell'account. Non è stata interrogata la quota
di produzione, quindi non viene promessa la risoluzione del limite free tier.
Per riattivare i giocatori usare `PLAYER_DATA_ENABLED=true` e ricompilare con
`REACT_APP_PLAYER_DATA_ENABLED=true`; le formazioni richiedono anche i rispettivi
flag availability. Non serve reimportare lo storico conservato per annullare la pausa.

## Verifiche

- Backend: build riuscita; suite completa seriale 520/520, dopo un primo run
  concorrente con un errore di processo nel file prediction-migration. Il file
  isolato passa 16/16 senza errori di asserzione. Typecheck e lint riusciti.
- Frontend: 131/131 test, typecheck, lint e build produzione riusciti.
- Regressioni: endpoint vecchi senza accessi giocatore/provider, esclusione
  quote player, cache/concorrenza/invalidazione e import con commit parziali.
- Avvio Node con libSQL locale temporaneo: healthcheck, endpoint giocatori,
  GET/POST availability e riepilogo verificati. I vecchi flag availability e
  collector true non aggirano il master false; tutti gli scheduler restano
  disabilitati con orchestratore GitHub. Processo fermato dopo la verifica.
- Sintassi Bash e `git diff --check` riusciti. Docker Desktop non disponibile:
  nessuna verifica completa Compose.
- Nessuna connessione al DB di produzione o chiamata provider per la verifica.
- Dopo l'aumento della cache: build backend, lint e 33 test mirati superati,
  incluso il test della durata predefinita di 10 minuti e della scadenza.
- Android: `mobile:sync` e `:app:assembleRelease` riusciti. APK 1.1.2, codice 4,
  firma v2 verificata con apksigner e versione/package verificati con aapt.
  Copia locale in `artifacts/FootPredictor-1.1.2.apk`, esclusa da Git.
  Nessuna verifica su telefono fisico in questa sessione.
