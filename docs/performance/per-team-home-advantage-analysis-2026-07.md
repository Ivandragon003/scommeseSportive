# Home advantage per-squadra (dinamico): analisi go/no-go — Luglio 2026

Data: 2026-07-14
Esito: **NO-GO** — la feature non migliora le prestazioni out-of-sample in modo statisticamente significativo. Nessuna modifica al codice di produzione. Documentato e non forzato, come da richiesta.

## Contesto: la feature esiste già (dormiente)

`DixonColesModel` implementa **già** un home advantage per-squadra, e nel modo statisticamente corretto:

- `fitModel(..., { enablePerTeamHomeAdvantage: true })` stima un `homeAdvantagePerTeam[team]` con **regolarizzazione L2 verso il parametro globale** (`regPt = 0.05·(HA_team − HA_global)`). Questo è **partial pooling / effetti casuali** (ridge = MAP con prior gaussiano): il globale resta come media di lega verso cui si fa shrinkage.
- `computeScoreMatrix` e `bootstrapLambdas` leggono già `homeAdvantagePerTeam` con fallback al globale.
- `fitDynamicTeamStrengths` ha già lo smoothing temporale dell'HA per-squadra.

Ciò che manca è **solo il wiring runtime**: `fitModelForCompetition` chiama `fitModel(matches, teams)` senza opzioni, quindi in produzione l'HA è globale. La domanda non è "come implementarlo" ma "conviene attivarlo?".

## Metodo

Walk-forward out-of-sample su 5 campionati (Serie A, Premier, La Liga, Bundesliga, Ligue 1), 2 stagioni, finestra espansiva, refit ogni 60 partite, stesso xG-blend (0.6). Unica variabile: `enablePerTeamHomeAdvantage` false vs true. Metriche su mercati sensibili all'HA (1X2, over/under, BTTS), raw e con calibrazione isotonica globale OOS. Test di significatività: paired t sulla log-loss 1X2 per-match.

## Risultato 1 — l'effetto per-squadra è REALE (non assorbito da attack/defence)

Dispersione degli HA per-squadra stimati (solo squadre con ≥8 gare casa): **std ≈ 0.088** in log-scala, con esempi plausibili e stabili:

| Squadra | HA (moltiplicatore λ casa) | vs media lega |
|---|---|---|
| Atlético Madrid | 0.480 (×1.62) | ×1.35 |
| Osasuna | 0.446 (×1.56) | ×1.35 |
| Brest | 0.381 (×1.46) | ×1.29 |
| … | | |
| Milan | 0.064 (×1.07) | ×1.15 |
| Bournemouth | 0.050 (×1.05) | ×1.21 |
| Hellas Verona | 0.037 (×1.04) | ×1.15 |

**Nota all'ipotesi iniziale**: attack/defence **non** assorbono l'HA per-squadra — l'effetto è identificabile separatamente (Atlético fortezza, Milan debole in casa, coerente con la conoscenza calcistica). Il problema non è la ridondanza col resto del modello.

## Risultato 2 — ma NON migliora le previsioni out-of-sample

Δ log-loss per-team vs globale (negativo = per-team meglio):

| Mercato | Δ logLoss raw | Δ logLoss calibrato | ECE |
|---|---|---|---|
| **1X2** | **−0.05%** | −0.12% | leggermente meglio |
| Over/Under | **+0.23%** | +0.23% | ~pari |
| BTTS | +0.05% | +0.11% | leggermente meglio |
| **Tutti** | **+0.12%** | +0.12% | ~pari |

- Il micro-guadagno sull'1X2 (−0.05%) è **compensato e superato** dal peggioramento su over/under (+0.23%): nel complesso il modello per-squadra è **leggermente peggiore**.

## Risultato 3 — il guadagno 1X2 NON è statisticamente significativo

Paired t-test sulla log-loss 1X2 per-match (n=2.004 partite):

- Δ log-loss medio (perTeam − base) = **−0.000296** (favorevole ma minuscolo)
- **t = −0.52** → |t| ≪ 1.96, **p ≈ 0.60**: indistinguibile da zero
- Il per-team batte il globale nel **51.7%** dei match — un coin-flip.

## Perché: rumore di stima > segnale

L'HA per-squadra è un segnale reale (std vero ~0.09) ma **piccolo**, e con ~19 gare casa/stagione l'**errore di stima del parametro è dello stesso ordine di grandezza del segnale**. Lo shrinkage L2 attenua il rumore ma, per farlo, comprime il parametro verso il globale — riportandolo di fatto vicino al modello base. Il risultato: sull'1X2 (dove l'HA conta di più) si pareggia; su over/under i 20+ parametri extra aggiungono varianza che degrada leggermente le previsioni. Classico caso in cui **la complessità aggiuntiva non è ripagata dai dati disponibili**.

## Decisione

**NO-GO.** L'HA globale resta lo standard di produzione. Nessuna modifica al codice, nessun nuovo parametro di config attivato: la feature resta disponibile nel modello (`enablePerTeamHomeAdvantage`) per riattivazione futura, ma **non va collegata al runtime** allo stato attuale dei dati.

### Quando rivalutare

La conclusione dipende dalla **quantità di dati per squadra**. Rivalutare se:
- si accumulano ≥4–5 stagioni per campionato (l'errore di stima per-squadra scende ~2×, il segnale potrebbe emergere);
- si passa a una parametrizzazione gerarchica esplicita con σ del prior **stimato dai dati** (empirical Bayes) invece del λ=0.05 fisso — ma solo se il punto precedente è soddisfatto, altrimenti si ricade nello stesso rumore.

Coerente con la preferenza esplicita: soluzione rigorosa e supportata dai dati > complessità non dimostrabilmente migliore.

---

# Aggiornamento — terza ipotesi: HA ibrido (globale + correzione graduale per squadra)

Data: 2026-07-14
Esito: **NO-GO sull'HA per-squadra**, ma l'esperimento ha rivelato un bias di livello di λ_home separato (finding collaterale).

## Ipotesi testata

`HA_eff(team) = HA_global + w · δ_team`, con il globale come prior e `δ_team` come deviazione. Ricerca del peso `w` dai dati (non euristica), sia **fisso** (grid 0→1) sia **adattivo al numero di partite** (empirical Bayes `w_team = n/(n+k)`).

Metodo statisticamente pulito: `δ_team` stimato in **forma chiusa** condizionando su attack/defence/HA del fit globale (profile-likelihood a 1 parametro, pesata nel tempo con half-life 200 giorni), così da valutare decine di `w` da un solo fit per fold. Walk-forward OOS, no xG al predict. Anti-overfitting sulla scelta di `w`: **validazione temporale** (scelta di `w` sulla prima metà cronologica, valutazione sulla seconda).

## Risultato apparente (prima della scomposizione)

La log-loss ALL scende monotòna: w=0 → 0.63427, w=1 → 0.62130 (**−2.05%**), validazione temporale **t=−4.31 (significativo)**. Sembrava un GO netto.

**Ma il guadagno è quasi tutto sui totali, non sull'1X2**: sull'1X2 il minimo è a w≈0.4–0.5 con solo −0.27% (t=−1.54, non significativo) e a w=1 *peggiora* (+0.17%). Un aggiustamento di *home advantage* che migliora l'over/under molto più dell'1X2 è la firma di una correzione di **livello di λ**, non di vantaggio casa.

## Test decisivo: livello vs specificità per-squadra

`δ_team` scomposto in **livello medio** (`gshift`, stesso shift a tutte le squadre) vs **specificità centrata** (`centered = δ_team − δ̄`):

| Schema | ALL logLoss Δ% | OU Δ% | 1X2 Δ% | Significatività ALL |
|---|---|---|---|---|
| w=1.00 (livello+specificità) | −2.05% | −3.16% | +0.17% | t=−6.29 |
| **gshift=1.00 (solo livello)** | **−2.02%** | −3.27% | +0.39% | — |
| **centered=1.00 (solo specificità)** | **−0.11%** | −0.04% | −0.28% | **t=−0.71 (NS)** |

- `δ̄` medio pesato = **+0.179** → il modello globale **sottostima λ_home di ~18%** (exp(0.179)≈1.20) sulle partite recenti.
- std(`δ_team`) = 0.128 → varianza reale tra squadre esiste, ma è **inferiore al livello medio**.
- **`gshift` replica il −2.02% su −2.05%.** La componente per-squadra pura (`centered`) vale −0.11% su ALL (**t=−0.71, non significativo**), −0.04% su over/under, −0.28% su 1X2 (t=−1.66, non significativo).

**Conclusione: il miglioramento non è home advantage per-squadra, è la correzione di un bias di livello di λ_home.** La feature richiesta (correzione specifica per squadra) non produce un guadagno statisticamente significativo neppure nella forma ibrida. NO-GO confermato per la terza volta, ora con la causa isolata.

## Finding collaterale (utile, ipotesi diversa)

Emerge un segnale reale e distinto: **il livello di λ_home è sottostimato di ~18% sulle partite recenti** rispetto alla media storica su cui è tarato il fit. Probabili cause: (a) il fit su pseudo-goal (0.6·goal+0.4·xG) con decay lungo è "indietro" rispetto al livello di goal casa recente; (b) reattività temporale insufficiente del livello.

**Verosimilmente questo bias è già in gran parte assorbito dalla calibrazione isotonica per-famiglia in produzione** (n.6): nel backtest di ablazione la calibrazione per-famiglia riduceva proprio la log-loss e l'ECE degli over/under — cioè correggeva bias di livello monotoni come questo. L'esperimento qui valuta probabilità **raw** (senza calibrazione), quindi sovrastima il guadagno "libero".

Raccomandazione: **non** implementare l'HA per-squadra. Se si vuole inseguire il bias di livello, farlo come ipotesi separata e validarla **dopo** la calibrazione runtime (per verificare che non sia già gestito), ad es. con un decay temporale più reattivo del livello goal o un termine di correzione globale — mai con 20+ parametri per-squadra che aggiungono varianza senza segnale.

## Riepilogo delle tre configurazioni richieste

1. **HA globale** (produzione): baseline robusta.
2. **HA per-squadra puro**: nessun guadagno significativo (1X2 t=−0.52); leggero peggioramento OU. NO-GO.
3. **HA ibrido (globale + w·δ_team)**: il guadagno apparente è bias di livello (gshift lo replica al 98%); la specificità per-squadra è non significativa (t=−0.71). NO-GO.

Nessuna modifica al codice di produzione. `enablePerTeamHomeAdvantage` resta disponibile ma non collegato.
