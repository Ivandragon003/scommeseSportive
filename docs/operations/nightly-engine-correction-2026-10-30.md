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

## Rilascio e nuova esecuzione

Il deployment backend `6ae4d22eb23c0621142f8a58`, commit `34d33d1c`,
è stato richiesto; lo stato LIVE deve ancora essere verificato.
Il nuovo run deve usare policy v2, quote nuove e i rispettivi motori A/C.
Una nuova puntata non è garantita per ogni vecchia registrazione: i motori
possono astenersi e nessuna sostituzione può essere retrodatata dopo il kickoff.

Il Turso personale di produzione è raggiungibile tramite la configurazione
di produzione. Il precedente blocco di lettura riguardava il database della
vecchia configurazione locale; non impedisce questa manutenzione.
