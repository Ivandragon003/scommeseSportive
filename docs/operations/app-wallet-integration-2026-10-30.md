# Portafogli A/C nella gestione ordinaria dell'app

## Requisito e stato

Il 30 ottobre l'utente ha chiarito che le giocate automatiche devono essere
gestite nelle normali pagine **Giocate, Budget e Archivio**, con filtro A/C
e confronto dei due portafogli. Tutti gli importi restano virtuali.

L'integrazione è implementata localmente e in verifica. Il rilascio remoto
precedente rimane backend `eb5d838e` e frontend `3c503fa9`: le cinque puntate
erano già finanziate, ma comparivano nella gestione separata del confronto.
Non si attribuisce a quel rilascio la nuova navigazione ordinaria.

## Unica fonte contabile

I portafogli A e C già esistenti diventano la fonte delle pagine ordinarie.
Gli ID interni `shadow_A` e `shadow_C` sono preservati: non vengono creati
nuovi utenti, nuovi portafogli, copie di puntate o movimenti di trasferimento.
`research_bets` e `research_ledger` restano l'autorità finanziaria; i loro
nomi interni non definiscono una seconda modalità dell'app.

`GET /api/wallets`, protetto dall'autenticazione dell'app, espone in sola
lettura il confronto contabile già esistente. Il DTO conserva capitale
iniziale, patrimonio attuale, disponibile, impegnato, aggregati per periodo
e prezzi realmente registrati. Non legge artefatti ML né contatta provider.

I due capitali non vengono sommati in un saldo unico. Le 258 registrazioni
precedenti non sono attribuite automaticamente al modello A: restano
consultabili come **Storico precedente**, senza essere aggiunte ai capitali
A/C o modificate dalle nuove pagine.

## Pagine dell'app

- **Giocate:** registrazioni finanziate A/C, filtro modello, stato e periodo,
  quota/bookmaker originali e importo effettivamente impegnato.
- **Budget:** due saldi indipendenti, con capitale iniziale distinto dal
  patrimonio attuale. Profitto e ROI usano le liquidazioni del periodo;
  l'importo impegnato non viene presentato come perdita.
- **Archivio:** le stesse giocate finanziate, con evidenza congelata del
  modello corretto. C non viene ricostruito dal replay A e una classificazione
  non registrata non viene inventata. Al refresh il dettaglio usa la BET
  aggiornata, incluso il ritorno di una mezza perdita.
- **Partite:** consiglio A e percentuale indicata dal modello invariati;
  il contesto finanziario è il portafoglio A effettivo. La registrazione
  automatica resta affidata alla Nightly, senza POST al vecchio portafoglio.
- **Confronto modelli:** benchmark, mercati, esperimenti, quote e stato del
  sistema; la gestione dei saldi attivi non viene duplicata qui.

Le mezze vincite/perdite conservano il loro esito. Il ritorno liquidato è
stake più profitto effettivo, non `quota × stake` applicato indiscriminatamente.
Le statistiche sono aggregate sul periodo completo prima del limite di 500
dettagli; il troncamento prima dei filtri modello/stato è dichiarato.

## Protezioni e automazioni

Le normali letture A/C non inizializzano/resettono budget e non eseguono
POST di sincronizzazione o registrazione legacy. I comandi legacy di
inizializzazione/piazzamento rifiutano con HTTP 409 i target A/C espliciti,
incluse varianti camel/snake case e alias dei portafogli.

Restano invariati selezione, matematica dei modelli, registrazione atomica,
deduplicazione e liquidazione. A usa la percentuale consigliata; C rimane
Challenger con 1% fisso. L'esposizione massima resta 5% per portafoglio e
massimo una puntata per partita/modello. Il cambio di schermata non promuove
mercati sperimentali né autorizza scommesse con denaro reale.

Il refresh al rientro nella pagina e dopo sincronizzazione è coalescente;
non vengono introdotti polling frequenti o nuove richieste quote.
Non servono migrazioni o un nuovo backup integrale per questa lettura.

## Verifica e limiti

Il collaudo locale usa una copia isolata dei dati verificati: cinque BET
esistenti (tre A, due C), sette movimenti e saldi separati. Prima/dopo le
interazioni vengono confrontate le impronte delle tabelle finanziarie e
dello storico. Il backend locale non ha credenziali di produzione né una
rete esterna; le automazioni sono disabilitate.

Verificare su ciascuna pagina: filtro A = tre giocate, C = due; disponibili
955,80 e 980 euro; impegnati 44,20 e 20 euro, salvo successive liquidazioni
ufficiali. Nessun nuovo addebito deve essere creato dall'integrazione.

I risultati e la liquidazione del primo ciclo sportivo restano da osservare.
Le prove di mezza vincita/perdita usano fixture isolate, non eventi inventati
in produzione. Questa modifica non richiede né attiva servizi a pagamento.

Controlli completati prima della pubblicazione:

- Backend Linux Node 20 isolato dalla rete: 1.023 test superati su 1.024,
  zero errori, un test opzionale di training Python CatBoost escluso.
- Frontend: 34 suite e 239 test superati; typecheck e lint dei file
  interessati superati. Review indipendente conclusa dopo le regressioni
  su dettaglio aggiornato e guard dei portafogli.
- Build Compose backend/frontend completata; health HTTP 200 e nuova API
  `/wallets` verificata con cinque BET effettive.
- Browser locale: Giocate filtra tre A e due C; Budget mostra i due saldi
  separati; Archivio C apre il suo record `C-906371b0b3a1e2c8`, senza replay A.
  Partite legge disponibile/impegnato/patrimonio di A e conserva la puntata
  archiviata da 4,20 euro.
- Le impronte complete di undici tabelle finanziarie e storiche sono rimaste
  identiche dopo avvio e navigazione, incluse cinque BET, sette movimenti e
  258 giocate precedenti. Non è stata reinserita nessuna puntata.
- Il registro quote live è disabilitato nella copia locale isolata; un
  messaggio di chiave quote assente in Partite non invalida i prezzi
  archiviati, che rimangono visibili con la loro provenienza.

L'APK precedente incorpora il suo frontend e non acquisisce automaticamente
la nuova gestione. Usare il sito aggiornato finché non è disponibile una
release con la firma originale: [guida Android](../android-private-apk.md).

## Rollback

In caso di regressione dell'interfaccia conservare backend e letture
compatibili con la migrazione 023. Per fermare nuove puntate utilizzare
`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=false`, mantenendo l'intera
manutenzione e il suo percorso di liquidazione indipendente. Non ripristinare
un vecchio database, non ricreare portafogli e non riattivare la registrazione
automatica legacy.
