# Anteprima C senza registrare puntate — 31 ottobre 2026

## Comportamento e confini

La pagina Partite continua a calcolare A attraverso il percorso esistente. Se A
ha una decisione Nightly, mostra quella decisione archiviata. Il motore operativo
`PredictionService`, la sua calibrazione, mercati, filtri, ranking e stake non
sono modificati. La baseline research A80 non viene usata come anteprima di A.

Per C, il frontend legge prima l'archivio autenticato. Se la lettura riesce,
manca C e la partita è futura e non conclusa, richiede automaticamente la nuova
anteprima. Un errore nella lettura dell'archivio blocca il ripiego. Un consiglio
archiviato resta prioritario e non viene ricalcolato. A e C caricano separatamente:
un errore o un'attesa di C non impedisce la visualizzazione del consiglio A.

La scheda mostra **Anteprima C · non registrata**, eventuale giocata, bookmaker,
quota reale, orario e stake indicativo **1%**. Non mostra un importo addebitato.
Indisponibilità tecnica, partita non ammissibile e nessuna puntata consigliata
sono stati distinti. La scadenza nasconde il prezzo e permette un nuovo tentativo
manuale; non avvia richieste automatiche ripetute al provider.

## Contratto e origine

`POST /api/research/challenger-preview` usa la sessione amministratore e i
controlli di origine esistenti, accetta soltanto `{ "matchId": "…" }` e risponde
con `Cache-Control: no-store`. Il client non può scegliere orario, modello o quota.

Il servizio legge l'adozione C effettiva e blocca versione, revisione e selettore
per la durata del calcolo. Usa il percorso C operativo di `ResearchRuntime` e
`buildChallengerRecommendation`, senza eseguire `PredictionService` né calcolare
forecast research A80. Usa il momento corrente, non la scadenza storica T−15.
Artefatto e registrazione C richiedono timestamp espliciti, validi e non futuri.

Servono partita futura Top 5, squadre identificabili, quote autentiche
`odds_api` pre-match entro cinque minuti e condizioni del selettore operativo.
Letture fallite del registro, sospensione, quote mancanti/scadute o dati
insufficienti non vengono tradotti in un finto consiglio di non puntare.

La risposta include `kind=C_PREVIEW`, `family=C`, `registered=false`,
`suggestedStakePercent=1`, versione/revisione e scadenza. Non include identificatore
di puntata o azione di esecuzione. Le verifiche finali rileggono partita, adozione
e archivio prima della consegna, anche dopo cache o richieste condivise.

## Effetti ammessi e quote

Non vengono creati o modificati puntate, ledger, forecast, residui, osservazioni
prospettiche, job, adozioni o kickoff. Il percorso non avvia scheduler, rollback,
raccolta del candidato o diagnostica persistente del runtime research.
Le anteprime non allargano il campione di validazione prospettica di C.

Il gestore quote esistente può aggiornare **cache tecnica e contabilità API**:
non è quindi una promessa di zero scritture SQL. Le richieste sono informative,
entro il tetto configurato e rispettano la riserva Nightly. Il flag specifico
`CHALLENGER_PREVIEW_NETWORK_ENABLED=true` consente quote aggiornate; `false`
accetta soltanto cache fresca. Il flag informativo generale e A restano invariati.
Nessuna nuova chiave o fonte a pagamento è necessaria o introdotta.

La cache C dura al massimo 30 secondi, termina prima di kickoff/scadenza quote,
contiene al massimo 100 risultati e non conserva errori tecnici. Sono ammessi
al massimo due calcoli distinti simultanei; richieste identiche condividono il
calcolo. La decisione Nightly è ricontrollata prima di restituire un risultato.

## Verifiche e rilascio

I test dedicati coprono inferenza C senza effetti economici/research, modello
operativo bloccato, quote reali, stati di astensione e indisponibilità, corse con
Nightly/adozione/kickoff, cache/concorrenza, contratto HTTP, errori redatti e UI
indipendente da A. La regressione A confronta i sorgenti protetti e gli scenari
golden esistenti, senza modificarne hash o risultati attesi.

Il commit applicativo usa il marcatore `[c-preview-only]`: la sola integrazione
C nella route condivisa non deve avviare il workflow push di riscaldamento della
calibrazione A. L'avvio manuale e gli altri push mantengono il comportamento
precedente. Non è una disattivazione della Nightly o della CI.

I risultati completi di CI, prove browser/native e pubblicazione saranno riportati
qui al termine del rilascio. Il primo gate completo su Windows è stato interrotto
da `EPERM` nella rimozione di un database temporaneo del test preesistente
`research-recommendation-view.test.js`; i test mirati non hanno quel blocco.
Non viene dichiarato alcun miglioramento statistico o di redditività del modello.
