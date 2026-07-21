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

## B. Interventi ex-bloccati per dati — ora SBLOCCATI (football-data.co.uk, 2026-07)

L'integrazione di **football-data.co.uk** ha portato falli/corner/tiri/cartellini a ~100% (§13 formulario). I seguenti interventi non sono più bloccati e sono ora **testabili**:

| Intervento | Stato | Note |
|---|---|---|
| **Modello falli / corner** | ✅ dati disponibili, da validare full-pipeline | Backtest preliminare (dati reali): livello ottimo (bias falli +0.8%, corner −0.1%); dispersione grezza da tarare/calibrare. Non ancora attivati nel filtro value |
| **Parametri per-lega falli e corner** | testabile | ora c'è il dato per stimare i default per-lega |
| **Refactor effetto arbitro** | parziale | arbitro coperto solo per la Premier (~22%); fuori Premier resta neutro |

Ancora scoperti: **possesso** (~1%, nessuna fonte HTTP stabile) e **arbitro fuori Premier**.

Dettaglio copertura in §13 del formulario e nella memoria di progetto (`data-coverage-gaps`).

### B-bis. Mercati CORNER e FALLI — copertura quote insufficiente (2026-07-18)

**Il blocco non è nel modello né nel codice: sono le quote.** Verifica empirica su **4.472 `odds_snapshots` reali** di produzione.

> **Criterio corretto.** Una prima analisi aveva usato la copertura *Eurobet* come criterio: **sbagliato**. La copertura Eurobet dei mercati stat è ~0,27% *identica* per tiri e gialli, che però sono mercati **attivi e realmente giocati**. Il criterio operativo valido è la presenza di **prezzi bookmaker reali** (`source=odds_api`), perché è da lì che arrivano di fatto le quote dei mercati stat serviti.

| Mercato | snapshot con quote | di cui da bookmaker reale (`odds_api`) | bet realmente giocate |
|---|---|---|---|
| tiri *(attivo)* | 153 | **123** | 2 (shotsOT) |
| gialli *(attivo)* | 148 | **118** | **18** |
| corner | 68 | **37** | 0 (disabilitato) |
| **falli** | 30 | **0** | 0 (disabilitato) |

- **Falli — il caso peggiore:** zero snapshot con prezzi bookmaker reali. Dei 30, ben 22 sono `the_odds_api_plus_model_completion`, cioè quote **completate dal modello stesso**: usarle per calcolare value sarebbe **circolare**. Copertura reale ≈ 0.
- **Corner:** 37 snapshot con prezzi reali su tutto lo storico (~0,8%, circa **un terzo** dei mercati attivi). Non zero, ma volume praticamente irrilevante: anche sbloccando tutto si otterrebbero pochissime giocate.
- Il provider non richiede mai questi mercati: `markets_requested_json` è sempre `["h2h","totals","spreads"]`.
- Nota di conformità: le 18 bet gialli servite sono prezzate con `source=odds_api` e `eurobet_odds_json` **senza** gialli. I mercati stat, di fatto, **non passano da Eurobet** — da chiarire rispetto alla regola Eurobet-only di `AGENTS.md`.

**Catena di dipendenze corner/falli** (da riprendere solo se cambia la fonte quote): [1] quote bookmaker reali per il mercato *(esterna, BLOCCANTE: corner ~0,8%, falli ~0%)* → [2] provider richiede market corner/falli → [3] non svuotare `probs.corners.overUnder` (`PredictionService` ~1544) → [4] `dropUnavailableUnderstatMarkets` (~975) → [5] `DISABLED_CATEGORIES` (`ValueBettingEngine` ~627) → [6] soglia EV corner 0.120 → ~0.05 → [7] backtest di mercato positivo (AGENTS.md) → [8] calibrazione cold-start → [9] termine difensivo (B2).

> ⚠️ Attenzione: il flag di config `understatOnlyMarkets.cornersEnabled` **non è letto da nessuna parte** — è un interruttore morto. I blocchi reali sono hardcoded nei punti [3][4][5].

**B2 — termine difensivo corner: SCARTATO (bloccato su dipendenza esterna).**
Fatto dimostrato: il termine difensivo 0.4 di `computeCornersDistribution` è **inerte** — `muHome` dipende solo dai corner della squadra di casa, perché il campo "concessi" è alimentato con i corner *battuti* dall'avversario. Sostituendolo con i corner **concessi reali** (as-of, pipeline I1, metrica selection-independent) il modello migliora: logLoss 5/5 leghe (Serie A 0.558→0.526, Premier 0.594→0.558, La Liga 0.551→0.532, Bundesliga 0.592→0.558, Ligue 1 0.582→0.549), Brier 5/5, sign test p≈0.031; ECE già basso (~0.02–0.03) e misto.
**Scartato comunque**: miglioramento reale ma **senza percorso di impatto in produzione** (nessuna quota corner), e richiederebbe di propagare un nuovo campo "corner concessi" in `recomputeTeamAverages` + `buildTeamStats` + `buildAsOfSupp`. Da riprendere solo insieme all'intero pacchetto corner, se le quote diventeranno disponibili.

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
   - non implementare un parametro "teoricamente più corretto" se il backtest completo dice il contrario;
   - **usare metriche selection-independent** per confrontare varianti di modello: il `logLoss`/`Brier` del backtest è calcolato solo sulle **bet selezionate**, e config diverse selezionano bet diverse → il confronto è confuso. Va misurato su *tutte* le predizioni (tutte le linee, tutti i match). Il caso `SHOT_GOAL_RATIO` lo mostra: sulla metrica confusa il valore migliore sembrava *peggiorare*, su quella corretta migliora in 5/5 leghe;
   - **verificare la disponibilità delle quote PRIMA di lavorare su un mercato**: corner e falli hanno modello sano e dati statistici al 100%, ma quote bookmaker reali ~0,8% e ~0% → lavoro inutilizzabile. La copertura quote è una precondizione, non un dettaglio finale;
   - **misurare la copertura sulla colonna giusta**: la prima analisi corner usò la copertura *Eurobet*, che è ~0,27% anche per i mercati **attivi** (tiri, gialli) → criterio non discriminante. Conta la presenza di **prezzi bookmaker reali** (`source=odds_api`), ed escludere le quote `*_plus_model_completion` (generate dal modello: usarle per il value è circolare).
4. **Unico margine reale rimasto:** mercato **marcatore anytime** — nuova funzionalità (dati pronti: 2.934 giocatori con xG), non un miglioramento del modello esistente. Da valutare separatamente.

Per la tabella sintetica di tutti gli interventi (implementati + scartati) vedere [`performance/model-improvements-summary.md`](performance/model-improvements-summary.md).
