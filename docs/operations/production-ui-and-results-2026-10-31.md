# Consigli A/C, interfaccia e aggiornamento risultati — 31 ottobre 2026

## Obiettivo e confini

Aprire una partita futura senza archivio Nightly deve mostrare la valutazione dei due
motori, senza creare giocate. A resta `PredictionService`: nessuno dei 36 sorgenti
protetti, dei suoi risultati congelati o dei suoi parametri viene modificato.
Le puntate restano virtuali. C906 resta il modello C operativo.

## Problemi osservati prima delle correzioni

- Como–Venezia (`understat_31653`), senza analisi Nightly: A impiega circa 157 secondi
  al primo calcolo; la schermata interrompe l'attesa dopo 120. C richiesto insieme
  supera il limite di attesa. Un successivo tentativo C isolato risponde HTTP 200.
  La concorrenza è una causa plausibile; non è stata dimostrata una memoria esaurita.
- L'apertura non aggiunge puntate o movimenti. A salva il normale audit delle
  previsioni: questa operazione non è una consultazione SQL interamente in sola lettura.
- Alle 16:32 UTC sette partite concluse avevano ancora risultato nullo nel database,
  nonostante il risultato finale e gli xG fossero disponibili su Understat. Quattro
  puntate virtuali già esistenti su tre di queste partite attendevano la liquidazione.
- Una partita iniziata ma priva di risultato spariva sia dagli incontri futuri sia
  dai conclusi. Il filtro giorno poteva anche persistere cambiando campionato.

Milan–Inter è il **31 ottobre 2026 alle 20:45 italiane**, non il giorno seguente:
database, Understat e [pagina ufficiale Milan](https://booking.acmilan.com/serie-a/milan-inter/)
concordano. La partita era già stata analizzata. A aveva proposto Over 4.5 ma era
stato fermato dal limite di esposizione; C si era astenuto per un payout non binario
non supportato dal suo motore canonico. Non vengono forzate nuove giocate o riscritte
quelle decisioni. La vecchia visualizzazione «domani» non è stata riprodotta.

## Correzioni

- Coordinamento: archivio C, eventuale anteprima C, poi calcolo A; cancellazione e
  risposte tardive gestite anche tornando a una partita già in cache. Input A invariati.
- Attesa A/replay a 240 secondi; proxy Docker a 270. Cache C di 30 secondi distinta
  dalla validità del consiglio: massimo cinque minuti, comunque entro kickoff e
  freschezza delle quote. Nessun rinnovo automatico delle quote.
- Proiezione del profilo di calibrazione C invece dell'intero report benchmark;
  cache del solo artefatto C immutabile, con controllo dei metadati a ogni accesso.
  Dataset delle cinque leghe e calcoli C restano equivalenti nei test di parità.
- Interfaccia principale: Partite, Giocate, Budget, Archivio, Dati e aggiornamenti.
  Consiglio, quota reale e bookmaker, importo, risultato ed esito restano visibili.
  Formule, versioni, filtri e ricerca restano interni; route tecniche conservate.
- La lista web può includere incontri iniziati senza risultato nelle ultime 72 ore.
  Questa opzione non cambia la selezione predefinita usata dalla Nightly.
- «Aggiorna risultati» importa soltanto finali Understat verificati e liquida solo
  puntate già registrate con il motore di settlement esistente. Nessun nuovo bet,
  calcolo A/C, recupero di astensioni o aggiornamento della calibrazione.
  Identità, kickoff e stagione sono confrontati; aggiornamento atomico e idempotente.
- Lo stato sintetico usa osservazioni salvate e non confonde scheduler web disabilitati
  con GitHub Actions. Un'esecuzione A/C più recente fallita non eredita il successo
  precedente. Conteggi non associabili allo stesso intervallo restano indisponibili.

## Verifica

Prima delle ultime regressioni di revisione: backend 102/102 e frontend 313/313.
I controlli includono sorgenti A congelati, sei scenari A, isolamento C/A, parità C
su cinque leghe, scadenza/cache, cancellazione UI, aggiornamenti risultati e rifiuto
di input client che tentano di creare puntate. I conteggi finali, la versione pubblicata
e la verifica successiva al deploy saranno aggiunti dopo l'esecuzione effettiva.

Le istantanee SQL e i log grezzi restano locali: contengono dettagli operativi che non
devono essere pubblicati. Questo intervento non misura né dimostra maggiore rendimento
sportivo dei modelli. Il controllo su telefono fisico resta distinto da emulatore e web.
