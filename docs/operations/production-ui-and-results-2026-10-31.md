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

La prima pubblicazione corrispondeva ai 13 sorgenti runtime di `7e7728a0`, comprese
le route caricate separatamente. La pubblicazione finale web, backend e APK usa
`0e655c47`: verificati tutti i 14 sorgenti runtime interessati nelle source map
effettivamente servite. `ff76c981` modifica solo test e `4cc70896` il workflow CI.

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
Il gate locale aggiornato supera **112/112 test**. La
[CI `bd6a291c`](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41322206324)
supera 1.290 test backend, un opzionale saltato e 303 frontend.

Il backend `bd6a291c` è stato pubblicato il 1 novembre. La nuova prova C reale è
**RECOMMENDED**: Under 2.5, Betsson 2,48, artefatto originale
`C-906371b0b3a1e2c8`, forecast 15:47:34 UTC, quota aggiornata alle 15:46:34,
scadenza 15:51:34, `registered=false`. Il log documenta proprio
`challenger_preview_read_retry`, fase `benchmark`, codice `UND_ERR_SOCKET`:
la lettura al secondo tentativo permette di completare il calcolo. Il primo
guasto generico non aveva questo dettaglio; il secondo documenta il problema reale.

### Limite Cloudflare e trasporto A

La successiva richiesta A riceve **HTTP 524 dopo 125,760449 secondi** (CDP),
nonostante l'attesa client di 240. A completa il proprio calcolo e salva i normali
225 record di audit; le bet restano 24 e il ledger 42. Il gateway ha perso la
risposta, senza dimostrare un errore matematico di A. La
[documentazione ufficiale Cloudflare](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)
descrive il limite di 125 secondi e indica il recupero periodico dello stato come soluzione.

La nuova UI usa `POST /predict/jobs` e `GET /predict/jobs/:id`: ciascuna richiesta
è breve, il risultato conserva esattamente il percorso originale
`PredictionService.predict` → decisione A archiviata → formato e proiezione A.
Nessun campo di input viene aggiunto o filtrato. Stessa istanza e stessi errori
originali 400/503; il vecchio endpoint sincrono rimane disponibile.
Un solo lavoro asincrono distinto è attivo, richieste identiche condividono il
risultato, fino a otto risultati restano in memoria per al massimo dieci minuti
dal completamento. Un riavvio li perde: il client segnala l'interruzione senza
ricalcolare automaticamente. Annullare la schermata ferma le letture, non A.
Nessun nuovo worker, motore, provider, schema o processo esterno.
Il replay manuale conserva il percorso precedente.

I test HTTP confrontano risposte complete sincrone/asincrone, incluse decisioni
archiviate BET/ABSTAIN, input, errori e namespace. I test client simulano più di
125 secondi con un solo POST, cancellazioni e letture interrotte.

### Esito finale su web e Android

Il 1 novembre, alle 17:43 italiane circa, Sassuolo–Fiorentina mostra insieme:

| Motore | Consiglio dell'anteprima | Quota reale | Stake indicativo |
| --- | --- | --- | --- |
| A operativo | Vittoria Sassuolo | Betfair 3,00 | 1,07% |
| C906 originale | Under 2.5 | Betsson 2,48 | 1% |

La partita resta priva di decisioni Nightly prima e dopo l'apertura. Il consiglio
C è valutato alle 16:41:07 UTC, quota aggiornata alle 16:40:21 e scadenza alle
16:45:21; `registered=false`. Per A la fonte non espone il timestamp della quota
nel payload disponibile: la UI scrive «Orario non disponibile», senza inventarlo.
Questo limite riguarda la tracciabilità dell'orario mostrato, non autorizza a
modificare il modello A.

A viene avviato **una sola volta**, HTTP 202, e recuperato con 40 letture GET.
Il risultato finale è `COMPLETED`, risposta originale HTTP 200, dopo circa
**157 secondi** dall'avvio: supera realmente il precedente limite del gateway.
Nessuna richiesta fallita nella cattura e nessuna chiamata di registrazione bet.
Lo screenshot finale mostra entrambi i consigli e le diciture «non registrata».

La seconda istantanea SQL, terminata alle 16:45:57 UTC, confronta 25 tabelle
operative e i conteggi dell'audit A. Le identità delle **24 bet**, i **42 movimenti**,
le **16 liquidazioni**, saldi e capitale impegnato restano invariati; nessun nuovo
forecast prospettico, candidato o adozione. Cambia soltanto `predictions`, da
207.832 a 208.057, normale audit del calcolo A. Nessuna puntata è stata aperta
durante la prova.

Backend Hostless `6ae7663e296f08c462b1134c` e frontend
`6ae7693cb11ccfd0ad8137e6` servono il sorgente finale `0e655c47`; health API
`status=ok`. La verifica dei sorgenti frontend pubblici è terminata alle
16:39:18 UTC. Risorse, configurazione dei provider e schedulazione non cambiano.

La [CI finale](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41324758349)
supera **1.305 test backend**, un opzionale saltato, e **329 test frontend** su
37 suite, oltre a build, lint e typecheck. Restano intatti i 36 hash sorgente A,
i sei casi congelati e l'isolamento C/A. La preparazione della calibrazione A
è intenzionalmente saltata dal marcatore del commit, senza disabilitare il workflow.

Docker isolato verifica build, avvio, autenticazione, health diretto e tramite
proxy e contratto HTTP asincrono senza chiamare provider reali. Il confronto
sincrono/asincrono sullo stesso database QA mantiene 28 campi API e sei campi
canonici; non dichiara identità bit per bit fra chiamate distinte: UUID, clock e
hash che include l'incertezza bootstrap possono cambiare. I test congelati
controllano invece la regressione A con casualità fissata.

L'[APK 1.1.7](../android/releases/1.1.7-2026-11-01.md) usa gli stessi sorgenti
frontend finali. Build, firma originale debug, parità dei 23 asset, aggiornamento
da 1.1.6 e due test strumentali su emulatore sono verificati. Il browser mobile
a 390 pixel mostra le schede A/C impilate, senza scorrimento orizzontale.
Login autenticato nell'APK e telefono fisico non sono stati verificati.

«Aggiorna risultati» importa realmente Como–Venezia 1–0 e il record Understat 30875 3–1,
e liquida due puntate esistenti. Le 24 identità delle bet restano invariate;
ledger e settlement aggiungono soltanto due liquidazioni. Cinque partite ancora
in corso causavano un falso stato PARTIAL: ora un `isResult=false` esplicito conta
come incontro lasciato in attesa. Valori mancanti o malformati restano rifiutati.
Non si inventano risultati né si liquidano le partite ancora aperte.
Una seconda prova reale alle 17:04 italiane restituisce `SUCCESS`, zero nuovi
risultati e zero liquidazioni, senza il falso avviso. Ogni refresh effettua una
nuova richiesta HTTP Understat; `observedAt` indica l'osservazione della risposta,
non il momento di pubblicazione alla fonte. La cache a monte della fonte o del
suo CDN non è verificata: un incontro non finale resta in attesa.

Le istantanee SQL e i log grezzi restano locali: contengono dettagli operativi che non
devono essere pubblicati. Questo intervento non misura né dimostra maggiore rendimento
sportivo dei modelli. Il controllo su telefono fisico resta distinto da emulatore e web.
