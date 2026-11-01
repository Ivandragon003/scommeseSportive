# Consigli A/C, interfaccia e risultati — 31 ottobre / 1 novembre 2026

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

La [CI completa su `4cc70896`](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41222605065)
supera 1.283 test backend, con un opzionale saltato, e 303 test frontend su 36 suite.
Comprende build, lint e typecheck. Il frontend viene ora testato anche in CI.
Il worktree Android pulito conferma 303/303: tre attese premature in due test sono
state corrette aspettando il nuovo URL o esito effettivo, senza cambiare le aspettative.
Sono protetti i 36 sorgenti A, sei scenari congelati e l'isolamento C/A; verificata
la parità C su cinque leghe. Docker isolato avvia frontend e backend, verifica
autenticazione e API senza provider reali; nessuno stack preesistente viene sostituito.

## Prova reale del 1 novembre

Il frontend pubblicato corrisponde ai 13 sorgenti runtime verificati, comprese le
route caricate separatamente. APK, frontend e primo backend usano `7e7728a0`;
`ff76c981` modifica solo test e `4cc70896` solo il workflow CI.

La Nightly completa `41297275582` termina alle 11:33 italiane: 14 partite valutate,
10 puntate virtuali, A5/C5. La successiva `41301723064` salta correttamente il lavoro
già eseguito. Tutte le otto giocate del 31 ottobre risultano liquidate; i sette
risultati prima mancanti concordano con la precedente verifica della fonte.
Le invarianti contabili non mostrano duplicati o errori di settlement.

Sassuolo–Fiorentina del 2 novembre, `understat_31658`, non ha alcuna decisione
Nightly A/C. La prima apertura reale restituisce A in circa nove secondi dopo C,
con quota Betfair 3,00 e stake 1,06%. C risponde HTTP 200 ma `UNAVAILABLE` dopo
circa 27 secondi: questo **non certifica** il funzionamento della sua inferenza.
La sola tabella modificata rispetto alla baseline è l'audit `predictions` di A:
nessuna nuova puntata, movimento, forecast prospettico o adozione.

Le letture dirette su Turso confermano identità, timestamp e hash dell'artefatto
C906, e tutti i campi della proiezione benchmark. Il log di A mostra una lettura
interrotta `UND_ERR_SOCKET`; l'origine socket del guasto C resta un'ipotesi.
Il percorso C riceve un solo ritentativo per letture modello/benchmark interrotte,
senza ripetere acquisizione quote, preparazione o calcolo A. Gli errori logici
restano bloccanti. La diagnostica interna riporta solo fase e codici ammessi.
Il gate locale aggiornato supera **112/112 test**; la prova C successiva al deploy
resta da completare prima di dichiarare risolta l'indisponibilità.

«Aggiorna risultati» importa realmente Como–Venezia 1–0 e il record Understat 30875 3–1,
e liquida due puntate esistenti. Le 24 identità delle bet restano invariate;
ledger e settlement aggiungono soltanto due liquidazioni. Cinque partite ancora
in corso causavano un falso stato PARTIAL: ora un `isResult=false` esplicito conta
come incontro lasciato in attesa. Valori mancanti o malformati restano rifiutati.
Non si inventano risultati né si liquidano le partite ancora aperte.

Le istantanee SQL e i log grezzi restano locali: contengono dettagli operativi che non
devono essere pubblicati. Questo intervento non misura né dimostra maggiore rendimento
sportivo dei modelli. Il controllo su telefono fisico resta distinto da emulatore e web.
