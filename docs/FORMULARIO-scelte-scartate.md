# Scelte scartate e perché — documento compagno del formulario

Ultimo aggiornamento: 2026-07-17
Compagno di [`FORMULARIO-sistema-scommesse.md`](FORMULARIO-sistema-scommesse.md). Elenca **tutto ciò che è stato valutato e NON implementato**, con la ragione. Serve a non riprendere idee già testate né a dimenticare perché sono state scartate. I numeri vengono dai backtest walk-forward OOS in [`docs/performance/`](performance/).

Metodo comune: misurazione sull'**intera pipeline di produzione** (fit → ensemble → calibrazione per-famiglia → market blending → value bet), con test di significatività appaiato per partita dove sensato.

---

## A. Feature valutate e bocciate (NO-GO)

| Intervento | Metrica principale | Significatività | Perché scartata | Report |
|---|---|---|---|---|
| **Dynamic xG Blend** — auto-peso globale per-fold | logLoss cal −0.07% vs peso fisso | non rilevante | Non batte un peso fisso a 0.80; complessità inutile | `feature-ablation-2026-07.md` |
| **Dynamic xG Blend** — peso xG per-squadra | logLoss cal −0.01/−0.02% | rumore | Il peso statico 0.80 è già near-ottimale. Chiuso in 2 formulazioni | `recent-form-half-life-2026-07.md` |
| **Shot Quality Adjustment** | −0.24% da solo, +solo −0.05% sopra l'ensemble | — | Ridondante con l'ensemble; in combo peggiora la calibrazione | `ensemble-poisson-xg-2026-07.md` |
| **Recent Form (half-life ottimizzata)** | −0.50% sul DC isolato → −0.02% con ensemble | **p=0.65** | Ensemble e recency correggono lo stesso difetto; non additive | `recent-form-half-life-2026-07.md` |
| **Calibrazione per tipo di squadra (forti/deboli)** | logLoss cal −0.02/−0.03% | **p=0.35–0.48** | Stratificare frammenta i campioni; ECE peggiora. Calibrazione già saturata dall'ensemble | `player-adjustment-strength-calibration-2026-07.md` |
| **Player Adjustment (assenze) — algoritmo attuale** | logLoss cal +0.01% (peggio) | **p=0.90** | Il DC cattura già le assenze via risultati recenti | `player-adjustment-strength-calibration-2026-07.md` |
| **Player Adjustment (assenze) — avanzato (att/dif + ruoli)** | logLoss cal −0.02% | **p=0.57** | Segnale reale (54% match con ≥1 assente) ma non migliora le predizioni | `player-adjustment-strength-calibration-2026-07.md` |
| **Parametro per-lega `leagueAvgYellow`** (3.8 → media reale) | logLoss raw +0.38% (peggio) | **p=0.016 direzione opposta** | Nell'attuale modello/pipeline il 3.8 globale produce risultati migliori sui gialli (causa non dimostrata) | `per-league-yellow-param-2026-07.md` |
| **Vantaggio casa per-squadra** | nessun guadagno OOS | — | Il bias è di livello totale, non casa-specifico → risolto da `levelCorrection` | `per-team-home-advantage-analysis-2026-07.md` |

## B. Interventi bloccati per dati insufficienti

| Intervento | Motivo | Sblocco |
|---|---|---|
| **Corner concessi** (modello dedicato vs proxy) | Corner reali nell'1–2% dei match: impossibile tarare/validare | nuova fonte dati (SofaScore/FBref) |
| **Parametri per-lega falli e corner** | Falli/corner all'1–2%: nessun dato per stimare i default | nuova fonte dati |
| **Refactor effetto arbitro** (triplo conteggio) | Arbitro nell'1–2%: il codice quasi mai si attiva → refactor senza impatto né validabile | nuova fonte dati |

Dettaglio copertura in §13 del formulario e nella memoria di progetto (`data-coverage-gaps`).

## C. Parti volutamente semplificate nel modello (design, non bug)

Ereditate dalla v4.1 e ancora valide:

- **Underdispersion completa (COM-Poisson / Generalized Poisson):** non implementata; il codice usa un fallback Poisson shrinkato robusto con warning tecnico.
- **`covarianceMonteCarlo` (combo):** non esegue simulazione random a runtime; usa una varianza proxy deterministica da matrice di correlazione, per mantenere test/backtest riproducibili. Fallback a `sqrtLegs` se mancano correlazioni.
- **`hessianApproximation` (bootstrap):** modalità accettata come approssimazione/fallback deterministico; non esiste una Hessiana analitica completa.

## D. Codice presente ma non collegato al runtime (candidati a rimozione o wiring)

- **`ShotsModel.ts` (pipeline player v4: ZIP/ZINB, gerarchico team→player, distribuzione minuti, SOT separato):** non collegato. Il runtime usa `SpecializedModels.computePlayerShotsPredictions` (Dirichlet aggregato). Servirebbe una tabella `player_match_stats` (oggi il DB ha solo aggregati). Wiring possibile ma non prioritario.
- **`optimizeTemporalWeights()` (DixonColesModel):** nessun caller. Dato che la Recent Form è NO-GO, è un candidato alla rimozione.
- **`learnContextWeights()` (PredictionContextBuilder):** apprende e restituisce pesi ma non sovrascrive i pesi operativi; nessun caller nel runtime.

## E. Conclusioni operative

1. **I mercati goal sono saturi** dopo l'ensemble (ECE calibrata 0.0019). Cinque feature consecutive sui goal sono NO-GO con la stessa diagnosi: non resta miscalibrazione da correggere. **Non riproporre feature sui goal senza un'ipotesi sostanzialmente nuova.**
2. **Il bug cartellini era l'unico problema reale** tra i miglioramenti al modello esistente: corretto e validato.
3. **Regole metodologiche apprese** (da applicare a ogni valutazione futura):
   - misurare sempre sulla **pipeline completa** con lo stack già attivo, mai sul modello isolato (Recent Form sembrava −0.50% da sola, era −0.02% nella pipeline);
   - separare il **fatto misurato** dall'**ipotesi sulla causa**: non presentare la seconda come conclusione senza una prova dedicata;
   - non implementare un parametro "teoricamente più corretto" se il backtest completo dice il contrario.
4. **Unico margine reale rimasto:** mercato **marcatore anytime** — nuova funzionalità (dati pronti: 2.934 giocatori con xG), non un miglioramento del modello esistente. Da valutare separatamente.

Per la tabella sintetica di tutti gli interventi (implementati + scartati) vedere [`performance/model-improvements-summary.md`](performance/model-improvements-summary.md).
