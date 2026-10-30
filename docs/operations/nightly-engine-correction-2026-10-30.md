# Correzione delle puntate Nightly v1 — 30 ottobre 2026

L'utente ha autorizzato il ritiro delle puntate virtuali generate dal vecchio
percorso comune, il rilascio dei motori separati e una nuova esecuzione.

## Ritiro verificato in produzione

Alle 18:26 Europe/Rome sono state ritirate soltanto le cinque puntate aperte
del run `github-actions:41069572500`, policy `virtual-recommendation-v1`.
Nessuna era liquidata e tutte le partite erano ancora future.

| Portafoglio | Puntate ritirate | Capitale liberato | Disponibile dopo il ritiro | Impegnato |
| --- | ---: | ---: | ---: | ---: |
| A | 3 | 44,20 euro | 1.000,00 euro | 0,00 euro |
| C | 2 | 20,00 euro | 1.000,00 euro | 0,00 euro |

La manutenzione ha archiviato le righe originali e i corrispondenti movimenti
STAKE in `research_bet_cancellations`, quindi ha ritirato quelle sole righe
dal registro operativo nella stessa transazione. OPEN, decisioni, input,
quote e modelli originali non sono stati riscritti. La verifica successiva
ha trovato cinque archivi, zero puntate operative e decisioni originali
identiche alla copia precedente. Non sono stati creati nuovi portafogli o
identificativi fittizi delle partite.

La copia precedente, il piano con impronta e la verifica successiva restano
negli artefatti locali ignorati `backend/artifacts/corrections/`. Non contengono
credenziali e non vengono pubblicati con il repository.

## Controlli e ripetibilità

`backend/scripts/cancel-research-bets.js plan` esegue soltanto letture e
produce un piano con ID, policy, run, autorizzazione e impronte delle righe.
`apply --plan` ricontrolla origine, puntata aperta, partita futura, assenza di
lease attive, movimento originale e saldi. Un piano alterato o scaduto non
ritira alcuna puntata. Ripetere lo stesso piano non libera capitale due volte.

La migrazione 024 aggiunge soltanto l'archivio. I trigger di DELETE ammettono
esclusivamente il ritiro di righe identiche a quelle archiviate; gli altri
divieti di modifica rimangono attivi. Le proiezioni operative escludono le
decisioni di finanziamento ritirate, conservandole nelle letture storiche.

Build, typecheck e lint backend sono riusciti. I cinque gruppi di test della
manutenzione sono passati, inclusa la nuova registrazione v2 sulla stessa
partita e l'assenza di duplicati. La CI della separazione motori `34d33d1c`
ha completato entrambi i job; backend 1.044 test, 1.043 passati, un opzionale
saltato e zero fallimenti.
Anche la CI `41098953612` della manutenzione `983f2850` ha completato
entrambi i job: backend 1.049 test, 1.048 passati, un opzionale saltato e
zero fallimenti.

## Rilascio e nuova esecuzione

La [Nightly correttiva `41098979782`](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41098979782),
commit `983f2850`, è terminata con successo. Il passaggio v2 ha analizzato
cinque partite, registrato dieci decisioni e sei nuove puntate, senza errori
o partite mancate. Le quattro astensioni non sono state forzate in giocate.

| Portafoglio | Nuove puntate | Disponibile | Impegnato | Patrimonio |
| --- | ---: | ---: | ---: | ---: |
| A | 4 | 962,10 euro | 37,90 euro | 1.000,00 euro |
| C | 2 | 980,00 euro | 20,00 euro | 1.000,00 euro |

La verifica successiva ha trovato soltanto decisioni operative v2 e prezzi
reali catturati/aggiornati entro cinque minuti dalla registrazione, sempre
prima del kickoff. A ha ricevuto quote 1X2, handicap asiatico, totali gol,
cartellini totali, BTTS e draw no bet; C soltanto 1X2, totali gol e handicap
asiatico. Questo dimostra la separazione effettiva dei cataloghi; non
garantisce che A debba scegliere un cartellino in ogni ciclo. Il consiglio e
lo stake di A sono quelli del proprio motore; le due puntate C valgono l'1%.
Il budget quote misurato dopo il ciclo è 394 crediti usati e 106 residui.

Il rilascio web Hostless è distinto dal job GitHub già riuscito. Sono stati
richiesti il backend `34d33d1c` (`6ae4d22eb23c0621142f8a58`), poi il backend
completo `983f2850` (`6ae4d48d475f3a60ae3afee7`) e il frontend `983f2850`
(`6ae4d3d313dc13e591bc9f0c`). Hostless li mostra ancora in coda: non viene
attribuito loro lo stato LIVE. I servizi precedenti rimangono in esecuzione.

Il Turso personale di produzione è raggiungibile tramite la configurazione
di produzione. Il precedente blocco di lettura riguardava il database della
vecchia configurazione locale; non impedisce questa manutenzione.
