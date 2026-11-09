# Scelte scartate e applicabilità al modello C

Questo catalogo conserva le decisioni negative e i loro limiti, per evitare di ripetere esperimenti già svolti. Un NO-GO riguarda la variante e il protocollo effettivamente provati: non dimostra che ogni variante della stessa idea sia inutile. I risultati su A non sono automaticamente risultati su C e una minore log loss non dimostra profitto.

## Come leggere le prove

- **Luglio 2026:** studi originari sul modello e sulle famiglie di mercato indicate. Numeri di studi diversi non vanno sottratti fra loro: campioni, eventi e calibrazione cambiano. Il vecchio ECE goal 0,0019 riguarda quella pipeline e quel campione, non è una misura attuale universale.
- **3 ottobre 2026:** retest appaiato di 16 varianti sulla pipeline A di allora, con 8.908 partite goal e 8.528 partite cartellini/tiri in porta nelle cinque stagioni 2021/22–2025/26 e cinque leghe. Le 380 esclusioni non-goal sono dovute ai requisiti di storico, identici per confronto e variante. Il controllo principale usa calibrazione fuori campione cronologica, con previsioni precedenti per inizializzarla; confronta le stesse partite e linee, non le sole giocate selezionate. Gli IC95% sono bootstrap appaiati di 2.000 repliche su 25 blocchi lega/stagione, stratificati per lega; i p-value sono corretti Holm, gli IC non simultanei. Si ricampionano previsioni già prodotte, senza rifare ogni fit. Con sole cinque stagioni l'evidenza rimane esplorativa e non cattura necessariamente shock comuni a tutte le leghe. Per il criterio storico servivano IC favorevole, p corretto <0,05 e miglioramento in almeno 4/5 leghe e 4/5 stagioni. Nessuna variante ha soddisfatto tutto.
- **31 ottobre e 3 novembre 2026:** confronti di sviluppo C su sei finestre temporali e 4.892 target comuni 2023/24–2025/26. Le coorti sono già state consultate e non sono una nuova prova indipendente. Il vero C906 congelato è stato creato dopo quelle stagioni: il suo confronto storico rigoroso ha **N=0**. Una ricetta riaddestrata per fold è un controllo diagnostico, non il modello operativo retrodatato.

Log loss (LL), Brier ed ECE più bassi sono preferibili; Δ negativo indica miglioramento. Le percentuali seguenti sono variazioni relative della LL, salvo dove è esplicitato un delta assoluto. Non confrontare valori assoluti fra goal, booking points, gialli e tiri: sono eventi diversi.

Dettaglio e provenienza: [retest del 3 ottobre: risultati e metodo](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/retest-discarded-2026-10-03/README.md), con [tabella completa](performance/retest-discarded-2026-10-03/final-table.json), [inventario](performance/retest-discarded-2026-10-03/inventory.json), [per lega](performance/retest-discarded-2026-10-03/paired-perLeague.csv) e [per stagione](performance/retest-discarded-2026-10-03/paired-perSeason.csv). Il commit identifica una versione storica immutabile; i dati numerici collegati rimangono locali nel progetto.

## Decisioni sui goal: esperimenti A, non prove di miglioramento C

| Famiglia e variante | Evidenza e decisione | Applicabilità a C |
|---|---|---|
| **Recent Form, decay 0,01 / 0,02 / 0,04 / 0,08 per settimana** | Nel 2026-10 Δ LL OOS rispettivamente −0,0071%, +0,0005%, −0,0065%, −0,018%; nessuna supera il criterio completo, p Holm rispettivamente 0,4898, 1, 1, 1. Per 0,02: luglio, Dixon–Coles isolato −0,50%, ma ensemble calibrato solo −0,02%, p=0,65, ECE 0,0019→0,0037, n=5.282. | **Non riproporre la stessa correzione.** C contiene già punti e differenza reti delle ultime cinque gare. Questo non dimostra però che C abbia già incorporato la stessa formula di decay. |
| **Vantaggio casa per squadra: fit congiunto** | 2026-10 Δ LL OOS −0,010%, 3/5 leghe, 2/5 stagioni, p Holm 1; con controllo che applica la scala globale anche alla mappa −0,0017%. La specificità per squadra è confusa con la scala. | C usa statistiche di casa/trasferta e lambda della baseline; non è la stessa formula per squadra. Nessun beneficio trasferibile dimostrato. |
| **Vantaggio casa centrato, peso 1, half-life 200 giorni** | 2026-10 ricostruzione della formula, non replica verificata dello scratchpad: Δ OOS +0,851%, IC95% [+0,003942; +0,006359], p Holm 0,004, 0/5 leghe e stagioni migliori. | **NO-GO** per quella ricostruzione; non aggiungerla a C sulla base della teoria. |
| **Dynamic xG globale** | Luglio: LL calibrata −0,07% rispetto al peso fisso 0,80, non rilevante. Nel retest 2026-10 la griglia 0,4/0,6/0,8/1 è ricostruita, non la griglia originale verificata: Δ OOS +0,0013%, p Holm 1. | **NO-GO** per la variante provata; C include già xG/xGA e lambda della baseline. |
| **Dynamic xG per squadra** | Luglio: LL −0,01/−0,02%, compatibile con rumore. Non replicato nel 2026-10: formula adattiva e soglie storiche mancanti. | **Non riproducibile esattamente**; inventare le soglie sarebbe una nuova ipotesi, non la stessa prova su C. |
| **Shot Quality Adjustment** | Luglio: LL −0,24% sul modello isolato, solo −0,05% aggiuntivo sull'ensemble; ECE 0,0019→0,0026. Prior, intensità e formula completa mancanti nel retest. | **Non riproducibile esattamente**; C riceve già xG e tiri, ma non si può dedurre che calcoli quella specifica regolarizzazione. |
| **Calibrazione per forza squadra** | Luglio: due fasce LL 0,59924→0,59915, p=0,48, ECE 0,0019→0,0022; tre fasce LL 0,59924→0,59907, p=0,35, ECE 0,0019→0,0037. Cutoff storici non conservati. | **Non riproducibile esattamente.** C ha una calibrazione coerente, ma non è la stessa stratificazione; frammentare i campioni non è un beneficio dimostrato. |
| **Assenze, algoritmo originario** | Luglio: LL 0,59924→0,59933, p=0,90; 3.040/5.582 gare con almeno un assente. Formula documentata: titolare con almeno 60 minuti in almeno il 60% delle ultime dieci gare; moltiplicatore `1 − min(0,18, quota_xG × 0,4)`. Nel 2026-10 non replicato: mancano revisioni storiche attendibili di roster/assenze disponibili prima del kickoff. | **Non trasferibile con i dati mancanti.** La formazione finale non dimostra la conoscenza prepartita. Un eventuale segnale diverso richiederebbe dati di disponibilità realmente storicizzati e nuova prova. |
| **Assenze avanzate per ruolo, attacco e difesa** | Luglio: LL 0,59924→0,59912, p=0,57; coefficienti storici non documentati e stessi limiti sui roster. | **Non riproducibile esattamente**; nessun miglioramento C dimostrato. |

Fonti storiche: [forma recente e xG dinamico](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/recent-form-half-life-2026-07.md), [vantaggio casa](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/per-team-home-advantage-analysis-2026-07.md), [ensemble e qualità tiro](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/ensemble-poisson-xg-2026-07.md), [assenze e forza squadra](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/player-adjustment-strength-calibration-2026-07.md), [ablazioni](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/feature-ablation-2026-07.md).

## Cartellini e tiri: mercati diversi dai goal C

C qui produce una distribuzione congiunta dei goal; le conclusioni seguenti riguardano modelli e linee di cartellini o tiri, non una modifica dimostrata a quella distribuzione. Per i totali cartellini la semantica corrente è **gialli + 2 × rossi**, non soli gialli.

| Variante | Retest A del 2026-10, Δ LL OOS | Decisione e limiti |
|---|---:|---|
| B6, media gialli per lega nel **modello squadra** | −0,042%, IC95% [−0,001837; +0,001476], p Holm 1, 3/5 leghe | Nessun beneficio robusto, ECE 0,042140→0,052417. Nel luglio precedente il raw peggiorava dello 0,38%, p=0,016 nella direzione peggiore. Questo non va confuso con il parametro per lega del **modello giocatore**, valutato separatamente. |
| B1, gialli separati casa/trasferta | +0,537%, IC95% [+0,001985; +0,005031], p=0,003, 0/5 leghe migliori | NO-GO; anche luglio peggiorava in 5/5 leghe. |
| D2, correlazione gialli casa/ospite ρ=0,12 | −0,011%, IC95% [−0,000393; +0,000273], p=1, 2/5 leghe | Nessun beneficio robusto; la correlazione empirica storica era circa 0,18, ma non basta a dimostrare guadagno. |
| D5, rapporto tiri in porta/tiri grezzi | +0,922%, IC95% [+0,003779; +0,008508], p=0,0005, 1/5 leghe | NO-GO; luglio peggiorava dell'1,22%. Il segno negativo usato nel testo storico era improprio. |
| D3, media rossi per lega nei booking points | −0,201%, IC95% [−0,001598; −0,000975], p=0,003, 5/5 stagioni ma **3/5 leghe** | Miglioramento medio nel campione, non uniforme; non adottato globalmente. Non è un risultato sui goal C né una prova di ritorno economico. |
| D1, vecchio fattore falli con propagazione coerente | +1,483%, p=0,003, 0/5 leghe | NO-GO per la ricostruzione esplicita; non una replica verificata della vecchia formula. |
| D1, blocco legacy esatto solo gialli | +1,706%, p=0,0035, 0/5 leghe | NO-GO per il blocco riprodotto. |
| D1, gialli indotti dall'avversario | +1,579%, p=0,003, 1/5 leghe | NO-GO per la ricostruzione esplicita; coefficienti storici non tutti verificabili. |

Fonti storiche: [parametro gialli per lega](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/per-league-yellow-param-2026-07.md), [B1/D1/D2](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/cards-opponent-bundle-b1-d1-d2-2026-07.md), [D5/D3](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/shots-ot-d5-reds-d3-2026-07.md).

## Giocatori: marcatore anytime

Nello studio di luglio, su 85.894 osservazioni giocatore-partita, `goals/90` anziché `xG/90` aveva LL 0,367 contro 0,256, Brier 0,072 contro 0,071, ECE 0,026 contro 0,013: **NO-GO** per l'alternativa valutata. Aggiungere la difesa avversaria all'xG/90 lasciava LL 0,256 e Brier 0,071, con ECE 0,014 contro 0,013: nessun vantaggio dimostrato. Il retest 2026-10 non ha potuto replicarli sulle cinque stagioni perché le feature giocatore as-of e i minuti previsti sono incompleti; la formula del primo confronto è nota, il moltiplicatore difensivo storico no. Questi sono modelli giocatore, non alternative dirette alla matrice goal squadra C. [Fonte storica anytime](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/anytime-scorer-e5-2026-07.md).

## Verifiche già svolte direttamente su C

**Diagnosi ML, 27 ottobre 2026: risultati esplorativi, non candidati approvati.** Fuori dai 745 target protetti, tre fold su 2.261 confronti appaiati e 49 settimane esaminarono 144 configurazioni. Questi dati precedono l'audit dei 22 ID in conflitto e non dimostrano disponibilità prepartita affidabile. Gli intervalli nominali non correggevano per tutte le configurazioni e la selezione: un valore migliore su questo sviluppo già consultato non è una conferma indipendente.

| Scelta o controllo | Risultato e decisione |
|---|---|
| **Maschera di feature globale** | Una versione preliminare usava selezioni di tre finestre anche per fold precedenti: era lookahead ed è stata **invalidata**, pur senza usare i 745 target protetti. La versione corretta sceglie una maschera usando solo selezioni disponibili al fold. |
| **Feature ridotte e ablazioni** | Con correzione intensità e calibrazione coerente, la maschera valida usa 13, 7 e 10 feature nei tre fold; aggregato LL 0,978515/Brier 0,581907 contro 0,978755/0,582026 delle 40 feature. Non dimostra superiorità dopo la selezione multipla. I gruppi base, xG, forma, Elo e casa/trasferta separati non mostrano un'aggiunta singola uniformemente utile. Non esiste una lista dimostrata di feature eliminabili senza perdita futura. |
| **Finestra delle label e pesi temporali** | Solo ultime label di 730 giorni: LL 0,979376/Brier 0,582281; pesi con emivita 365 giorni: 0,977472/0,581329. Sono risultati di sviluppo dopo molte prove, senza adozione. I 730 giorni limitavano le **label ML**, non le medie storiche già contenute nelle feature A. |
| **Regolarizzazione e correzione probabilistica** | Configurazioni di diversa complessità restano esplorative; il multiclass aveva nell'ultimo fold LL training 0,942036 e controllo 0,986698, contro 0,962954 e 0,984013 della correzione intensità. Il divario è compatibile con adattamento o cambiamento del periodo: non identifica una causa unica e non dimostra che un'intera famiglia sia sempre peggiore. |
| **Temperatura senza ML** | Applicare solo la temperatura ad A, senza CatBoost, portava LL 0,984369→0,980031 e Brier 0,585145→0,582837. Rispetto allo stesso controllo, gli IC95% settimanali C−A erano [−0,004895; +0,000213] per LL e [−0,003077; +0,000100] per Brier: entrambi comprendono zero. Non si attribuisce quindi tutto il guadagno apparente al ML. |
| **Calibrazione legacy non coerente** | Il vecchio post-processing correggeva marginali separati: il benchmark normalizzava 1X2, mentre il motore decisionale poteva usare valori non normalizzati. È un difetto matematico verificato, non una feature da riattivare. Il percorso coerente normalizza 1X2 e riproietta la matrice, ma il suo ECE migliore su quei controlli non dimostra miglioramento uniforme di LL/Brier. |

Nel confronto A/C iniziale, il test finale di 745 partite aveva dopo calibrazione LL A 1,003212 e C 0,998452, ma entrambi gli IC95% settimanali delle differenze LL e Brier includevano zero; ECE A 0,025810 e C 0,033685. L'esito era **inconcludente**, non una prova di inferiorità generale. Quei 745 risultati sono già stati letti e protetti: non vanno riutilizzati per scegliere o certificare una variante. Fonti: [diagnosi e metodo storici](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/ml-diagnosis-2026-10-27.md), [diagnosi numerica completa](performance/ml-diagnosis-2026-10-27.json), [risultati A/C originali](performance/research-ac-2026-10-27.json), [confronti C controllati successivi](performance/c-hybrid-improvements-2026-10-31.json). Questi ultimi precedono la politica di qualità dei dati: la coorte di 1.975 partite è diagnostica e **non** costituisce prova prepartita valida dopo l'audit dei 22 ID in conflitto.

**Feature recenti e calendario, 31 ottobre 2026.** Su 4.892 partite comuni: la replica C depth 3 aveva LL 0,978255 e Brier 0,582688; `intensity_recent_xg` 0,981361 e 0,583434; `intensity_schedule` 0,981601 e 0,583592; entrambe insieme 0,981256 e 0,583474. La ricetta C906 depth 5 riaddestrata aveva 0,981089 e 0,584577. I bracci con nuove feature usano anche una diversa correzione delle intensità e diversi pesi: **non isolano il solo effetto delle feature sulla ricetta C906**. Non provano quindi che un blocco sia inutile in qualunque modello, né certificano un miglioramento futuro. Il codice supporta blocchi sperimentali di xG recenti corretti per avversario e calendario osservato; non significa che siano entrati nell'artefatto C906. [Dati e confronto storico](https://github.com/Ivandragon003/scommeseSportive/blob/6ed36d449418fc155f39f37371bc8c1ef5b56846/docs/performance/c-three-season-backtest-2026-10-31.md).

**TimesFM 2.5, 3 novembre 2026: NO-GO, esito inconclusivo.** La ricetta C906 è stata riaddestrata per ciascuno dei sei fold; i due bracci aggiungono quattro previsioni complessive: xG e xGA per ciascuna delle due squadre ottenute rispettivamente da medie pesate esponenziali e TimesFM, mantenendo la stessa ricetta e calibrazione. Sulle stesse 4.892 partite, LL/Brier: C rifit **0,981089/0,584577**, C + medie **0,980425/0,584239**, C + TimesFM **0,980892/0,584550**. ECE top-label rispettivamente 0,007628, 0,008605, 0,006331. Delta TimesFM meno C: LL −0,000196 e Brier −0,000027; IC simultanei 98,75% settimanali rispettivamente [−0,003712; +0,003283] e [−0,002480; +0,002350]. Contro le medie: LL +0,000467 e Brier +0,000311; IC [−0,003022; +0,003876] e [−0,002130; +0,002754]. Anche la sensibilità a blocchi mobili di quattro settimane non supera il criterio; 0/5 leghe migliorano congiuntamente entrambe le metriche contro entrambi. I 10.000 ricampionamenti mantengono le partite appaiate e sono condizionati ai modelli già stimati. Non sono dimostrati né beneficio né equivalenza; non si ripete la ricerca sullo stesso test per ottenere un GO.

L'esperimento non usa quote Nightly reali per blending e non misura ROI. L'as-of locale non certifica l'assenza di sovrapposizione fra pretraining del modello e storico; checkpoint e scelte sono successivi a parte dei periodi valutati. L'errore massimo rispetto alle probabilità pubblicate della ricetta C rifit è 5,55×10⁻¹⁶. Codice e risultati sperimentali locali sono stati ritirati su richiesta; questo esito resta per evitare ripetizioni. Il [report storico](https://github.com/Ivandragon003/scommeseSportive/blob/03db58dc38076891e2fe8b2ba73ef89afad0e8ee/docs/performance/timesfm-c-2026-11-03.md) è consultabile nel commit immutabile precedente alla rimozione.

## Varianti C non adottate

Le prove seguenti confrontano varianti isolate con la ricetta di riferimento
senza proiezione. Non sono nuovi confronti contro la release operativa corrente.
Le coorti sono già state consultate: i criteri diagnostici servono a scartare
varianti, non a certificare capacità predittiva futura. LL e Brier inferiori
sono preferibili. Salvo diversa indicazione, il confronto finale usa 652 gare
appaiate, calibrazione coerente e le stesse quote reali Bet365 di chiusura;
non riproduce le esecuzioni Nightly e non misura ROI/CLV.

| Variante | Criterio ed esito | Prova immutabile |
|---|---|---|
| Rifit con dati più recenti | Ricetta fissa; training 5.968 gare e calibrazione 595 successive. Sulle 57 diagnostiche dopo blending LL 0,941171→0,951103 e Brier 0,549377→0,555396, con ECE peggiore. Non adottato; campione piccolo e già osservato, nessuna bocciatura generale del riaddestramento. | [Riepilogo](performance/evidence/c-training-refresh-2026-11-08/summary.json) |
| Ensemble di cinque seed, pesi uguali | Criterio sviluppo: LL e Brier migliori sulle 317 gare e in almeno 4/5 leghe. LL 0,964956→0,968120 e Brier 0,573749→0,576032; peggiorano in 5/5 leghe. Arresto prima delle diagnostiche successive. | [Riepilogo](performance/evidence/c-seed-ensemble-2026-11-08/summary.json) |
| Estremi dei plateau isotonici | Difetto di rappresentazione riprodotto; la correzione migliora il fitting. Dopo blending LL 0,985187→0,984515 e Brier 0,586461→0,585904, ma solo 3/5 leghe migliori contro almeno 4/5 richieste e IC comprendenti zero. Non adottata; miglior fitting non equivale a migliore previsione. | [Riepilogo](performance/evidence/c-parameter-audit-2026-11-08/summary.json) |
| Foglie vuote: media del primo antenato supportato | Training grezzo invariato; sul confronto finale 4/5 leghe migliori, Ligue 1 peggiore. Fallisce criterio 5/5; IC globali comprendenti zero. | [Riepilogo](performance/evidence/c-tree-empty-leaf-backoff-2026-11-08/summary.json) |
| Foglie vuote: vicini a minima distanza Hamming | Training grezzo invariato; dopo blending migliorano entrambe le metriche in 3/5 leghe, peggiorano La Liga e Premier League. Fallisce criterio 5/5. | [Riepilogo](performance/evidence/c-tree-neighbor-backoff-2026-11-08/summary.json) |
| Sei pesi per blocchi di alberi | Scelta su sviluppo cronologico e refit sui 317 esempi. Dopo blending LL 0,985187→0,985817 e Brier 0,586461→0,587068; migliorano solo Bundesliga e La Liga. Fallisce criterio finale 5/5, ECE peggiore. | [Risultati](performance/evidence/c-tree-weight-research-2026-11-08/summary.json), [selezione](performance/evidence/c-tree-weight-research-2026-11-08/selection.json) |
| Regolarizzazione L2=10 o 30 | Prima verificata la riproduzione della ricetta. Nessuna variante migliora LL e Brier di sviluppo in 5/5 leghe: arresto prima di candidata finale e calibrazione. | [Riepilogo](performance/evidence/c-tree-l2-research-2026-11-08/summary.json) |
| Ordered boosting | Variante unica contro Plain, altri parametri fissi. Non migliora entrambe le metriche in 5/5 leghe sullo sviluppo; arresto prima del replay. | [Riepilogo](performance/evidence/c-tree-ordered-research-2026-11-08/summary.json) |
| Shrinkage gerarchico | Tre intensità prefissate; beneficio congiunto in 2/5, 3/5 e 3/5 leghe. Nessuna supera il filtro 5/5 sullo sviluppo. | [Riepilogo](performance/evidence/c-tree-hierarchical-research-2026-11-08/summary.json) |
| Sei pesi minimax fra leghe | Quattro regolarizzazioni, fit solo training; tutte migliorano il training ma soltanto 2/5 leghe nella selezione successiva. Nessuna candidata finale. Non estendere la ricerca sullo stesso campione già consultato. | [Riepilogo](performance/evidence/c-tree-minimax-research-2026-11-08/summary.json) |
| Rifit senza contatori negli split | `ignored_features` conserva schema di 40 input. Sulle 317 gare migliorano LL e Brier in 3/5 leghe, peggiorano Premier League e Serie A. Fallisce criterio 5/5; niente calibrazione o replay successivo. Non è la proiezione post-fit adottata. | [Riepilogo](performance/evidence/c-tree-ignored-samples-research-2026-11-08/summary.json) |
| Una iterazione Newton invece di dieci | Variante fissa valutata comunque dopo calibrazione; beneficio congiunto solo Premier League e Serie A. LL finale 0,985187→0,985306, Brier 0,586461→0,586719; IC comprendenti zero. ECE aggregata migliore non compensa il mancato beneficio primario. | [Riepilogo](performance/evidence/c-tree-newton-one-research-2026-11-08/summary.json), [verifica](performance/evidence/c-tree-newton-one-research-2026-11-08/verification.json) |

Le verifiche native e indipendenti associate alle prove attestano calcoli e
compatibilità tecnica, non generalizzazione. Una variante respinta non dimostra
che ogni possibile metodo della stessa famiglia sia inutile; non giustifica
però ripetere microvarianti sugli stessi test fino a ottenere un vincitore.

## Confini delle prove sulla proiezione precedentemente adottata

La proiezione dei valori delle foglie è stata una scelta operativa esplicita.
La release corrente `opportunity_guard` la sostituisce con una testa congiunta
e un filtro delle opportunità; questi risultati storici rimangono invariati.
Il confronto diagnostico su 652 gare migliorava LL e Brier in 4/5 leghe,
peggiorando La Liga: falliva il criterio prefissato 5/5.
Il confronto cronologico su 8.541 gare con nuovi fit annuali mostra un
miglioramento medio piccolo, in 3/5 leghe, 4/5 finestre e 13/25 celle
lega/stagione. ECE aggregata peggiora e gli IC delle differenze includono zero.
Non costituisce validazione scientifica o prova di redditività; il 2025/26 si
ferma al 4 aprile. La scelta operativa non modifica questi esiti.

Prove: [diagnostica](performance/evidence/c-tree-sample-projection-2026-11-08/summary.json),
[cinque finestre](performance/evidence/c-five-season-projection-2026-11-08/summary.json),
[CSV lega/stagione](performance/evidence/c-five-season-projection-2026-11-08/season-league-comparison.csv).
Il meccanismo della release corrente è nel [modello C](models/MODEL-C.md);
la proiezione storica rimane riproducibile secondo la [guida Research](research-platform.md#proiezione-delle-foglie-della-release-precedente).

## Filtro del vantaggio sulle quote della testa congiunta

La ricetta `opportunity_guard` riduce il ROI simulato delle principali da
−3,74% a −1,62% su cinque stagioni precedenti e quella corrente. Restano
3.082 AH dopo il rifiuto delle opportunità binarie da parte del filtro appreso;
non viene imposto un veto manuale su 1X2 o Over/Under 2,5. Il beneficio è
parziale: peggiorano Bundesliga e Ligue 1 e l'intervallo del miglioramento
comprende zero. Non sono dimostrate redditività o maggiore accuratezza delle
probabilità. Il criterio scientifico non è superato.

L'utente ha scelto esplicitamente questa ricetta per la nuova release C,
con una sola principale per partita nella Nightly. Questa scelta operativa
non modifica la conclusione scientifica; la precedente proiezione non è più
il modello corrente. A e i suoi parametri non sono modificati dall'adozione.
Metodo e limiti: [Research](research-platform.md#filtro-del-vantaggio-stimato-sulle-quote).

## Non sono bocciature empiriche da ripetere

- **Corner B2, concessi dall'avversario:** il documento luglio lo indicava come bloccato; la verifica successiva e il codice corrente mostrano che il dato di corner concessi è già collegato. Il vecchio studio riportava LL 5/5 leghe migliore, ma non dimostrava impatto economico. Non riproporlo come assente. Corner e falli rimangono comunque disabilitati per le giocate finché non esistono quote reali sufficienti e un backtest di mercato favorevole; quote sintetiche non dimostrano value.
- **Correzione di livello:** già implementata nel Dixon–Coles. Il percorso research `ForecastCore.fitBaseline` chiama `fitModel`, che stima la correzione, e usa i lambda risultanti per ricostruire la matrice; l'istanza usata nella ricostruzione ha `levelCorrection` vuoto per non applicarla una seconda volta. Non è dimostrata una correzione mancante in C né un'opportunità di migliorarla.
- **Dispersione/calibrazione tiri:** vecchio candidato opzionale, non bocciatura eseguita. La misura storica grezza di ECE 0,06–0,12 non dimostra un miglioramento dopo calibrazione e blending. Eventuale verifica separata dei mercati tiri richiederebbe metriche su tutte le predizioni e beneficio nella pipeline completa in almeno 4/5 leghe.
- **COM-Poisson/underdispersion, Monte Carlo delle combo, Hessiana e `ShotsModel` giocatore scollegato:** sono semplificazioni, approssimazioni o codice non collegato; non sono varianti dimostrate peggiori da un confronto omogeneo. Il loro stato di utilizzo va verificato nel codice prima di qualsiasi rimozione o collegamento.

## Ipotesi future e vincoli

Non emerge una modifica ad alta priorità o con beneficio C dimostrato. La disponibilità prepartita di giocatori/assenze attendibile e storicizzata è una possibile ipotesi di ricerca a bassa priorità, diversa dalle formule già bocciate; prima servirebbero copertura, timestamp e confronto appaiato sulla ricetta completa. Analogamente, un nuovo blocco xG o calendario richiederebbe una **ipotesi sostanzialmente nuova** e un confronto che cambi solo quel blocco, considerando che forme recenti, riposo e xG sono già presenti nelle 40 feature legacy. D3 riguarda invece una possibile ricerca separata sui booking points, non il modello goal C. Nessuna di queste osservazioni autorizza un esperimento, una modifica o una candidatura.

Per ogni eventuale studio futuro: identificare il modello e il mercato; congelare in anticipo ipotesi, confronto e metriche; rispettare disponibilità as-of e ritardo risultati; escludere i 745 target protetti e applicare la quarantena dei 22 ID anche alla storia richiesta dalle nuove feature; non confondere la baseline canonica già congelata con una sua riscrittura. Separare training, selezione, calibrazione e test; confrontare le stesse partite su LL, Brier e calibrazione dopo l'intera pipeline, aggiungendo quote solo se reali e disponibili all'istante corretto. Le coorti storiche già consultate restano sviluppo, non una nuova conferma indipendente. Per un'eventuale adozione si applicano le regole prospettiche già esistenti: candidati congelati prima degli esiti, primi 500 `FUTURE_TEST`, almeno quattro leghe, quattro mesi e quattro periodi, confronto appaiato e valutazione unica. Questo catalogo non registra candidati e non riserva un nuovo campione.

## Modello A: xG/xGA distinti per sede

**Non adottati:** ramo Poisson-xG con quattro indici per squadra (xG fatti e
concessi in casa e trasferta), shrinkage fisso di otto gare e scala dei gol
stimata dal training. Replay grezzo su 6.022 ID, cinque leghe e stagioni
2022/23–2026/27, storico minimo 300 gare, refit ogni 60, risultati disponibili
con proxy kickoff + due ore; stesso Dixon–Coles e peso ensemble 0,5.

| Periodo | N | Brier aggregato / per sede | LL aggregata / per sede |
|---|---:|---:|---:|
| Precedente al 2026/27 | 5.574 | 0,24107 / 0,24137 | 0,67501 / 0,67564 |
| 2026/27 separato | 448 | 0,23540 / 0,23599 | 0,66294 / 0,66426 |
| Totale | 6.022 | 0,24065 / 0,24097 | 0,67412 / 0,67479 |

Gli IC95% appaiati del delta Brier sono [−0,000321; +0,000942] nel primo
periodo e [−0,001920; +0,003057] nel secondo: includono zero. Il periodo
2026/27 era già consultato; contesto operativo, calibrazione e blending non
sono riprodotti integralmente. Nessun beneficio robusto o economico dimostrato;
non trasferire automaticamente l'esito ad altre formule o a C.

Riproduzione: `backend/experiments/model-a-venue/venue-model.js` e `replay.js`.
Input, `summary.json` con hash e `predictions.jsonl` sono negli artefatti locali
`artifacts/model-a-venue/`; conservarli insieme, non sono automaticamente
versionati. Nessuna nuova prova è autorizzata dalla presenza di questo catalogo.
