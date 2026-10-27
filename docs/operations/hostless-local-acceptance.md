# Collaudo locale Hostless con dati sintetici

`backend/scripts/hostless-integration.js` verifica il flusso operativo senza usare il
database condiviso, dati sportivi reali o crediti del provider. Crea un database
libSQL temporaneo, con schema e migrazioni effettivi. Non legge `.env`; i processi
figli ricevono solo una lista esplicita di variabili e credenziali fittizie.

Da PowerShell, nella radice del repository:

```powershell
docker build -t footpredictor-hostless:local backend
New-Item -ItemType Directory -Force backend/artifacts | Out-Null
docker run --rm --network none --cpus 0.25 --memory 512m `
  -v "${PWD}/backend/artifacts:/results" `
  footpredictor-hostless:local node scripts/hostless-integration.js `
  --output=/results/hostless-integration-linux-025cpu.json
```

Il container non ha accesso alla rete esterna. I processi comunicano tramite
loopback HTTP, IPC e database locale. Le chiamate Axios del provider sono sostituite
da fixture, con bookmaker denominato `Synthetic test bookmaker`. Le quote passano
per il manager persistente effettivo; i tre crediti riportati sono **simulati**.

Il test esegue:

1. Avvio dell'entrypoint Express di produzione, healthcheck e autenticazione reale
   con password fittizia creata per il solo test.
2. Risposta permanente 410 della registrazione legacy anche con `AUTO_BET_ENABLED=true`.
3. Avvio di due processi tramite `startWorker`, con coordinatore persistente,
   runtime e timer di produzione. Il clock controllato è iniettato esclusivamente
   dal programma di test; il worker distribuito non riceve un clock accelerato.
4. Un ciclo reale di polling di 15 secondi prima di T−15, senza acquisire quote.
5. Tre incontri simultanei, un'unica acquisizione simulata, snapshot condivisi e
   decisioni distinte A/C, sei registrazioni nei portafogli shadow.
6. Arresto `SIGKILL`, scadenza simulata della lease dopo 31 secondi, subentro del
   secondo processo e riavvio di un altro worker, senza duplicazioni.
7. Risultato fittizio, sei liquidazioni via API, secondo tentativo idempotente e
   riconciliazione dei due portafogli con il registro contabile.

Il risultato JSON include tempi, RSS e picco RAM di ogni processo, CPU cumulativa,
differenza CPU del gruppo di decisioni e limiti/picco del cgroup Linux, se disponibili.
I file generati in `backend/artifacts/*.json` sono ignorati da Git.

## Limiti dell'evidenza

Il campione contiene 135 partite storiche fittizie e tre partite future. Il modello C
del test è un artefatto CatBoost JSON minimo, esplicitamente `fixtureOnly`; questa
prova verifica integrazione e contabilità, non la qualità di un modello addestrato.
La parità con CatBoost nativo e il caricamento di un artefatto addestrato sono
verifiche separate del collaudo ML Linux.

Il limite CPU del comando riguarda l'intero container: orchestratore, backend e
due worker. Il risultato non misura latenza Turso remoto, disponibilità del provider,
rete Hostless, memoria del database sportivo completo o affidabilità continuativa.
I tempi non sono garanzie del piano gratuito. Non dimostrano ROI, accuratezza o
funzionamento remoto. Nessun servizio Hostless o GitHub viene configurato dal test.

## Campione di risorse con storico locale esportato

Quando sono già disponibili i file locali indicati, senza esportare nulla dal remoto:

```powershell
docker run --rm --network none --cpus 0.25 --memory 256m `
  -v "${PWD}/backend/artifacts:/results" `
  footpredictor-hostless:local node scripts/hostless-resource-sample.js `
  --matches /results/research/matches.json `
  --artifact /results/research/followup-coherent-candidate/artifact.json `
  --count 20 --output /results/hostless-resource-linux-025cpu-256m.json
```

Questo programma importa lo snapshot esistente in un database file temporaneo.
Un processo separato misura il caricamento effettivo `getMatches`, la conversione
del runtime, il caricamento dell'artefatto C addestrato, il fit A e la preparazione
delle caratteristiche tramite `buildForecastInput`, quindi l'inferenza C completa
su venti incontri futuri. I primi tre sono riportati anche come gruppo separato.
L'importatore esce prima dell'avvio del processo misurato; il processo principale
non carica lo storico, evitando di trasferire il proprio picco RAM al processo
figlio. Non vengono registrati modelli, benchmark, decisioni o puntate.

Il tempo cumulativo rappresenta elaborazione sequenziale delle parti matematiche;
non comprende quote, calibrazione finale, transazioni del registro, carico HTTP
concorrente o ritardi Turso. Il file JSON riporta separatamente RSS attuale, picco
del processo e CPU. `productionValidated=false` resta visibile per l'artefatto
candidato: il successo del dimensionamento non promuove il modello.
