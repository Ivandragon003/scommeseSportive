# Consigli A/C nel dettaglio partita — 31 ottobre 2026

Aprire una partita mostra due schede separate, Modello A e Modello C. Il frontend
legge `GET /api/research/forecasts?matchId=…` usando la sessione autenticata esistente.
L'endpoint restituisce le decisioni effettive dopo recuperi e cancellazioni. La
schermata non registra puntate, modifica saldi o chiama provider per ottenere C.
L'analisi A preesistente continua a funzionare come prima.

## Origine e significato

- Solo le righe `authority=execution` rappresentano questi consigli operativi.
  A80 e le altre righe research `legacy` non sono il metodo A dell'app.
- Una decisione archiviata prevale sull'analisi aperta successivamente. Prezzo e importo
  provengono dall'archivio: l'importo non viene ricalcolato usando il saldo corrente.
  Il planner dello stake attuale rimane nascosto quando è disponibile la decisione A
  archiviata, anche se la risposta dell'analisi A non contiene ancora tale proiezione.
- Se A non ha un archivio valido, viene mantenuta la scheda A esistente, con origine
  esplicita: analisi attuale o replay retrospettivo. I calcoli A non vengono modificati.
- C usa soltanto il suo pacchetto Nightly archiviato. Se manca, compare “Consiglio non
  ancora disponibile”: non equivale a un consiglio di non puntare. Non esiste una nuova
  inferenza C eseguita aprendo questa pagina.
- Un pacchetto valido senza selezione rappresenta nessuna giocata consigliata.
  Un errore tecnico rappresenta invece una valutazione non utilizzabile.
- Un consiglio positivo bloccato da esposizione, capitale o unicità della puntata
  rimane visibile come consiglio del motore, con importo registrato zero e motivo del blocco.
  Pacchetti positivi rimasti dopo errori tecnici non vengono presentati come consigli validi.
- La quota viene mostrata solo se selezione, prezzo, bookmaker e provenienza corrispondono
  ai dati conservati; quote sintetiche o incoerenti restano non disponibili.
- `SETTLED` significa liquidata: questa API non espone il verdetto vinta/persa e la
  schermata non lo deduce dal solo stato.

Le schede si impilano su telefono. Il caricamento dell'archivio è indipendente
dall'analisi A: un errore o ritardo di A non nasconde C. Cambiare partita annulla la
richiesta precedente e impedisce che una risposta tardiva riappaia sul nuovo incontro.
“Aggiorna” rilegge anche l'archivio; gli errori rimangono visibili e hanno un comando di ritento.

## Verifica ripetibile

```powershell
cd frontend
$env:CI='true'
npm run test:ci -- --runInBand
npm run typecheck
npm run lint
npm run build
```

Regressioni backend di A, senza modificarne sorgenti o fixture:

```powershell
cd backend
npm run build
node --test test/operational-a-regression.test.js
git diff 22903c83 --exit-code -- backend
```

I test frontend coprono consigli diversi, fonte A corretta, dati mancanti, errori,
quote incoerenti, blocchi contabili e cambi di partita. I test di pagina verificano
anche C disponibile mentre A è in attesa o fallisce e ricaricamento senza mutazioni.
Le prove browser con fixture controllano il flusso e il layout; non dimostrano
una nuova acquisizione bookmaker o il login su un telefono fisico.
