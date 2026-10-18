# Riduzione CPU e preparazione replay — 18 ottobre 2026

## Diagnosi e limiti dell'attribuzione

L'avviso Hostless segnalato dall'utente risale al giorno precedente, senza
partita o orario identificabili. Non sono disponibili le metriche Hostless di
quel momento: non è possibile attribuirlo con certezza a una singola richiesta.
I cinque profili live della nightly risultavano presenti e riutilizzabili.

È stato però riprodotto un percorso ancora costoso: il cutoff prematch del
replay Roma–Genoa non aveva un profilo persistito, anche quando il profilo live
Serie A era pronto. Un replay poteva quindi ricostruire 450 forecast sul web
server. Il profiler locale ha inoltre rilevato ordinamenti ripetuti dei prefissi
isotonici e rivalutazioni delle stesse lambda durante il fitting.

## Modifiche

- I campioni cronologici ricevono un solo ordinamento stabile. Ogni prefisso
  seleziona gli stessi indici e mantiene l'ordine originale delle probabilità
  uguali. Bucket, pooling, curve per famiglia e cutoff restano invariati.
- Il fit isotonico può ricevere campioni già ordinati; controlla comunque
  l'ordine e ripiega sull'ordinamento normale se il suggerimento è errato.
- Dixon–Coles riusa le lambda delle coppie casa/trasferta nello stesso passo
  dell'ottimizzatore e le aggiorna dopo ogni modifica dei parametri. Non cambiano
  formule, iterazioni, arresto, pesi o ordine di accumulo dei gradienti.
- Il comando di preparazione include i cutoff delle ultime dieci partite
  concluse per lega, oltre al profilo live. Kickoff simultanei sono deduplicati.
  L'API consente un limite esplicito 0–20; il valore predefinito resta 0.
- Anche la nightly usa il comando che verifica tutti i profili da un nuovo
  servizio, entro il timeout esistente. La preparazione non importa dati, non
  modifica i parametri del modello salvati e non registra giocate.

## Misure locali

Confronto nello stesso processo con i moduli originali salvati prima della
modifica, su 1.900 fixture sintetiche, 45 refit e 57.374 osservazioni:

| Percorso | Tempo trascorso | CPU processo |
| --- | ---: | ---: |
| Originale | 23.901 ms | 25.454 ms |
| Ottimizzato | 9.009 ms | 9.656 ms |

Riduzione CPU circa 62%. `deepStrictEqual` verifica curve globali, curve per
famiglia, campioni e pesi appresi. È una verifica computazionale, non una nuova
misurazione di accuratezza o ROI; i tempi non rappresentano Hostless.
Il confronto completo con `deepStrictEqual` è passato anche separatamente nel
container Linux/Node20, confrontando originale e ottimizzato nello stesso ambiente.

Nel database condiviso sono stati preparati e verificati 44 profili live/replay
da un servizio nuovo. I test impediscono refit nei replay preparati e verificano
che modificare il risultato della partita target non cambi il suo profilo
prematch. I riferimenti dei parametri del fit ammettono solo 1e-12 di differenza
per gli ultimi bit delle funzioni matematiche tra Windows/Node24 e Linux/Node20.

## Verifica runtime

- `docker compose up -d --build backend frontend` completato; backend healthy,
  frontend disponibile su `http://localhost:3000`, `/api/health` HTTP 200.
- Dopo l'accesso effettuato dall'utente, UI locale verificata su Milan–Atalanta
  (pronostico futuro) e Roma–Genoa (replay), con quote reali disponibili.
  Le route hanno risposto HTTP 200 rispettivamente in 2.259 e 2.148 ms.
- Replay ripetuto limitando temporaneamente il backend già avviato a 0,1 CPU:
  HTTP 200 in 4.408 ms. Il limite locale è stato poi rimosso. Questo verifica
  il processo avviato e il profilo pronto, non un avvio completamente freddo.
- Tentativi separati con un nuovo processo a 0,1 CPU non hanno concluso la
  lettura Turso (`UND_ERR_SOCKET`); non vengono presentati come verifiche riuscite
  né come prova della causa dell'avviso Hostless.
- Build, typecheck, lint e 539 test backend superati; controlli mirati ripetuti
  dopo gli ultimi aggiornamenti dei test/script. Sintassi Bash verificata.
  I test numerici mirati passano anche nel container Linux/Node20.

## Attivazione e limiti

### Diagnosi successiva direttamente su Hostless

Il codice distribuito aveva la stessa impronta del build locale, ma una nuova
istanza del servizio falliva sistematicamente la prima lettura del profilo dopo
aver caricato lo storico. L'errore era `TypeError: fetch failed`, con causa
`UND_ERR_SOCKET`. Il fallback corretto dal punto di vista numerico attivava così
il ricalcolo completo sul container limitato dalla CPU.

Nel terminale del container, impedendo esplicitamente qualsiasi fit storico,
la ripetizione della sola lettura interrotta ha recuperato il profilo valido:
165 ms per la lettura con recupero, 8.571 ms per il pronostico completo nel
processo diagnostico. Non sono stati scritti pronostici durante questa prova.

La lettura persistente ora ammette al massimo due nuovi tentativi, con attese
di 100 e 200 ms, solo per `UND_ERR_SOCKET`, `ECONNRESET` ed `EPIPE`.
Le query, le chiavi, i checksum e i payload restano identici. Errori SQL,
autorizzazione o errori senza codice di trasporto vengono propagati subito.
I nuovi test coprono il recupero e il limite dei tentativi. Non vengono
ripetute scritture o operazioni sulle giocate.

Verifica conclusiva sul sito pubblico, dopo il deploy Hostless `37289f66`
del commit `274c797c` e il job GitHub `39141074809` completato con successo
(44 profili, 5 leghe): Milan–Atalanta carica probabilità e quote reali.
Il log Hostless del 18 ottobre alle 17:41:24 Europe/Rome registra
`POST /predict`, HTTP 200, `durationMs: 9981`; la lettura quote da snapshot
risponde HTTP 200 in 214 ms. `/api/system/health` risponde HTTP 200.
La CI `39141074877` è verde; localmente 541 test backend, typecheck e lint
superati. Docker è rimasto spento durante questa diagnosi e verifica.
Questa prova conferma la risoluzione del timeout riprodotto; non costituisce
una garanzia contro ogni futura saturazione o interruzione del provider.

Occorrono il deploy del backend aggiornato e il job di preparazione verde.
Frontend e APK non cambiano. La nightly mantiene la preparazione dopo i nuovi
dati. Replay più vecchi delle dieci partite preparate per lega, coorti nuove,
configurazioni diverse o problemi di accesso alla cache possono ancora richiedere
il calcolo completo. Il limite CPU resta imposto dall'hosting: questa modifica
riduce il lavoro necessario e non garantisce l'assenza di ogni avviso di throttling.
