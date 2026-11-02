# Analisi sportiva e azioni manuali A/C

Il dettaglio partita si apre su **Analisi sportiva**: grafici delle probabilità gol,
distribuzione dei gol, tiri e coefficienti squadra disponibili. I valori mancanti
restano espliciti. La scheda **Giocate A e C** conserva le migliori proposte dei
due modelli, con quota reale salvata e provenienza; non espone una griglia quote.

La consultazione A richiede soltanto quote in cache (`cacheOnly: true`);
un cache miss non avvia richieste al bookmaker. Il preview C predefinito disabilita
la rete quote. Il calcolo sportivo A non attende C. La Nightly mantiene il proprio
flusso esplicito, distinto dalla consultazione.

## Puntate virtuali manuali

`POST /wallets/bets/manual` riceve modello, partita, selezione, importo in centesimi,
quota e bookmaker mostrati. Il server ricostruisce e verifica il candidato dai dati
salvati: non accetta probabilità, prezzi o classificazioni inventati dal client.
Controlla partita futura, quota reale valida, corrispondenza prezzo/bookmaker,
saldo e limite di esposizione del portafoglio. Il limite di una giocata per
modello/partita vale sia per l'origine manuale sia per quella Nightly.

La migrazione additiva `026_manual_model_bets.sql` conserva origini manuali,
liquidazioni e proposte salvate in tabelle dedicate. Gli addebiti e le liquidazioni
usano il ledger esistente del rispettivo portafoglio; i capitali A e C restano
separati. L'origine manuale non finge una decisione Nightly. Le puntate manuali
compaiono nelle letture dei portafogli e seguono la liquidazione degli esiti reali.

## Archivio LOW/speculative

`POST /wallets/opportunities/archive/manual` salva un candidato verificabile
classificato LOW o SPECULATIVE. Può conservare una quota reale datata con età e
provenienza, senza renderla idonea all'esecuzione. Nessun capitale viene impegnato.
`GET /wallets/opportunities/manual` alimenta la sezione delle proposte salvate,
distinta dalle puntate. Queste registrazioni non costituiscono ritorni o ROI.

L'APK non viene generato da questa revisione; usa il medesimo sorgente al prossimo
packaging richiesto esplicitamente.

## Verifiche

- Frontend: 422 test passati, typecheck, lint e build produzione riusciti.
- Backend: 1.311 test passati in Linux senza rete esterna, zero errori; un test di
  training CatBoost reale saltato perché fuori dal runtime di verifica standard.
  Typecheck e lint riusciti. Il test concorrente di inizializzazione ha esposto
  una lettura dello schema fuori dal retry: ora anche quella lettura è protetta.
- Docker: entrambi i servizi avviati; healthcheck backend HTTP 200.
- Browser: grafici reali verificati sul dettaglio partita, layout telefono a 390 px
  senza overflow; nessuna puntata o archiviazione di prova scritta sui dati reali.
