# Diagnosi ML e sviluppo controllato A/C — 27 ottobre 2026

**Esito: mantenere A come riferimento. Nessuna promozione C.** I risultati nuovi sono sviluppo cronologico, non un nuovo test indipendente.

Il report storico originale e i suoi artefatti non sono stati modificati. Le 745 partite finali già consultate sono escluse da ogni fit, selezione, calibrazione, permutazione e nuovo controllo sperimentale. Una verifica indipendente richiede partite future successive alla registrazione degli esperimenti.

## Dataset e verifica dello storico

L'esportazione contiene 8,834 incontri, 7,476 conclusi e 7,323 osservazioni ML ammissibili con 40 feature numeriche. Nessun duplicato di match, fixture o previsione è stato rilevato. Le 40 feature sono state ricalcolate indipendentemente da risultati/xG disponibili prima del target: nessuna discrepanza oltre 1e-8 o violazione temporale nel materiale esportato.

| Campionato | Osservazioni ammissibili |
|---|---:|
| Bundesliga | 1254 |
| La Liga | 1589 |
| Ligue 1 | 1340 |
| Premier League | 1570 |
| Serie A | 1570 |

| Stagione | Osservazioni ammissibili |
|---|---:|
| 2022/2023 | 1673 |
| 2023/2024 | 1752 |
| 2024/2025 | 1752 |
| 2025/2026 | 1752 |
| 2026/2027 | 394 |

I dati coprono agosto 2022–ottobre 2026; la stagione 2026/27 è parziale. xG/xGA sono presenti in tutte le 7.476 partite concluse esportate. Non ci sono feature numeriche mancanti o costanti. Le due coperture xG sono quasi costanti perché indicano soprattutto 14 casi casa e 21 trasferta senza storico: i valori sostitutivi sono prior espliciti, non statistiche osservate.

Nessuna correlazione a coppie raggiunge |r|≥0,98. Esistono comunque ridondanze esatte: `elo_difference = home_elo − away_elo` e la somma dei cinque indicatori di lega vale 1. Queste dipendenze non dimostrano da sole che una feature sia inutile per alberi. Nessuna squadra appare in due leghe nella stessa stagione; l'identità fisica dei club e gli alias richiedono evidenza ulteriore non contenuta nell'export numerico.

| Fold originale | Training | Selezione | Calibrazione | Test |
|---|---:|---:|---:|---:|
| 0 | 4075 | 688 | 387 | 739 |
| 1 | 4766 | 756 | 366 | 684 |
| 2 | 5527 | 706 | 335 | 745 |

Identità, separazione dei gruppi e purge temporale dei tre fold corrispondono ai record. I 2.168 match di test sono distinti; le metriche grezze sono state riprodotte entro 2,3e-16 e quelle aggregate dopo calibrazione entro 2,4e-15. Su questi dati le marginali 1X2 della matrice proxy A coincidono con A flat fino all'errore numerico: la proxy non spiega il piccolo guadagno osservato.

## Problemi effettivi e ipotesi

1. La vecchia calibrazione correggeva marginali separati senza ricostruire una distribuzione coerente; il benchmark normalizzava il vettore 1X2 prima dello scoring, mentre il Decision Engine poteva usare i valori non normalizzati. È un difetto matematico verificato, distinto dal guadagno ML.
2. Le stesse 387/366/335 partite producono rispettivamente 7.558/7.162/6.536 etichette A e 15.298/14.482/13.236 C perché C include anche i totali squadra. Questi non sono altrettanti match indipendenti. La famiglia 1X2 mescola anche doppia chance e DNB. Il nuovo controllo usa soltanto tre classi 1X2 normalizzate e poi riproietta la matrice.
3. Il vecchio trainer non permetteva peso ML zero. Inoltre tutti i fold selezionavano temperatura congiunta 0,8: parte del guadagno poteva venire dalla trasformazione di A. Questo è verificato con un controllo privo di ML, non assunto.
4. L'ECE grezza originaria media tutte le classi; l'ECE finale usa confidenza della classe principale. Sono definizioni differenti, ora riportate entrambe per ogni nuovo esperimento. Non si attribuisce un cambiamento fra queste due misure alla calibrazione.
5. La calibrazione dispone di poche centinaia di partite per finestra. È plausibile che una curva non parametrica vari fra periodi, ma non è dimostrata come unica causa dell'ECE finale peggiore. L'implementazione corrente usa bucket e shrinkage: non è identica alla regressione isotonica standard.

La documentazione ufficiale [scikit-learn](https://scikit-learn.org/stable/modules/calibration.html) descrive il rischio di overfitting isotonico con campioni piccoli e la necessità di calibrazione separata. La rilevanza nel caso FootPredictor va comunque misurata, non dedotta dalla sola regola generale.

## Protocollo dei nuovi esperimenti

Sviluppo ammesso: 6.578 righe prima del cutoff protetto. Tre fold con training crescente, selezione, calibrazione e controlli disgiunti generano **2261 confronti appaiati di sviluppo**, distribuiti su 49 settimane. I periodi erano già osservabili: i loro intervalli non autorizzano una promozione. Tutti i nuovi esperimenti escludono le 745 partite finali.

| Fold sviluppo | Training | Selezione | Calibrazione | Controllo sviluppo |
|---|---:|---:|---:|---:|
| 0 | 3215 | 684 | 414 | 739 |
| 1 | 4011 | 628 | 413 | 806 |
| 2 | 4742 | 682 | 426 | 716 |

Sono eseguiti 144 confronti C: ablazioni, tre integrazioni, quattro protocolli di calibrazione e una ricerca limitata. CatBoost 1.2.8 usa seed fisso e due thread. Il peso include zero; peso e temperatura sono scelti sulla selezione. PAV e temperatura di calibrazione usano la finestra successiva separata. SHAP/permutation per scegliere feature usano soltanto la selezione, non le etichette dei controlli.

Configurazione base: 120 alberi, profondità 5, learning rate 0,05, L2=3. Le sole alternative sono 60/profondità3/L2=10 e 180/profondità4/learning rate0,03/L2=10, ultimi 730 giorni di label e pesi con emivita 365 giorni. Il limite di 730 giorni riguarda le label di training: non modifica le medie storiche già codificate nelle feature congelate. Non è una prova sull'intera profondità della pipeline statistica A.

## Tre configurazioni e controllo senza ML

- Correzione intensità: regressori Poisson sui gol, con log-intensità A come baseline; ricostruzione congiunta coerente.
- Correzione probabilità: multiclass sui risultati, con log-probabilità A come baseline; riponderazione delle tre regioni del punteggio.
- Ensemble: regressori Poisson interni e combinazione con la matrice A. Non esiste un modello B operativo.

| Configurazione, senza calibrazione aggiuntiva | Log loss | Brier | ECE principale |
|---|---:|---:|---:|
| A identità | 0.984369 | 0.585145 | 0.031645 |
| Solo temperatura A, nessun ML | 0.980031 | 0.582837 | 0.023954 |
| C — Correzione intensità | 0.977820 | 0.581488 | 0.012430 |
| C — Correzione probabilità | 0.981431 | 0.583761 | 0.019129 |
| C — Ensemble statistico/ML | 0.980152 | 0.582615 | 0.010218 |

Il controllo solo-temperatura migliora A senza aggiungere alcuna feature ML. Quindi il guadagno C rispetto ad A grezzo non può essere attribuito interamente a CatBoost. La correzione delle intensità è la variante più regolare nei tre controlli di sviluppo; la correzione probabilistica sceglie anche peso zero in un fold e mostra maggior variabilità.

### Adattamento nell'ultimo fold di sviluppo

La tabella usa 1X2 prima della calibrazione successiva. Le metriche di training sono in-sample e non sono prove di generalizzazione.

| Configurazione | Log loss training | Log loss selezione | Log loss calibrazione | Log loss controllo |
|---|---:|---:|---:|---:|
| Correzione intensità | 0.962954 | 0.961793 | 0.983505 | 0.984013 |
| Correzione probabilità | 0.942036 | 0.963289 | 0.986368 | 0.986698 |
| Ensemble statistico/ML | 0.963828 | 0.962239 | 0.982675 | 0.982685 |

La correzione probabilistica ottiene un training migliore ma un divario successivo più ampio. È compatibile con maggiore adattamento al training e/o cambiamenti del periodo; non isola una causa unica. Il JSON conserva anche le loss native Poisson e MultiClass per ogni iterazione: questi obiettivi diversi non vanno confrontati numericamente fra loro.

## Ablazioni a parità di integrazione e calibrazione

La tabella usa la correzione intensità con isotonica 1X2 coerente. Le impostazioni vengono riottimizzate soltanto nella selezione di ogni fold; i risultati sono diagnostici.

| Feature | Numero ultimo fold | Log loss C | Brier C | ECE C |
|---|---:|---:|---:|---:|
| Base | 19 | 0.980215 | 0.582854 | 0.034501 |
| Base + xG/xGA | 25 | 0.980333 | 0.583202 | 0.020898 |
| Base + forma recente | 23 | 0.980405 | 0.583109 | 0.015050 |
| Base + Elo | 22 | 0.980006 | 0.582842 | 0.016384 |
| Base + casa/trasferta | 23 | 0.980000 | 0.583080 | 0.018802 |
| Completa | 40 | 0.978755 | 0.582026 | 0.008628 |
| Feature con intervallo permutation favorevole ripetuto | 10 | 0.978515 | 0.581907 | 0.018957 |

Una versione preliminare della riduzione sceglieva una maschera globale dalle tre finestre di selezione e la riapplicava anche ai controlli precedenti. Questo era un lookahead nello sviluppo, pur senza usare le 745 partite protette: quei risultati sono stati invalidati e sostituiti. Ora ogni fold determina la propria maschera soltanto dalle finestre di selezione correnti o precedenti. Intensità A e indicatori di lega restano; una feature aggiuntiva richiede un intervallo permutation settimanale favorevole in almeno min(2, finestre già disponibili). È un criterio di sviluppo, non una selezione causale o già validata in futuro.

Numero di feature nel controllo ridotto per fold: 0: 13, 1: 7, 2: 10.
Feature conservate nell'ultimo fold del controllo ridotto: `home_elo`, `home_xg_against`, `home_shots_against`, `lambda_home_A`, `lambda_away_A`, `league_0`, `league_1`, `league_2`, `league_3`, `league_4`.

## Importanza e sensibilità

| Feature | PredictionValuesChange medio nei tre fold |
|---|---:|
| `lambda_away_A` | 5.508 |
| `lambda_home_A` | 5.063 |
| `away_goals_for` | 4.474 |
| `home_shots_against` | 4.097 |
| `away_sample` | 4.073 |
| `home_xg_for` | 3.685 |
| `home_rest_days` | 3.505 |
| `elo_difference` | 3.457 |
| `home_elo` | 3.290 |
| `away_recent_goal_diff` | 3.235 |

Le intensità A compaiono fra i segnali più usati: C riutilizza una sintesi statistica già forte. xG, forma, Elo e venue mostrano utilità variabile; la sola frequenza di importanza non dimostra informazione aggiuntiva stabile. I dettagli delle permutazioni per feature/gruppo, degli intervalli e di SHAP sono nel JSON. Le feature di copertura xG quasi costanti non dimostrano un miglioramento nel campione osservato, ma restano indicatori utili per i prior/cold start.

[CatBoost](https://catboost.ai/docs/en/concepts/fstr) definisce PredictionValuesChange come variazione delle previsioni associata alla feature. La [documentazione SHAP di CatBoost](https://catboost.ai/docs/en/concepts/python-reference_catboostclassifier_get_feature_importance) descrive contributi ai valori del modello: né l'una né l'altra misura prova causalità. Le permutazioni mantengono il campionato, ma possono rompere correlazioni fra feature; gli intervalli restano esplorativi dopo più confronti.

### Stabilità fra stagioni nella selezione

Per lo stesso modello dell'ultimo fold, SHAP è misurato su al massimo 100 osservazioni di selezione per stagione. Il confronto non usa etichette dei controlli o del test finale. Le permutazioni per stagione mantengono il campionato.

| Stagione | Modello interno | N SHAP | Tre contributi assoluti maggiori |
|---|---|---:|---|
| 2024/2025 | home | 100 | `away_sample`, `away_goals_for`, `home_sample` |
| 2024/2025 | away | 100 | `home_sample`, `lambda_away_A`, `home_shots_against` |
| 2025/2026 | home | 100 | `away_sample`, `away_goals_for`, `home_sample` |
| 2025/2026 | away | 100 | `lambda_away_A`, `home_sample`, `home_shots_against` |

Nella selezione 2024/25 la permutazione xG ed Elo può peggiorare la log loss, mentre nella porzione 2025/26 gli intervalli includono zero; forma recente e venue non mostrano utilità uniforme. Campioni, avversari e distribuzioni cambiano: non è una prova di relazione causale né di inutilità permanente. Le corrispondenti stime e numerosità sono conservate nel JSON.

## Calibrazione e beneficio incrementale

Gli intervalli bootstrap settimanali al 95% sono nominali per il singolo
confronto. Non sono corretti per le 144 configurazioni né per la selezione
effettuata su questo insieme di sviluppo; non controllano l'errore complessivo
dei confronti multipli. Un intervallo favorevole scelto dopo aver visto i
risultati resta esplorativo e non autorizza una promozione. Per una conclusione
promozionale servono regole fissate prima e un nuovo campione futuro indipendente.

| Protocollo, C intensità completo | Log loss A | Log loss C | Brier A | Brier C | ECE A | ECE C |
|---|---:|---:|---:|---:|---:|---:|
| Nessuna calibrazione aggiuntiva | 0.984369 | 0.977820 | 0.585145 | 0.581488 | 0.031645 | 0.012430 |
| Isotonica famiglia legacy + normalizzazione | 0.982786 | 0.977799 | 0.584067 | 0.581443 | 0.015957 | 0.015083 |
| Isotonica 1X2 coerente | 0.982241 | 0.978755 | 0.583828 | 0.582026 | 0.020579 | 0.008628 |
| Temperatura congiunta coerente | 0.980031 | 0.977619 | 0.582837 | 0.581348 | 0.023954 | 0.012285 |

Rispetto ad A che riceve anch'esso la temperatura selezionata, l'intervallo settimanale 95% della differenza C−A è [-0.004894865905088414, 0.00021344893659353667] per log loss e [-0.0030768414058330185, 0.00010039462683757901] per Brier. Entrambi comprendono zero: il beneficio informativo ML oltre il controllo di calibrazione non è robustamente separato su questo sviluppo.

La calibrazione coerente 1X2 migliora l'ECE di C su questi controlli, ma non migliora uniformemente log loss e Brier rispetto alla curva famiglia legacy. Questo dimostra un trade-off nel campione, non la soluzione definitiva dell'ECE finale originale. Il test finale originale non è stato riutilizzato per decidere il calibratore.

## Campionati, stagioni e mercati

Riferimento diagnostico: C correzione intensità, feature complete, isotonica 1X2 coerente.

| Campionato | N | Log loss A | Log loss C | Brier A | Brier C |
|---|---:|---:|---:|---:|---:|
| Bundesliga | 407 | 0.997533 | 0.992416 | 0.591823 | 0.589469 |
| La Liga | 484 | 0.962459 | 0.956196 | 0.569104 | 0.565505 |
| Ligue 1 | 398 | 0.974985 | 0.976989 | 0.579576 | 0.580424 |
| Premier League | 486 | 1.001586 | 0.998180 | 0.598588 | 0.597281 |
| Serie A | 486 | 0.975732 | 0.971804 | 0.580520 | 0.578304 |

| Stagione di sviluppo | N | Log loss A | Log loss C | Brier A | Brier C |
|---|---:|---:|---:|---:|---:|
| 2024/2025 | 860 | 0.977822 | 0.974907 | 0.581401 | 0.579334 |
| 2025/2026 | 1401 | 0.984953 | 0.981118 | 0.585318 | 0.583679 |

| Mercato | N valutabile | Log loss A | Log loss C | Brier A | Brier C |
|---|---:|---:|---:|---:|---:|
| `double_chance_1x` | 2261 | 0.563526 | 0.560043 | 0.190601 | 0.189287 |
| `dnb_home` | 1704 | 0.571502 | 0.566485 | 0.194369 | 0.192496 |
| `totals_over_2.5` | 2261 | 0.684233 | 0.681570 | 0.245691 | 0.244347 |
| `team_home_over_1.5` | 2261 | 0.639836 | 0.640275 | 0.224532 | 0.224508 |
| `btts` | 2261 | 0.692894 | 0.694009 | 0.249725 | 0.250295 |
| `european_handicap_home_-1` | 2261 | 0.897325 | 0.894415 | 0.525532 | 0.524422 |
| `asian_handicap_home_0.25` | 2261 | 0.575278 | 0.571201 | 0.195898 | 0.194312 |

Le metriche 1X2 ed handicap europeo sono multiclass; doppia chance, totali e BTTS sono binarie. DNB esclude i rimborsi; gli handicap asiatici usano probabilità condizionali e pesi di stake effettivo per mezzi esiti. Non si confrontano direttamente valori di metriche con target diversi. Nessuna di queste misure attiva il mercato o dimostra un ROI.

## Ottimizzazioni controllate

| Configurazione intensità, isotonica 1X2 | Alberi/profondità | Log loss C | Brier C |
|---|---:|---:|---:|
| Gruppi con utilità selection ripetuta | 120/5 | 0.979072 | 0.582174 |
| Gruppi con utilità selection ripetuta | 60/3 | 0.979096 | 0.582314 |
| Gruppi con utilità selection ripetuta | 180/4 | 0.978906 | 0.582255 |
| Training label: ultimi 730 giorni | 120/5 | 0.979376 | 0.582281 |
| Pesi training: emivita 365 giorni | 120/5 | 0.977472 | 0.581329 |

Il miglior valore medio fra molte configurazioni non costituisce una prova indipendente. La maggiore regolarizzazione, il limite di storia e i pesi temporali non autorizzano un cambio operativo. Non sono aggiunte reti neurali, feature categoriche incompatibili con l'inferenza numerica o nuovi provider.

## Riproducibilità, uso e limiti

```powershell
cd backend
npm run build
python -m unittest discover -s ml/tests -v
python ml/diagnose.py --dataset artifacts/research/dataset.json --matches artifacts/research/matches.json --original artifacts/research/run-20261027/report.json --output artifacts/research/diagnostics-20261027 --folds 3 --iterations 120
python ml/diagnostics/fit_stability.py --diagnostics artifacts/research/diagnostics-20261027/diagnostics.json --dataset artifacts/research/dataset.json --original artifacts/research/run-20261027/report.json --output artifacts/research/diagnostics-20261027/fit-stability.json
python ml/diagnostics/summarize.py --input artifacts/research/diagnostics-20261027/diagnostics.json --output-json ../docs/performance/ml-diagnosis-2026-10-27.json --output-md ../docs/performance/ml-diagnosis-2026-10-27.md
```

Gli artefatti nuovi contengono maschere di feature, anche diverse per fold, e sono `diagnosticOnly=true`, `runtimeCompatible=false`. La loro registrazione è separata dai modelli operativi; non devono essere scelti automaticamente come latest C senza un adattatore di inferenza e una validazione nuova. I report conservano hash dei dati, del runner, dei modelli e della lista finale protetta. Il test Python `test_later_selection_cannot_choose_an_earlier_reduced_mask` modifica prove future e verifica che le maschere precedenti rimangano identiche.

Rimangono limiti: disponibilità storica ricostruita a kickoff+2h, possibili revisioni retroattive delle fonti, statistica di calibrazione con poche partite, più esperimenti sullo sviluppo e nessun nuovo periodo indipendente. Il confronto economico e le prove prospettiche richiedono quote reali ammissibili e sono separati da questo report.

**Decisione: A resta il riferimento; C intensità merita una verifica prospettica controllata, ma nessuna configurazione viene promossa.** La correzione della coerenza probabilistica è necessaria a prescindere dalla superiorità del ML.

[Riepilogo JSON](ml-diagnosis-2026-10-27.json) · [Benchmark storico originale immutato](research-ac-2026-10-27.md)
