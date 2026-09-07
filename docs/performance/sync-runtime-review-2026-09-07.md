# Verifica sync e runtime — 7 settembre 2026

## Test e correzioni

- I test Compose cercavano variabili esplicite e un `docker-compose.prod.yml`
  che non fa più parte del progetto. Il Compose corrente importa `.env`;
  provider e timeout hanno già i default nel backend.
- Il test della nightly ripeteva le stesse assunzioni obsolete. La policy
  delle cinque stagioni resta verificata nel backend e nella richiesta CI.
- Il test archivio ometteva `category`, `classifications`, `from` e `to`.
  Ora verifica sia i default sia una richiesta con i filtri valorizzati.
- Il frontend Docker copiava `build` dal PC: era possibile distribuire una
  build vecchia o fallire su un checkout pulito. Ripristinata la compilazione
  dai sorgenti con `npm ci` dentro uno stage Node; `build` esclusa dal contesto.

## Ottimizzazioni implementate

1. **Formazioni.** Il collector esclude le partite con entrambi gli XI già
   confermati prima di interrogare il provider. Il segnale `hasConfirmedLineup`
   usato dal frontend diventa vero solo per entrambe le squadre, così il polling
   prosegue quando ne manca una. Le riconciliazioni rosa riuscite vengono
   riutilizzate per sei ore nello stesso processo (massimo 500 squadre);
   le risposte vuote, incomplete o fallite non vengono memorizzate come riuscite.
   Gli infortuni continuano ad aggiornarsi per le partite non ancora confermate.
2. **Credenziali.** Il cooldown Odds API si applica alla chiave, a prescindere
   dal campionato. API-Football condivide fra istanze ed endpoint una pausa
   di 15 minuti dopo sospensione, 401/403 o credenziali esplicitamente non valide.
   Durata configurabile con `API_FOOTBALL_AUTH_COOLDOWN_SECONDS` (30–3600 s).
   Le chiavi sono identificate tramite hash; cambiarle non eredita la pausa
   dell'account precedente. I cooldown sono in memoria e scadono automaticamente.
3. **Storico.** La migrazione additiva `012_football_data_verified_csv.sql`
   introduce copie CSV in Turso con hash SHA-256, versione del formato cache e
   data di verifica. Si memorizzano solo stagioni concluse con calendario
   completo (numero squadre atteso e ogni coppia casa/trasferta una sola volta)
   dopo il completamento dell'import. Una copia vale al massimo 30 giorni;
   ogni riuso ne controlla hash e versione, senza prorogarne la scadenza.
   La stagione corrente viene sempre scaricata. Gli abbinamenti Understat e
   il recupero dei campi NULL vengono ripetuti anche dalla cache; nelle seconde
   divisioni vengono riparate le lacune di storico e le nuove identità note.
   I riepiloghi espongono `reusedHistorical`. La prima esecuzione deve ancora
   scaricare e verificare lo storico: un outage non produce copie fittizie.
4. **Diagnostica.** Lo scheduler formazioni espone `predictedSaved`,
   `alreadyConfirmed`, `providerStatus`, conteggio e messaggi dei warning
   (massimo dieci). Un provider degradato viene registrato anche in `lastError`
   e nei log, pur mantenendo disponibile la previsione locale. Nessun nuovo
   pannello tecnico viene mostrato all'utente finale. Senza partite da
   controllare lo stato è `not_checked`, non una conferma di salute del provider.

### Refresh esplicito dello storico

Inviare `{"forceRefresh":true}` a `POST /api/scraper/football-data` oppure
`POST /api/competition-transitions/sync-references`, con la normale
autenticazione amministratore. Si riscaricano le cinque stagioni previste;
la flag non modifica la retention. Un download fallito non viene sostituito
silenziosamente con una copia vecchia. Restano valide le scritture COALESCE
per le statistiche supplementari: la fonte non sovrascrive Understat.

### Verifiche

Test su riuso/expiry/hash/versione/refresh forzato della cache, round-trip libSQL,
recupero dei campi mancanti, fallimento degli abbinamenti incompleti, nuove
identità nelle seconde divisioni, isolamento delle credenziali, rinnovo rose,
aggiornamento infortuni e arresto del polling solo con due XI confermati.

Le modifiche riguardano infrastruttura e consumo delle API. Non cambiano il
modello predittivo e non risolvono una sospensione account o un 503 della fonte:
quei blocchi vanno risolti separatamente.
