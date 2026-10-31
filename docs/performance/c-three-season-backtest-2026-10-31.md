# Backtest cronologico C sulle tre stagioni precedenti — 31 ottobre 2026

Il replay copre **tutte le 4.892 partite ammissibili** del 2023/24, 2024/25 e 2025/26, con storia iniziale 2022/23. Il benchmark precedente corretto contava 1.969 test; il confronto appaiato riguarda **1.959 partite identiche**. Il metodo A operativo (`PredictionService`) e le sue fixture restano invariati. Nessun modello è stato adottato e nessuna puntata è stata eseguita.

**Conclusione:** copertura e riproducibilità sono aumentate; non è dimostrato un miglioramento indipendente del modello C. Le nuove finestre riducono Log Loss e Brier della replica depth 3 sulle partite comuni, ma peggiorano ECE e accuracy. La ricetta C906 riaddestrata a depth 5 resta distinta dall'artefatto operativo congelato.

## Dati, esclusioni e confini della prova

Si riutilizza il dataset già ripulito dall'[audit delle fonti](c-data-benchmark-audit-2026-10-31.md), senza nuove acquisizioni: 6.573 righe e archivio originale di 8.834 partite. Dataset SHA256 `b9de693888d5ba5f982bd4cd7d38515ec547c306aacd1371f38a7edd021b64e2`; archivio SHA256 `249233a01c52ddd2578b676ae0a464ecbcce01907e34b89138a23c15e1178dc9`. Understat è la fonte primaria; i controlli supplementari e i conflitti di calendario sono descritti nell'audit precedente.

| Stagione test | Partite originali | Ammissibili |
|---|---:|---:|
| 2023/24 | 1.752 | 1.747 |
| 2024/25 | 1.752 | 1.749 |
| 2025/26 | 1.752 | 1.396 |
| Totale | 5.256 | 4.892 |

Delle 364 esclusioni, 17 appartengono alla quarantena e 347 al campione protetto senza sovrapporsi alla quarantena. Complessivamente, nelle tre stagioni cadono 354 ID protetti e 17 ID in quarantena, con 7 sovrapposizioni: `5256 − 354 − 17 + 7 = 4892`. Tutti i 745 ID protetti sono esclusi dai target di training, selezione, calibrazione e test C; nessuno è riutilizzato per certificare candidati. Il [piano](evidence/c-three-season-backtest-2026-10-31/season-plan.json) elenca ID, motivi, sovrapposizioni e conteggi per stagione. Non rimangono esclusioni residue non spiegate. Le partite escluse nella parte finale del 2025/26 limitano la copertura di quella fase del campionato.

Le 1.671 righe ammissibili del 2022/23 servono come storia iniziale; le 10 righe del 2026/27 sono fuori dal periodo test. La baseline **research A80**, distinta da A operativo, conserva il protocollo precedente: può usare una partita protetta come osservazione storica soltanto dopo la disponibilità dichiarata. Le feature C aggiuntive escludono anche quelle osservazioni protette. Non si afferma che i 745 incontri siano cancellati da ogni storico A80.

## Protocollo fissato prima dei risultati

Sei blocchi calendario semestrali, luglio–dicembre e gennaio–giugno, con confini UTC espliciti. Per ogni blocco: training espandente dal luglio 2022, due mesi successivi riservati alla selezione e altri due alla calibrazione; il test segue entrambe le fasi. Ogni partizione precedente ammette soltanto risultati con `availableAt < inizio della successiva`. Ogni target test compare una sola volta. Un vecchio test può entrare nel training di un semestre successivo dopo che il suo risultato è disponibile: è il normale avanzamento cronologico, non una prova globale mai osservata.

| Fold | Finestra test | Train | Selezione | Calibrazione | Test |
|---|---|---:|---:|---:|---:|
| 0 | 2023/2024 July-December | 1003 | 410 | 258 | 849 |
| 1 | 2023/2024 January-June | 1793 | 354 | 373 | 898 |
| 2 | 2024/2025 July-December | 2859 | 381 | 178 | 816 |
| 3 | 2024/2025 January-June | 3543 | 327 | 364 | 933 |
| 4 | 2025/2026 July-December | 4615 | 368 | 184 | 801 |
| 5 | 2025/2026 January-June | 5293 | 317 | 358 | 595 |

Piano congelato SHA256 `b44a3a2e893b973ee726b42dfa588536ee90db5ecee41dbc5b591dd8a4ac1c6d`. I confini non dipendono da score, feature o probabilità. I sei controlli mantengono pesi e temperature precedenti, CatBoost 1.2.8, seed 20261027, 120 iterazioni, profondità 3, learning rate 0,05 e due thread. Tutti i sei periodi selezionano `development_current_replica` usando la sola finestra di selezione. La calibrazione coerente `isotonic_1x2` viene rifatta esclusivamente sulla finestra separata del fold; il test non sceglie iperparametri né calibrazione. Anche il controllo senza ML attraversa la medesima calibrazione.

Le feature e la baseline sono aggiornate all'orario nominale Nightly 03:07 Europe/Rome, con cambio d'ora. Il modello ML è riaddestrato **ogni semestre** in questo esperimento: non viene simulato il ciclo settimanale di adozione in produzione. Restano stake C 1%, esposizione massima 5% e una puntata per partita; non ci sono prezzi ammissibili per applicarli economicamente.

## Metriche ricalcolate sulle stesse 4.892 partite

Log Loss con logaritmo naturale e limite inferiore 1e-15; Brier come somma delle tre classi, senza divisione per tre; ECE top-label in dieci intervalli uniformi; accuracy 1X2 con ordine home/draw/away in caso di parità. Sono incluse tutte le partite ammissibili, anche quelle senza quota o giocata.

| Procedura | Log Loss ↓ | Brier ↓ | ECE ↓ | Accuracy ↑ |
|---|---:|---:|---:|---:|
| Senza ML, con calibrazione (`no_ml`) | 0.982356 | 0.584043 | 0.018311 | 53.577% |
| Replica C depth 3 (`development_current_replica`) | 0.978255 | 0.582688 | 0.008891 | 53.271% |
| Correzione intensità (`intensity_legacy`) | 0.981800 | 0.583649 | 0.013986 | 53.496% |
| + xG recenti e avversari (`intensity_recent_xg`) | 0.981361 | 0.583434 | 0.016685 | 53.414% |
| + calendario osservato (`intensity_schedule`) | 0.981601 | 0.583592 | 0.014710 | 53.352% |
| + xG e calendario (`intensity_full`) | 0.981256 | 0.583474 | 0.015378 | 53.496% |
| Ricetta C906 depth 5 riaddestrata (`c906_recipe_retrained`) | 0.981089 | 0.584577 | 0.007628 | 53.148% |

Il ricalcolo Python indipendente dalle funzioni TypeScript passa su 6.573 record, con sette coorti test identiche e differenza massima dalle metriche dichiarate di **2,45 × 10⁻¹⁵**. [Audit completo e bin di calibrazione](evidence/c-three-season-backtest-2026-10-31/predictions/audit.json); [probabilità individuali](evidence/c-three-season-backtest-2026-10-31/predictions/predictions.jsonl.gz).

### Log Loss per stagione

| Stagione | N | Senza ML | Replica depth 3 | Ricetta C906 depth 5 |
|---|---:|---:|---:|---:|
| 2023/2024 | 1747 | 0.981439 | 0.977407 | 0.982949 |
| 2024/2025 | 1749 | 0.981521 | 0.979949 | 0.981251 |
| 2025/2026 | 1396 | 0.984550 | 0.977194 | 0.978557 |

Il [riepilogo indipendente](evidence/c-three-season-backtest-2026-10-31/independent-summary.json) contiene tutte e quattro le metriche per ciascuna delle sette procedure, delle tre stagioni e delle cinque leghe. Nessun singolo aggregato viene presentato come prova di superiorità futura.

## Confronto col benchmark attuale su 1.959 incontri identici

I precedenti 1.969 casi comprendevano 563 incontri del 2024/25, 1.396 del 2025/26 e 10 del 2026/27. Ora si aggiungono 2.933 casi e si escludono quei 10 del 2026/27. I delta seguenti usano soltanto l'intersezione di 1.959 ID con identici risultati, kickoff, forecast e competizione; non sottraggono metriche calcolate su campioni differenti. I dati e le feature sono gli stessi: cambiano training e finestre di calibrazione.

| Procedura | Log Loss prima → dopo | Brier prima → dopo | ECE prima → dopo | Accuracy prima → dopo |
|---|---:|---:|---:|---:|
| Senza ML, con calibrazione | 0.984244 → 0.984130 | 0.585084 → 0.584949 | 0.014743 → 0.014608 | 52.884% → 52.884% |
| Replica C depth 3 | 0.981428 → 0.978694 | 0.583979 → 0.582167 | 0.016912 → 0.019372 | 52.680% → 52.578% |
| Correzione intensità | 0.984593 → 0.984300 | 0.585415 → 0.585050 | 0.018281 → 0.015504 | 52.731% → 52.935% |
| + xG recenti e avversari | 0.984280 → 0.983731 | 0.585270 → 0.584812 | 0.018730 → 0.018981 | 52.629% → 52.731% |
| + calendario osservato | 0.984848 → 0.983576 | 0.585593 → 0.584569 | 0.018873 → 0.012435 | 52.731% → 52.935% |
| + xG e calendario | 0.984535 → 0.983540 | 0.585419 → 0.584705 | 0.017601 → 0.018130 | 52.884% → 52.731% |

La baseline **raw** senza ML è esattamente uguale prima e dopo sui 1.959 incontri: differenza massima zero. Cambiano i profili di calibrazione delle finestre; per questo può cambiare anche il controllo senza ML dopo la calibrazione. Il settimo controllo C906 depth 5 non esisteva nel vecchio benchmark e non riceve un delta prima/dopo inventato.

[Confronto con ID e hash delle coorti](evidence/c-three-season-backtest-2026-10-31/common-cohort-before-after.json). Per la replica depth 3, delta dopo−prima: LL −0,002735, Brier −0,001812, ECE +0,002461 e accuracy −0,102 punti percentuali. Bootstrap Python appaiato per settimana, 500 repliche, seed 20261031 e 42 settimane: IC95% LL [−0,005331; −0,000308], Brier [−0,003639; −0,000221]. Sono intervalli descrittivi di questo replay, senza correzione per selezione delle configurazioni o confronti multipli.

Sui 4.892 casi, xG e calendario non dimostrano un vantaggio sulla replica depth 3: per xG, IC95% del delta LL [−0,000319; +0,006779]; per entrambe le feature [−0,000459; +0,006591]. La ricetta depth 5 presenta LL e Brier maggiori ma ECE minore in questo campione; ciò non autorizza una sostituzione operativa.

Il bootstrap interno Node e quello indipendente Python usano generatori casuali diversi, dichiarati nei protocolli. Con 500 repliche i limiti vicini a zero non sono stabili: nel confronto replica depth 3 meno no-ML, l'estremo superiore LL è +0,00000293 in Node e −0,000593 in Python; il Brier attraversa zero in entrambi. Non si sceglie il generatore più favorevole per dichiarare un miglioramento. I risultati non costituiscono validazione indipendente.

## C906 operativo e ricetta riaddestrata

L'artefatto congelato `C-906371b0b3a1e2c8`, SHA256 `3f18e05ee228d1c6fdbe92865b3b19635cdf68f3ecbd50ff53d83914b52993b3`, rimane distinto da `c906_recipe_retrained`. C906 è stato creato il 27 ottobre 2026 e registrato il 29 ottobre: non esisteva nelle stagioni test. La sua serie operativa valida ha **N=0**, così come la ricostruzione che rispetta il cutoff di calibrazione e tutte le esclusioni del periodo. Non si retrodata l'artefatto.

Il nuovo controllo riprende la ricetta numerica: due regressori Poisson sui gol assoluti, legacy40 ordinate, CatBoost 1.2.8, 120 alberi di profondità 5, learning rate 0,05, seed 20261027, due thread; miscela 25% baseline A80 e 75% ML, temperatura 0,8. Modelli e calibrazione sono riaddestrati per ciascun semestre, senza riusare il profilo di 335 partite del 2026. Dati di fit, periodi e identità degli artefatti sono diversi dall'operativo. La [verifica della ricetta sui sei fold](evidence/c-three-season-backtest-2026-10-31/c906-recipe-verification.json) conferma identici parametri CatBoost effettivi e identiche 40 feature ordinate, senza equiparare gli artefatti.

`--include-c906-recipe` è facoltativo e ammesso solo con piano congelato e modalità controllata. Il settimo controllo non partecipa alla scelta dei sei candidati, anche quando ha la metrica di selezione migliore. È marcato diagnostico ed escluso dall'adozione; entrambi i percorsi di registrazione C lo rifiutano. Il percorso controllato rifiuta prima di accedere al database; i test della registrazione diretta provano l'assenza di scritture. La rifinalizzazione non aggira il divieto.

## Verifiche e affidabilità

- **Verificato:** hash degli input, esclusioni e copertura esatta; 4.892 test disgiunti; 84 artefatti grezzi/coerenti esaminati; 105.168 valori delle 16 feature aggiuntive ricostruiti indipendentemente; separazione fit/selezione/calibrazione/test; metriche individuali; identità C906; baseline raw invariata nella coorte comune.
- **Stimato:** orario Nightly nominale e disponibilità storica `kickoff + 2 ore`. Tutte le 7.486 partite concluse dell'archivio originale usano il proxy di disponibilità: non è una ricevuta di acquisizione reale del provider.
- **Non verificabile con questi dati:** prima disponibilità di xG/statistiche, revisioni storiche del provider, orario effettivo dei vecchi run, esattezza indipendente di ogni kickoff e vecchie quote Nightly. I 22 conflitti conosciuti sono isolati; non si garantisce l'assenza di conflitti sconosciuti. Le 40 feature legacy e la baseline non sono una nuova reimplementazione indipendente.

L'[audit temporale](evidence/c-three-season-backtest-2026-10-31/temporal-audit.json) passa con zero anomalie computazionali e zero target in quarantena. Il PASS verifica la coerenza con gli orari forniti, senza certificare la disponibilità storica effettiva. Architettura, iperparametri e pesi scelti nel 2026 vengono applicati retrospettivamente al 2023–26: questo limite di selezione resta anche con fit cronologici puliti. Le coorti sono già state consultate: nessun nuovo holdout indipendente è dichiarato.

**Economia:** zero partite con quote Nightly autentiche ammissibili in questo input. ROI, drawdown e profitto sono **non misurabili**, non zero. L'assenza di quota non dimostra un rifiuto sportivo del modello; 4.892 valutazioni di probabilità non sono 4.892 giocate. Non si usano quote sintetiche o closing posteriori.

**Protezione di A:** 63 sorgenti esterni a research e 5 file di fixture/regressione mantengono gli stessi hash della revisione iniziale `325e70097428fb8cef9c1f749f8b3a7ed520b6d0`. Passano le 7 regressioni A: controllo di 36 sorgenti e 6 casi golden su probabilità, calibrazione, filtri, ranking e stake. [Prova completa](evidence/c-three-season-backtest-2026-10-31/operational-a-immutability.json). Le modifiche runtime sono limitate ai blocchi di registrazione C; nessuna configurazione, calibrazione o registrazione produttiva di A è stata modificata. I trigger di push escludono `backend/src/research/**` dal riscaldamento della calibrazione A; non è stato avviato quel workflow.

Controlli locali: build, typecheck e lint backend passati; 67 test Node mirati passati, compresi A, selettori, lifecycle e adozione con database isolati. I nuovi script Python e il replay degli artefatti pubblicati sono verificati nel registro di esecuzione allegato prima della consegna. La CI completa viene riportata nel medesimo registro dopo il push. Non si equiparano questi controlli a una verifica della web app in produzione.

## Riproducibilità e consegna

[Comandi e ripristino degli input](evidence/c-three-season-backtest-2026-10-31/README.md). Sono pubblicati dataset byte per byte, piano congelato, 42 artefatti coerenti in sei archivi, riferimenti al C906 autentico, probabilità individuali, hash e strumenti di ricalcolo. I metadati del training pubblicati omettono le matrici duplicate del report grezzo; le matrici si rigenerano da input, codice e ricetta dichiarati. Non vengono presentati come copia byte per byte dell'intero report grezzo.

Il C corrente resta in servizio secondo il registry già esistente; questo task non esegue deploy né adozioni. Per valutare miglioramenti operativi servono ancora raccolta prospettica indipendente e quote autentiche disponibili alla decisione.
