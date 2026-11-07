# Osservazioni e copertura dei mercati statistici

Questa guida descrive il contratto implementato per tiri, tiri in porta,
gialli e rossi. Codice verificato non significa dati storici riparati o backend
distribuito. Le letture di audit e i loro conteggi restano nelle ricevute private;
non sono un campione di validazione predittiva.

Il bonus di copertura xG del contesto richiede due osservazioni numeriche
finite non negative: null, vuoti e valori invalidi non ottengono il bonus;
zero autentico resta osservato. I mercati SOT richiedono il campione previsto
sia per SOT sia per tiri totali, dato che il modello usa anche il rapporto
fra i due. La stessa ammissione vale per operatività, replay e produzione
degli input di calibrazione, senza cambiare formule o soglie.

Il collector indipendente e i candidati HxG/AxG dei CSV hanno un contratto
separato nella [guida fonti](data-sources.md): acquisire uno snapshot non
attesta automaticamente adeguatezza del modello o genealogia prospettica.

## Acquisizione e persistenza

Understat resta primario; `football-data.co.uk` integra soltanto i campi
mancanti. Per i conteggi sono validi numeri interi finiti non negativi e le
rispettive stringhe numeriche non vuote. `0` e `"0"` sono osservazioni;
`null`, assenza, stringhe vuote, booleani, valori negativi, frazionari o non
numerici non lo sono. Le medie possono invece essere frazionarie.

| Passaggio | Contratto |
|---|---|
| `UnderstatScraper` | Roster assente, vuoto o incompleto non prova zero cartellini. Ogni campo ha disponibilità indipendente. Le righe giocatore conservano le altre metriche utilizzabili anche quando un campo è assente. |
| Shotmap | I tiri in porta richiedono roster e shotmap coerenti, risultati riconosciuti e nessun ID evento esplicitamente duplicato. Il conteggio eventi esclusi gli autogol deve corrispondere ai tiri dichiarati dal roster. Zero tiri dichiarati e shotmap vuota sono evidenza di zero; shotmap assente non lo è. |
| Autogol | `OwnGoal` non è tiro in porta né tiro del giocatore. Il totale squadra conserva la precedente semantica della lunghezza della shotmap, comprensiva degli autogol; non si riscrive lo storico con una nuova definizione. |
| CSV supplementare | I conteggi non validi diventano mancanti. Matching, quote e priorità delle fonti restano separati. |
| `DatabaseService.upsertMatch` | Il `COALESCE` che conserva una misura già nota è intenzionale: il supplemento non sovrascrive Understat, incluso uno zero vero. Nessuna sostituzione generale di tutti i `COALESCE`. |
| Profili giocatore | Import stagione e ricostruzione derivata registrano contatori per campo in `stats_json.coverage`. Le medie usano solo le osservazioni valide; i campi mai osservati restano null. Non si riusa un vecchio totale cartellini come se appartenesse al nuovo aggregato. |

Il solo confronto di lunghezze non certifica la correttezza del provider.
Duplicati con ID diversi o payload già incoerenti possono richiedere una
rettifica della fonte. Non si deduplicano eventi per somiglianza inventando
quelli mancanti. Roster con identità duplicate ed eventi con lo stesso ID
esplicito vengono trattati come evidenza non affidabile nei percorsi corretti.

## Conservare le osservazioni documentate

La migrazione `034_final_observations.sql` conserva valore, fonte e impronta
della prova per singolo campo. Goal e xG richiedono un risultato Understat
con identità, squadre e istante coerenti; i conteggi e l'arbitro richiedono
una riga CSV conservata, abbinata univocamente per data, squadre e risultato,
con lo stesso valore presente nel database. Una differenza non autorizza a
sovrascrivere Understat: resta distinta e non entra nel blocco CSV.

Gli upsert Understat e l'import CSV registrano automaticamente le nuove prove
idonee nella stessa transazione. I valori protetti non vengono sovrascritti:
l'upsert conserva il valore e registra il conflitto; SQL diretto incompatibile
viene rifiutato dai trigger. I campi NULL restano completabili e le stagioni
contenenti osservazioni protette sono escluse dalla cancellazione automatica.
La prova originale resta conservata anche se il payload operativo viene
aggiornato. Revisioni dei valori protetti richiedono una manutenzione esplicita;
la normale sincronizzazione non le esegue.

Il possesso e gli altri campi senza prova sufficiente non diventano verificati
perché valorizzati. Il blocco attesta la prova acquisita e la sua conservazione,
non l'infallibilità del provider. Il piano di
`backend/scripts/final-observations.js` descrive coperture e differenze;
`prepare-data-integrity.js` applica esclusivamente le migrazioni 034/035 e le
osservazioni revisionate, dopo backup verificato e controllo del piano.

La migrazione `035_odds_market_mapping.sql` distingue gli snapshot normalizzati
con il mapping corrente dai legacy. I totali goal non diventano tiri in base
alla linea. Le quote legacy `shots_total_*` con linea almeno 8 prive di prova
del mercato originario sono escluse dalle letture operative e storiche, con
motivo esplicito; non vengono trasformate arbitrariamente in quote goal. I
payload originali restano conservati come evidenza, non come prezzi convalidati.

## Aggregazioni e campioni

Le medie pesate squadra hanno un denominatore per campo: una partita con
tiri noti ma gialli assenti contribuisce soltanto ai tiri. Lo stesso vale per
ultime 5/10 e statistiche concesse; gli zeri osservati entrano nel denominatore.
Le percentuali richiedono coppie coerenti di numeratore e denominatore.
I booking points richiedono i quattro conteggi noti: gialli casa/trasferta più
due volte i rossi casa/trasferta.

`team_stats_json.computed.marketSampleSizes` conserva le coperture per campo;
`venueMarketSampleSizes` distingue casa e trasferta per i tiri consumati dal
contesto. Questi metadata restano nel JSON esistente e si producono nei normali
percorsi di calcolo; non attestano un ricalcolo già eseguito sul DB. La protezione
delle osservazioni descritta sopra usa invece la migrazione 034.

I profili giocatore hanno campioni indipendenti per tiri, SOT, cartellini e
quota di tiri squadra. La quota richiede un totale squadra verificabile;
non si divide per la somma dei soli giocatori conosciuti. Il modello gialli
per 90 minuti usa cartellini e minuti osservati sulle stesse presenze, da
`observedTotals.yellowCards` e `observedMinutes.yellowCards`. Copertura parziale
senza questi abbinamenti non autorizza la prop. Un profilo `identityOnly`
non aggiunge ricchezza statistica o presenze osservate.

I profili `identityOnly` non entrano neppure nel pool dei tiri giocatore per
la sola presenza nella rosa: senza evidenza di titolarità potevano ricevere
un prior e ridurre la quota normalizzata dei giocatori osservati. Il contesto
li ammette soltanto con uno stato starter esplicito, acquisito entro l'as-of,
per la partita interrogata e la squadra corretta; panchina, indisponibilità,
date mancanti/future e conflitti non bastano. La squadra è quella del contesto
anche nei replay dopo un trasferimento. Il prior di ruolo resta legittimo per
questi starter, ma il campione osservato resta zero e non supera le soglie props.
L'adattatore riconosce `Goalkeeper` come `GK`. Roster e dati persistiti restano
intatti; formule e coefficienti del modello non cambiano. Il percorso giocatori
rimane disabilitato per default e la correzione non lo attiva.

Gli aggregati arbitrali distinguono le partite con entrambi i conteggi noti
per gialli, rossi e falli. I vecchi profili persistiti non conservano la loro
finestra di ricostruzione: il runtime mantiene le loro medie e fallback.
La SELECT aggiuntiva, limitata alla competizione e al cutoff della previsione,
aggiunge campioni per campo soltanto quando totale partite e media coincidono.
Non sostituisce silenziosamente una media con quella di un altro periodo;
la coincidenza numerica non ricostruisce una genealogia storica mancante.
Per i profili legacy senza metadata, la copertura resta non verificata e il
fallback precedente resta esplicito.

## Contesto, probabilità e risultati

`PredictionContextBuilder` propaga valore e campione separatamente: una media
mancante può usare il prior esistente, con campione osservato zero. Una media
reale zero conserva tale valore. Gli zeri osservati non attivano il fallback
dei modelli specializzati. Shrinkage, coefficienti, pesi e soglie non sono
riottimizzati; il campione che alimenta le formule esistenti è specifico del
campo. I vecchi profili validi senza copertura mantengono il fallback legacy.

`PredictionService` e replay cronologico applicano le soglie già esistenti
(almeno 8 osservazioni per squadra e 20 combinate) separatamente alle famiglie.
Il totale cartellini richiede gialli e rossi; non basta il numero globale di
partite. Il filtro precede selezione e calibrazione. Il payload API sopprime
anche le distribuzioni strutturate delle famiglie non disponibili, evitando
che il formatter ricrei probabilità da stime prive di campione sufficiente.
Le stime prior già fornite possono restare stime, senza diventare dati osservati.
Una media proprio assente nel formatter resta `expected:null`, non zero.
Il totale rossi è controllato separatamente dal totale pesato dei cartellini.

Settlement di player props, etichette per calibrazione e backtest restituiscono
esito non disponibile quando manca il conteggio necessario: non segnano una
vittoria Under per un risultato inventato pari a zero. Le curve persistite,
i vecchi replay e le giocate archiviate non vengono ricalcolati automaticamente.
Nella pagina Dati una media non disponibile appare come trattino; zero resta zero.

## Verifica, versioni e limiti

Le fixture confrontano dati completi, copertura parziale, piccoli campioni,
invalidi e zeri reali, con DB temporanei e oggetti in memoria. Esecuzione dopo
la build, dalla directory `backend`:

```powershell
node --test --test-concurrency=1 test/missing-market-acquisition.test.js test/missing-market-statistics.test.js test/missing-market-prediction.test.js test/missing-market-service.test.js test/missing-market-settlement.test.js test/understat-player-missing-observations.test.js test/prediction-formatter-market-availability.test.js test/backtest-chronology.test.js test/operational-a-regression.test.js test/frozen-baseline.test.js test/recompute-averages-players-route.test.js test/team-averages-batch.test.js
```

Le sei fixture numeriche A e lo snapshot C conservano aspettative originali.
Il registro delle deviazioni A ammette soltanto gli esatti blocchi di questa
correzione, annullati in memoria prima dei controlli sugli hash originari;
prove di mutazione verificano che modifiche ulteriori o ripristini siano rifiutati.
La nuova identità del codice A va separata nel [protocollo prospettico](models/MODEL-A-VALIDAZIONE-PROSPETTICA.md).

Nessun miglioramento di accuratezza, calibrazione, ROI o CLV è dimostrato da
queste fixture. L'audit remoto è SELECT-only: non ripara errori a monte o
profili già calcolati. Correzione di payload storici, ricostruzioni persistenti,
ricalibrazione, deploy e attivazione del pilot richiedono autorizzazioni separate.
Collector e recorder restano spenti. Lo snapshot C, le sue guardie e i suoi
hash non cambiano. I percorsi generali xG non pertinenti non vengono riscritti
con questa correzione dei quattro mercati.
