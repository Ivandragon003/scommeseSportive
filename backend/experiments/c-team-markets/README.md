# Audit diagnostico dell'archivio C e A

Questo esperimento verifica la disponibilità di evidenze archiviate utilizzabili. **Non è un backtest completo né un confronto economico tra modelli.** Include solo casi in cui entrambe le famiglie hanno una giocata e usa la prima coppia ammissibile per partita. Esclude quindi i casi senza giocata e gli altri snapshot; il campione risultante è selezionato. I settlement delle singole coppie sono soltanto diagnostici. ROI e profitti comparativi restano sempre `null`.

L'export legge in sola lettura un backup SQLite locale verificato tramite il suo manifest e controlla che il database non cambi durante l'operazione. Non legge il database di produzione né contatta provider. Il replay usa esclusivamente il JSON esportato, non apre database, non contatta provider e non addestra modelli.

Eseguire dalla radice del progetto, dopo la build backend:

```powershell
python backend/experiments/c-team-markets/export-archive.py --database C:\percorso\backup.db --manifest C:\percorso\manifest.json --out C:\percorso\input.json
node backend/experiments/c-team-markets/strict-archive-replay.js --input C:\percorso\input.json --out C:\percorso\nuova-cartella
node --test backend/experiments/c-team-markets/strict-archive-replay.test.js
```

Il file di export e la cartella di output del replay non devono già esistere. `report.json` include hash dell'input, dello script, delle componenti di ricerca, del file modello, della release, del codice e della configurazione A; riporta anche esclusioni e copertura dei 12 mercati. Gli hash `source` dichiarati dall'export sono metadati: il replay non li verifica riaprendo il database.

Per A si richiede il packet originale con codice e configurazione attuali, l'istante originario e una quota reale coerente con il packet. Per C il controllo tecnico verifica la release attuale e la configurazione originale senza modificare versioni o date: gli output C precedenti non sono una previsione controfattuale del modello C attuale. Sono obbligatorie le evidenze temporali originali di previsione, calibrazione, addestramento e disponibilità dello storico: devono essere coerenti con il momento della previsione e con la baseline della release. In assenza di tali evidenze la coppia è esclusa. Entrambe le famiglie usano le stesse quote di origine A, entro cinque minuti sia all'istante del packet sia alla conclusione dello snapshot. Un mercato deve avere tutti i lati presso lo stesso bookmaker, origine, istante e linea. Alias duplicati con prezzo uguale sono accettati; prezzi discordanti sono esclusi.

Le opportunità specialistiche archiviate sono limitate al `ranked` originale, che contiene al massimo tre elementi e non ricostruisce i risultati su ogni foglio bookmaker. Se sono presenti probabilità statistiche ulteriori o mancano evidenze di qualificazione, la coppia è esclusa. Le quote tiri e tiri in porta sono sempre escluse perché il formato dell'archivio non contiene una prova indipendentemente verificata della semantica originaria del provider; non la si deduce dal valore della linea. Corner, falli e mercati giocatore sono fuori dalla policy.

Il settlement richiede risultato e statistiche reali pertinenti; `UNRESOLVED` esclude la coppia senza usare valori di ripiego. `firstReasons` conta una prima ragione per record, `allReasons` tutte le ragioni rilevate e `coverage` distingue quote archiviate e selezioni accoppiate. Lo stato è `INSUFFICIENT_ARCHIVE_DATA` senza coppie oppure `ARCHIVE_CANDIDATE_PAIRS_ONLY` quando ne esistono: entrambi indicano che non è disponibile un confronto economico completo.
