# Retest degli algoritmi scartati sul modello attuale — 3 ottobre 2026

Analisi richiesta dall’utente; nessuna modifica al modello operativo, alla configurazione, ai dati persistiti. Le correzioni DB/nightly precedenti risultano pubblicate: [CI](https://github.com/Ivandragon003/scommeseSportive/actions/runs/37140180162) e [nightly](https://github.com/Ivandragon003/scommeseSportive/actions/runs/37139923345) completate con successo.

## Campione e interpretazione

8.908 partite nelle cinque stagioni complete **2021/22–2025/26**, nelle leghe Serie A, Premier League, La Liga, Bundesliga e Ligue 1. Per ricostruire il passato sono disponibili anche 7.203 partite di riscaldamento dal 2017/18 al 2020/21. Ogni variante è confrontata con il modello attuale sulle stesse partite e sulle stesse linee disponibili; niente selezione dei soli pronostici vincenti o delle sole giocate consigliate.

La calibrazione OOS viene inizializzata prevedendo cronologicamente gli ultimi 450 match precedenti al 2021/22 di ciascuna lega; questi 2.250 forecast restano esclusi dalle metriche finali. Lo storico ancora precedente serve per ricostruire training e contesto disponibili.

“Prima” significa modello attuale; “dopo” significa modello attuale con **una sola variante**. La log-loss (LL) più bassa è migliore; Δ negativo indica miglioramento. Le famiglie goal, booking points, gialli e tiri in porta hanno eventi diversi: confrontare prima/dopo dentro la singola riga, non i valori assoluti tra famiglie. Le probabilità misurano qualità predittiva, non rendimento economico.

Le colonne LL prima/dopo e Δ attuale utilizzano la calibrazione runtime corrente. Il controllo **OOS** usa invece curve e pesi del mercato appresi soltanto dai pronostici fuori campione dei fold precedenti: è il riferimento primario per giudicare la robustezza. La calibrazione runtime ricalcola pronostici passati senza garantire che siano fuori campione rispetto al fit, usando i loro xG realizzati; le partite target del test restano comunque fuori campione temporale.

Per goal sono valutabili tutte le 8.908 partite; cartellini e tiri in porta coprono **8.528 partite (95,73%)**. Le 380 esclusioni derivano tutte dal gate corrente: almeno otto precedenti nel relativo campo casa/trasferta per ogni squadra e venti complessivi. Le statistiche finali nella fonte sono presenti, ma il modello non emette quei mercati quando lo storico e insufficiente; non viene forzata una previsione. Sono esclusioni identiche per baseline e varianti.

## Tabella prima/dopo

| Variante | N abbinato | LL prima | LL dopo | Δ attuale | Δ controllo OOS | Lettura dei dati |
|---|---:|---:|---:|---:|---:|---|
| Recent Form decay 0.01/settimana | 8908 | 0.611507 | 0.611443 | -0.011% | -0.0071% | Guadagno non robusto |
| Recent Form decay 0.02/settimana | 8908 | 0.611507 | 0.611376 | -0.022% | +0.0005% | Variazione media sfavorevole, non robusta |
| Recent Form decay 0.04/settimana | 8908 | 0.611507 | 0.611387 | -0.020% | -0.0065% | Guadagno non robusto |
| Recent Form decay 0.08/settimana | 8908 | 0.611507 | 0.611413 | -0.015% | -0.018% | Guadagno non robusto |
| Home advantage per-squadra: fit congiunto supportato | 8908 | 0.611507 | 0.611464 | -0.0071% | -0.010% | Guadagno non robusto |
| Controllo HA per-squadra: stessa scala globale applicata alla mappa † | 8908 | 0.611507 | 0.611596 | +0.015% | -0.0017% | Guadagno non robusto |
| HA centrato: specificita per-squadra w=1, half-life 200 giorni * | 8908 | 0.611507 | 0.614710 | +0.524% | +0.851% | Peggioramento significativo nel campione |
| Dynamic xG globale: griglia 0.4/0.6/0.8/1, validazione temporale interna * | 8908 | 0.611507 | 0.611508 | +0.0001% | +0.0013% | Variazione media sfavorevole, non robusta |
| B6 gialli media lega as-of | 8528 | 0.654121 | 0.648880 | -0.801% | -0.042% | Guadagno non robusto |
| B1 gialli casa/trasferta pesati | 8528 | 0.654121 | 0.657984 | +0.590% | +0.537% | Peggioramento significativo nel campione |
| D2 correlazione gialli rho=0.12 | 8528 | 0.654121 | 0.654997 | +0.134% | -0.011% | Guadagno non robusto |
| D5 raw SOT/raw shots | 8528 | 0.686569 | 0.714535 | +4.073% | +0.922% | Peggioramento significativo nel campione |
| D3 rossi media lega as-of | 8528 | 0.654121 | 0.651861 | -0.345% | -0.201% | Migliora in media; beneficio non uniforme fra leghe |
| D1 both, vecchio fattore falli con propagazione coerente * | 8528 | 0.654121 | 0.663293 | +1.402% | +1.483% | Peggioramento significativo nel campione |
| D1 both, blocco legacy esatto solo gialli | 8528 | 0.626471 | 0.635944 | +1.512% | +1.706% | Peggioramento significativo nel campione |
| D1 gialli indotti avversario, ricostruzione esplicita * | 8528 | 0.654121 | 0.664724 | +1.621% | +1.579% | Peggioramento significativo nel campione |

* Ricostruzione esplicita della formula documentata, oppure griglia non archiviata: non è una replica verificata del vecchio scratchpad. † Controllo aggiuntivo che applica anche agli HA per squadra la scala corrente; serve a distinguere specificità della squadra dall’aggiramento della scala globale. Nessuna configurazione è stata applicata al prodotto.

## Robustezza fuori campione

| Variante | LL OOS prima | LL OOS dopo | Δ LL OOS | IC 95% Δ LL | p corretto Holm | Leghe migliori | Stagioni migliori | Brier prima → dopo | ECE10 prima → dopo |
|---|---:|---:|---:|---|---:|---:|---:|---|---|
| Recent Form decay 0.01/settimana | 0.609480 | 0.609437 | -0.0071% | [-0.000090, 0.000004] | 0.4898 | 4/5 | 4/5 | 0.210568 → 0.210550 | 0.013412 → 0.013117 |
| Recent Form decay 0.02/settimana | 0.609480 | 0.609483 | +0.0005% | [-0.000069, 0.000074] | 1.0000 | 2/5 | 2/5 | 0.210568 → 0.210571 | 0.013412 → 0.013294 |
| Recent Form decay 0.04/settimana | 0.609480 | 0.609440 | -0.0065% | [-0.000143, 0.000066] | 1.0000 | 3/5 | 3/5 | 0.210568 → 0.210552 | 0.013412 → 0.013163 |
| Recent Form decay 0.08/settimana | 0.609480 | 0.609372 | -0.018% | [-0.000321, 0.000097] | 1.0000 | 3/5 | 4/5 | 0.210568 → 0.210527 | 0.013412 → 0.013053 |
| Home advantage per-squadra: fit congiunto supportato | 0.609480 | 0.609419 | -0.010% | [-0.000275, 0.000131] | 1.0000 | 3/5 | 2/5 | 0.210568 → 0.210517 | 0.013412 → 0.012457 |
| Controllo HA per-squadra: stessa scala globale applicata alla mappa † | 0.609480 | 0.609470 | -0.0017% | [-0.000182, 0.000164] | 1.0000 | 3/5 | 2/5 | 0.210568 → 0.210561 | 0.013412 → 0.013613 |
| HA centrato: specificita per-squadra w=1, half-life 200 giorni * | 0.609480 | 0.614668 | +0.851% | [0.003942, 0.006359] | 0.0040 | 0/5 | 0/5 | 0.210568 → 0.212798 | 0.013412 → 0.015135 |
| Dynamic xG globale: griglia 0.4/0.6/0.8/1, validazione temporale interna * | 0.609480 | 0.609488 | +0.0013% | [-0.000168, 0.000192] | 1.0000 | 3/5 | 3/5 | 0.210568 → 0.210583 | 0.013412 → 0.012708 |
| B6 gialli media lega as-of | 0.640986 | 0.640719 | -0.042% | [-0.001837, 0.001476] | 1.0000 | 3/5 | 3/5 | 0.224307 → 0.224258 | 0.042140 → 0.052417 |
| B1 gialli casa/trasferta pesati | 0.640986 | 0.644428 | +0.537% | [0.001985, 0.005031] | 0.0030 | 0/5 | 0/5 | 0.224307 → 0.225681 | 0.042140 → 0.046628 |
| D2 correlazione gialli rho=0.12 | 0.640986 | 0.640916 | -0.011% | [-0.000393, 0.000273] | 1.0000 | 2/5 | 4/5 | 0.224307 → 0.224383 | 0.042140 → 0.044793 |
| D5 raw SOT/raw shots | 0.672394 | 0.678596 | +0.922% | [0.003779, 0.008508] | 0.0005 | 1/5 | 0/5 | 0.238883 → 0.241442 | 0.060369 → 0.076355 |
| D3 rossi media lega as-of | 0.640986 | 0.639699 | -0.201% | [-0.001598, -0.000975] | 0.0030 | 3/5 | 5/5 | 0.224307 → 0.223811 | 0.042140 → 0.040966 |
| D1 both, vecchio fattore falli con propagazione coerente * | 0.640986 | 0.650492 | +1.483% | [0.007393, 0.011631] | 0.0030 | 0/5 | 0/5 | 0.224307 → 0.228125 | 0.042140 → 0.075012 |
| D1 both, blocco legacy esatto solo gialli | 0.612926 | 0.623381 | +1.706% | [0.007937, 0.012928] | 0.0035 | 0/5 | 0/5 | 0.211989 → 0.216071 | 0.036623 → 0.071843 |
| D1 gialli indotti avversario, ricostruzione esplicita * | 0.640986 | 0.651108 | +1.579% | [0.005428, 0.015428] | 0.0030 | 1/5 | 1/5 | 0.224307 → 0.228707 | 0.042140 → 0.091558 |

IC bootstrap individuali su 2.000 ricampionamenti abbinati di **intere stagioni dentro ciascuna lega**, con 25 blocchi lega/stagione e cinque strati di lega. Si preserva così la dipendenza tra settimane vicine, che condividono training e calibrazione. Il CSV conserva anche la sensibilità con blocchi settimanali. Il valore p è corretto con Holm per l’insieme dei candidati della stessa famiglia/stadio; gli IC non sono simultanei. La dicitura “robusto nel campione” richiede Δ negativo, IC interamente sotto zero, p Holm <0,05 e miglioramento in almeno 4/5 leghe e 4/5 stagioni. Il giudizio resta esplorativo, con sole cinque stagioni: il ricampionamento non preserva un eventuale shock della stessa stagione condiviso fra leghe. Si ricampionano le perdite dei forecast storici, non si rifittano tutti i modelli in ogni replica. Non è un’autorizzazione ad adottare la variante.

Controllo HA: la variante per squadra diretta ha Δ OOS -0.010%; applicando anche alla mappa per squadra la scala corrente il Δ è -0.0017%. La prima variante aggira la scala applicata al solo HA globale: il suo eventuale vantaggio non può essere attribuito automaticamente alla specificità della singola squadra.

## Dettaglio per lega

| Variante | Serie A | Premier League | La Liga | Bundesliga | Ligue 1 |
|---|---:|---:|---:|---:|---:|
| Recent Form decay 0.01/settimana | -0.0073% | +0.0021% | -0.023% | -0.0018% | -0.0046% |
| Recent Form decay 0.02/settimana | +0.016% | +0.0089% | -0.022% | +0.0049% | -0.0057% |
| Recent Form decay 0.04/settimana | -0.012% | +0.018% | -0.033% | +0.052% | -0.050% |
| Recent Form decay 0.08/settimana | -0.0018% | +0.012% | -0.052% | +0.072% | -0.110% |
| Home advantage per-squadra: fit congiunto supportato | -0.016% | -0.012% | -0.138% | +0.093% | +0.051% |
| Controllo HA per-squadra: stessa scala globale applicata alla mappa † | -0.019% | -0.021% | -0.033% | +0.044% | +0.035% |
| HA centrato: specificita per-squadra w=1, half-life 200 giorni * | +0.915% | +1.202% | +0.725% | +1.032% | +0.370% |
| Dynamic xG globale: griglia 0.4/0.6/0.8/1, validazione temporale interna * | -0.012% | -0.015% | +0.018% | +0.024% | -0.0038% |
| B6 gialli media lega as-of | +0.637% | -1.153% | +0.532% | -0.129% | -0.084% |
| B1 gialli casa/trasferta pesati | +0.337% | +0.461% | +0.795% | +0.208% | +0.841% |
| D2 correlazione gialli rho=0.12 | +0.0059% | -0.119% | -0.103% | +0.189% | +0.031% |
| D5 raw SOT/raw shots | -0.109% | +1.160% | +0.694% | +1.330% | +1.736% |
| D3 rossi media lega as-of | +0.015% | -0.738% | -0.088% | -0.159% | +0.028% |
| D1 both, vecchio fattore falli con propagazione coerente * | +1.479% | +1.404% | +0.337% | +3.321% | +1.302% |
| D1 both, blocco legacy esatto solo gialli | +1.811% | +1.436% | +0.577% | +3.657% | +1.567% |
| D1 gialli indotti avversario, ricostruzione esplicita * | +3.618% | -3.267% | +4.291% | +1.297% | +2.093% |

Valori: variazione percentuale della log-loss calibrata OOS sul campione abbinato di quella lega. I CSV includono anche il dettaglio per stagione e per combinazione lega/stagione.

## Effetto del mercato sulle varianti goal

Qui entrano solo le quattro chiavi disponibili nelle quote di apertura: 1X2 e over 2,5. La calibrazione delle sette chiavi goal e il blending di queste quattro chiavi usano universi diversi: i livelli di LL non vanno confrontati direttamente tra stadi.

| Variante goal | N con quote | LL blend prima | LL blend dopo | Δ blend attuale | Δ blend OOS |
|---|---:|---:|---:|---:|---:|
| Recent Form decay 0.01/settimana | 8907 | 0.602450 | 0.602425 | -0.0041% | -0.0007% |
| Recent Form decay 0.02/settimana | 8907 | 0.602450 | 0.602375 | -0.012% | +0.0025% |
| Recent Form decay 0.04/settimana | 8907 | 0.602450 | 0.602359 | -0.015% | -0.0083% |
| Recent Form decay 0.08/settimana | 8907 | 0.602450 | 0.602342 | -0.018% | -0.023% |
| Home advantage per-squadra: fit congiunto supportato | 8907 | 0.602450 | 0.602200 | -0.041% | -0.020% |
| Controllo HA per-squadra: stessa scala globale applicata alla mappa † | 8907 | 0.602450 | 0.602499 | +0.0082% | +0.0008% |
| HA centrato: specificita per-squadra w=1, half-life 200 giorni * | 8907 | 0.602450 | 0.604213 | +0.293% | +0.258% |
| Dynamic xG globale: griglia 0.4/0.6/0.8/1, validazione temporale interna * | 8907 | 0.602450 | 0.602402 | -0.0080% | +0.0090% |

Le quote sono medie di mercato di apertura football-data.co.uk, con chiusura conservata separatamente. Non sono prova di prezzi eseguibili presso uno specifico bookmaker. Le quote di chiusura non sono usate come fallback d’ingresso. Nessun ROI, CLV o risultato economico viene inferito. Per cartellini e tiri non esiste una serie di quote prepartita su tutte le cinque stagioni: il miglioramento di probabilità non dimostra un miglioramento delle giocate.

## Casi non riproducibili e completezza dei documenti

| Ipotesi | Risultato storico nei documenti | Perché il nuovo numero manca |
|---|---|---|
| Dynamic xG Blend per squadra | LL cal -0.01/-0.02%; rumore rispetto allo statico 0.80. | Documentato solo come adattivo alla ricchezza dati; formula, soglie e runner storico non disponibili. |
| Shot Quality Adjustment | LL -0.24% isolata; -0.05% aggiuntiva sopra ensemble; ECE 0.0019 -> 0.0026. | Descritta come regolarizzazione xG/tiro verso lega; prior, intensita e formula storica non disponibili. |
| Calibrazione famiglia x forza, 2 fasce | LL 0.59924 -> 0.59915 (-0.02%); Brier 0.20616 -> 0.20612; ECE 0.0019 -> 0.0022; p=0.48. | Fasce balanced/mismatch dalla probabilita favorito, fallback famiglia/globale: cutoff storico non documentato. |
| Calibrazione famiglia x forza, 3 fasce | LL 0.59924 -> 0.59907 (-0.03%); Brier 0.20616 -> 0.20608; ECE 0.0019 -> 0.0037; p=0.35. | Cutoff e definizioni delle tre fasce storiche non documentati; sceglierli oggi sarebbe nuovo disegno. |
| Player Adjustment assenze, algoritmo current | LL 0.59924 -> 0.59933 (+0.01%); Brier 0.20616 -> 0.20620; ECE 0.0019 -> 0.0008; p=0.90. 3040/5582 match con >=1 assente. | Formula ESATTA nota: titolare >=60min in >=60% delle 10 gare precedenti; multiplier 1-min(0.18,shareXg*0.4). Mancano roster/prepartita completi nelle cinque stagioni e revisioni storiche; non motivare con formula mancante. |
| Player Adjustment assenze avanzato, attacco/difesa/ruoli | LL 0.59924 -> 0.59912 (-0.02%); Brier 0.20616 -> 0.20610; ECE 0.0019 -> 0.0014; p=0.57. | Coefficienti per ruolo e difesa non documentati; inoltre stessi limiti roster/prepartita della variante current. |
| Anytime da goals/90 invece xG/90 | Goals/90 LL 0.367, Brier 0.072, ECE 0.026 contro xG/90 LL 0.256, Brier 0.071, ECE 0.013; n=85894 osservazioni player-match. | Formula ESATTA P=1-exp(-rate90*expectedMinutes/90). Dati player as-of/minuti previsti incompleti su cinque stagioni; BacktestingEngine attuale non valuta player. |
| Anytime xG/90 piu difesa avversaria | LL 0.256 e Brier 0.071 come xG puro; ECE 0.014 contro 0.013. Difesa non aggiungeva nulla. | Moltiplicatore difensivo esatto non documentato; limiti dati player as-of su cinque stagioni. |

Le assenze attuali e l’alternativa anytime goals/90 hanno formule note, ma mancano revisioni della rosa/assenze note prima del kickoff e copertura completa dei cinque anni. I roster postpartita non vengono usati per inventare una formazione prepartita. Per strength calibration, shot quality, dynamic xG per squadra e altre correzioni non sono archiviati i coefficienti o le soglie sufficienti a replicare il vecchio algoritmo.

Corner concessi e levelCorrection risultano già adottati nel codice corrente. COM-Poisson, Monte Carlo/Hessian, modelli giocatore dormienti e l’esperimento opzionale di dispersione tiri sono rinvii o metodi non validati numericamente: non sono presentati come vecchie bocciature riprodotte.

## Confronto con i giudizi storici

Le metriche assolute dei vecchi report utilizzavano campioni, famiglie di eventi e protocolli diversi. I vecchi numeri sono riportati come contesto, senza sottrarli direttamente alla LL del nuovo campione.

| Ipotesi | Risultato documentato allora | Δ LL OOS nel nuovo retest | Riproduzione |
|---|---|---:|---|
| Recent Form decay 0.01/settimana | DC isolato: logLoss calibrata 0.60308 -> 0.60139 (-0.28%); ECE 0.0057 -> 0.0045. Non validata storicamente sopra ensemble. | -0.0071% | tested_exact |
| Recent Form decay 0.02/settimana | DC isolato LL -0.50%; pipeline ensemble calibrata LL 0.59924 -> 0.59912 (-0.02%), ECE 0.0019 -> 0.0037, paired p=0.65, n=5282 match. | +0.0005% | tested_exact |
| Recent Form decay 0.04/settimana | DC isolato: LL cal 0.60308 -> 0.60127 (-0.30%); ECE 0.0057 -> 0.0020. Non validata storicamente sopra ensemble. | -0.0065% | tested_exact |
| Recent Form decay 0.08/settimana | DC isolato: LL cal 0.60308 -> 0.60671 (+0.60%); ECE 0.0057 -> 0.0034; overfit storico. | -0.018% | tested_exact |
| Home advantage per-squadra: fit congiunto supportato | Quattro stagioni: LL cal ALL -0.04%, 1X2 -0.05%; paired t 1X2=-0.256, n=3282. Due stagioni ALL +0.12%, 1X2 p circa 0.60. | -0.010% | tested_exact |
| Controllo HA per-squadra: stessa scala globale applicata alla mappa | Nessun risultato storico: controllo metodologico introdotto nel retest. | -0.0017% | control |
| HA centrato: specificita per-squadra w=1, half-life 200 giorni | Quattro stagioni centered=1: LL ALL -0.14%, OU -0.10%, 1X2 -0.31%; t ALL=-1.20 (NS), t 1X2=-2.51. Due stagioni LL ALL -0.11%, t=-0.71. | +0.851% | tested_reconstructed |
| Dynamic xG globale: griglia 0.4/0.6/0.8/1, validazione temporale interna | LogLoss calibrata -0.07% rispetto al peso fisso 0.80; non rilevante. | +0.0013% | tested_reconstructed |
| B6 gialli media lega as-of | LL raw 0.51858 -> 0.52053 (+0.38%); cal 0.51563 -> 0.51585 (+0.04%); paired p=0.016 nella direzione peggiore, n=2181; raw peggiore 5/5 leghe. | -0.042% | tested_exact |
| B1 gialli casa/trasferta pesati | LL ALL 0.63823 -> 0.63983 (+0.25%); peggiora in 5/5 leghe, 6621 match as-of. | +0.537% | tested_exact |
| D2 correlazione gialli rho=0.12 | LL ALL -0.04% con rho=0.12; migliora Liga/Bundesliga, peggiora Serie A/Premier/Ligue 1. Correlazione empirica circa 0.18. | -0.011% | tested_exact |
| D5 raw SOT/raw shots | LL 0.67894 -> 0.68721 (+1.22%, peggioramento); Brier 0.24004 -> 0.24230; ECE 0.08470 -> 0.09113; n=6299 match. Segno -1.22% nel testo storico improprio. | +0.922% | tested_exact |
| D3 rossi media lega as-of | Nessuna LL storica riportata; effetto atteso <0.1 booking points. Proxy gialli*0.05: Premier +64%, Ligue 1 -24%, Liga -12%, Serie A +11%, Bundesliga +17%. | -0.201% | tested_exact |
| D1 both, vecchio fattore falli con propagazione coerente | Storico: stacking D1 + vecchia correzione peggiora; nessuna cifra pubblicata. | +1.483% | tested_reconstructed |
| D1 both, blocco legacy esatto solo gialli | Storico: both (D1 + vecchia yellowFoulsCorrFactor) peggiora; nessuna LL/ECE riportata. | +1.706% | tested_exact |
| D1 gialli indotti avversario, ricostruzione esplicita | LL ALL 0.63559, ECE 0.0204 contro D1 fouls_drawn adottato LL 0.63512, ECE 0.0166; baseline senza avversario LL 0.63823. | +1.579% | tested_reconstructed |
## Metodo, controlli e limiti

- Ensemble corrente Dixon–Coles + Poisson-xG, fit DC 280 iterazioni e passo 0,04; stessi input e seme bootstrap per ogni partita in tutte le varianti.
- Finestra di training nightly adattiva replicata sul conteggio di partite completate della lega: <8, 8–15, >15. Tra 16 e 19 il fit non raggiunge il minimo di 20 e conserva gli ultimi parametri validi, come il servizio.
- Refit storico almeno ogni settimana e a ogni transizione della finestra; cutoff al piu al kickoff, con soli risultati gia disponibili. La frequenza settimanale approssima la nightly, non riproduce ogni esecuzione giornaliera.
- Risultati assunti disponibili 120 minuti dopo il kickoff; gare simultanee, future o ancora entro le due ore non entrano nel fit, nelle statistiche o nella calibrazione OOS. Mancano timestamp storici di completamento/importazione.
- Medie e varianze squadra/arbitro ricostruite dal passato; EWMA e trasformazione della riga riusano il codice corrente. Storico contesto dal 2017, copertura di cinque stagioni; dati ancora anteriori non inclusi.
- Understat primario; football-data.co.uk integra solo valori mancanti e fornisce quote con provenienza separata. Un valore zero osservato non viene confuso con un dato mancante.
- Booking points osservati = gialli + 2 × rossi; il vecchio D1 legacy è misurato separatamente sui soli gialli.
- Nessuna ricostruzione arbitraria di assenze, lineup, tuning adattivo storico o prior di promozione: omissioni uguali per baseline e varianti.
- Dynamic xG globale sceglie .4/.6/.8/1 su una validazione annidata dei soli match passati; poi rifitta sul training disponibile. È una griglia ricostruita, non la vecchia griglia verificata.
- Controlli automatici verificano causalità temporale, invariabilità alla mutazione dei risultati target, parità con i servizi correnti, assenza di scritture DB/provider, semantica delle varianti, formule dei punteggi, pairing e ricampionamento. Una revisione indipendente ha verificato il protocollo prima del run.

## Provenienza e riproducibilità

Commit base: `bff46342`. Dataset SHA256: `409cc55f4ca9d219582e05bf716495afc78335d97d43d862b06e7fda7ab00076`. Tutte le varianti hanno 8908 record di previsione; le metriche includono solo le chiavi valide su entrambi i lati.

Sono pubblicati i risultati numerici completi: [riepilogo](paired-summary.csv), [per lega](paired-perLeague.csv), [per stagione](paired-perSeason.csv), [lega/stagione](paired-perLeagueSeason.csv), [tabella finale](final-table.json), [inventario delle ipotesi](inventory.json) e [verifica di completezza](verification.json). [metadata.json](metadata.json) conserva configurazioni, metodo statistico e hash SHA256 dei cinque output originali.

Il banco di prova offline, gli input storici e le previsioni grezze compresse sono conservati nell’archivio locale del retest, fuori dal repository. Questa cartella documenta l’esperimento; la CI applicativa non ricalcola il backtest. I CSV conservano i numeri non arrotondati.

## Decisione successiva al test

Il modello operativo resta invariato. Nessuna variante supera congiuntamente il criterio di significativita corretta e il miglioramento in almeno 4/5 leghe e 4/5 stagioni. D3 mostra un miglioramento medio significativo della log-loss sui booking points, ma solo in 3/5 leghe: non viene adottata globalmente. Anche gli altri piccoli guadagni non giustificano una modifica.

Documenti esaminati per le ipotesi e i vecchi risultati:

- [docs/FORMULARIO-sistema-scommesse.md](../../FORMULARIO-sistema-scommesse.md)
- [docs/performance/recent-form-half-life-2026-07.md](../recent-form-half-life-2026-07.md)
- [docs/performance/per-team-home-advantage-analysis-2026-07.md](../per-team-home-advantage-analysis-2026-07.md)
- [docs/FORMULARIO-scelte-scartate.md](../../FORMULARIO-scelte-scartate.md)
- [docs/performance/per-league-yellow-param-2026-07.md](../per-league-yellow-param-2026-07.md)
- [docs/performance/cards-opponent-bundle-b1-d1-d2-2026-07.md](../cards-opponent-bundle-b1-d1-d2-2026-07.md)
- [docs/performance/shots-ot-d5-reds-d3-2026-07.md](../shots-ot-d5-reds-d3-2026-07.md)
- [docs/performance/model-improvements-summary.md](../model-improvements-summary.md)
- [docs/performance/player-adjustment-strength-calibration-2026-07.md](../player-adjustment-strength-calibration-2026-07.md)
- [docs/performance/anytime-scorer-e5-2026-07.md](../anytime-scorer-e5-2026-07.md)
- [docs/performance/model-fixes-a2-b6-2026-07.md](../model-fixes-a2-b6-2026-07.md)
- [docs/performance/model-optimization-status-2026-07.md](../model-optimization-status-2026-07.md)