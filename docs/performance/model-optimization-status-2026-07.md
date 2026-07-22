# Stato dell'ottimizzazione del modello — conclusione — Luglio 2026

Data: 2026-07-18

## Domanda

Esistono ancora interventi sul **modello attuale** con **elevata probabilita** di migliorare **significativamente** il sistema?

## Risposta: NO. Capitolo "ottimizzazione del modello" considerato concluso.

Non esiste alcun intervento sul modello esistente con elevata probabilita di miglioramento significativo. Motivazione per blocco di mercato, con l'evidenza gia raccolta.

### Mercati goal (il nucleo, i piu scommessi) — SATURI

ECE calibrata **0.0019** dopo l'ensemble DC + Poisson-xG. **Cinque+ feature consecutive NO-GO** con la stessa diagnosi (l'ensemble corregge gia il difetto che ognuna cercava di correggere):

- Dynamic xG Blend (globale e per-squadra) — p non rilevante
- Shot Quality Adjustment — ridondante con l'ensemble
- Recent Form (half-life ottimizzata) — −0.02% con **p=0.65**
- Calibrazione per tipo di squadra — p=0.35-0.48
- Player Adjustment assenze (2 formulazioni) — p=0.57 e p=0.90
- Parametro per-lega `leagueAvgYellow` — peggiora, p=0.016 direzione opposta
- Vantaggio casa per-squadra — nessun guadagno OOS

Non resta miscalibrazione da correggere. **Non riproporre feature sui goal senza un'ipotesi sostanzialmente nuova.**

### Mercati non-goal effettivamente serviti — solo GIALLI e TIRI

Su 91 bet reali giocate in produzione: 18 gialli, 2 tiri-in-porta, 3 player props, il resto goal. Corner e falli: **0** (disabilitati / senza quote).

- **Gialli:** bug di competitivita gia corretto e validato (era l'unico difetto reale). Parametro per-lega NO-GO. Mercato sottile (18 bet). Margine residuo basso.
- **Tiri:** ratio corretto oggi (`SHOT_GOAL_RATIO` 9.0, 5/5 leghe). **Residuo misurato:** ECE grezzo 0.06-0.12 anche dopo la correzione. E l'**unico candidato modellistico ancora non testato con margine misurabile** (taratura dispersione `r`, ratio per-lega, o un rating tiri strutturale stile Poisson-xG).
  - **Ma la probabilita di impatto e MEDIA, non alta.** La lezione ricorrente del progetto: i miglioramenti sulla probabilita grezza vengono spesso assorbiti dalla calibrazione per-famiglia e dal market blending della pipeline (e' successo con Recent Form: −0.50% isolato → −0.02% completo). Va misurato con la metrica selection-independent gia usata per il ratio; se il guadagno grezzo non sopravvive alla pipeline completa, e NO-GO.

### Mercati non serviti — bloccati a monte, non dal modello

- **Corner:** modello sano; bloccato dalle quote (chiave provider corretta oggi, popolazione da verificare a stagione iniziata). Il fix del termine difensivo (B2) e pronto ma ha senso solo se arrivano quote.
- **Falli:** modello sano; **nessuna fonte quote** (the-odds-api non li espone, nessun provider gratuito). Chiuso.
- **Possesso:** nessuna fonte HTTP gratuita; il modello falli usa un possesso inferito dai lambda.

## Un unico esperimento modellistico opzionale ancora aperto

**Calibrazione/dispersione del mercato tiri.** Unico con margine misurato (ECE 0.06-0.12) su un mercato realmente servito. Confidenza **media**. Se lo si prova: metrica selection-independent, pipeline completa, GO solo se il guadagno sopravvive a calibrazione + blending su >=4/5 leghe. Non e "alta probabilita", quindi non contraddice la conclusione: e l'ultima cosa da spuntare prima di chiudere del tutto.

## Da qui in poi: solo nuove funzionalita e infrastruttura

In ordine di valore atteso:

1. **Ingest quote storiche di chiusura** (infra, ALTA). Oggi il 96% delle quote nel backtest e sintetico → ROI, CLV e Sharpe **non validabili**. Senza questo non si puo misurare se il sistema *guadagna*, solo se e *ben calibrato*. E il singolo sblocco piu importante rimasto. Le quote di chiusura sono gia nei CSV football-data che scarichiamo.
2. **`player_match_stats`** (infra + feature, MEDIA-ALTA). Tabella per-match dai `raw_json.rosters` (gia coperti al 100%). Sblocca: **marcatore anytime** (indicato come unico margine reale sui giocatori, 2.934 giocatori con xG pronti), `ShotsModel` v4 (ZIP, oggi scollegato), modello minuti attesi, split casa/trasferta per giocatore.
3. **Collegamenti di dati gia calcolati ma inutilizzati** (infra, MEDIA — con cautela). Il DB calcola `recent.last5/last10`, forma, giorni di riposo derivabili, ecc., ma non arrivano al motore (`homeFormIndex` resta neutro 0.5). ATTENZIONE: la Recent Form e gia NO-GO nella pipeline completa → collegare le finestre recenti va **ritestato**, non dato per acquisito. Riposo/congestione calendario sono invece **non ancora testati**.
4. **Igiene dati:** rinominare/correggere `xgot` (oggi e "xG dei tiri nello specchio", non vero post-shot xG → nome fuorviante); rimuovere o collegare le metriche giocatore archiviate ma mai lette (`goal_conversion`, `shots_per90`, `cards_per90`, `total_goals`, `shot_on_target_pct`).
5. **Mercati 1o/2o tempo** (feature) — `HTHG`/`HTAG` gia nei CSV, non ingeriti.
6. **Riattivazione corner** (feature) — gated sulla popolazione quote a stagione iniziata; include sblocco `DISABLED_CATEGORIES`, soglia EV, backtest di mercato, B2.

## Verifica di connessione dati (2026-07, controllata sul codice)

Riepilogo di cosa entra davvero nel motore vs cosa e solo salvato:

- **Usati:** goal, xG per-partita, tiri, tiri-in-porta, cartellini, medie/varianze/sample squadra, arbitro (ma ~100% solo Premier, ~0% altrove → di fatto inerte fuori Premier), dati giocatore per tiri (`avg_shots_per_game`, `avg_shots_on_target_per_game`, `games_played`, `shot_share_of_team`, `position_code`, minuti), `avg_xg_per_game`/`xg_per90`/`avg_minutes` (aggiustamento assenze), `yellow_cards_total`/`minutes_total` (cartellino giocatore).
- **Salvati ma NON usati dal motore:** finestre `recent.last5/last10`, statistiche stagionali (`cleanSheetsTotal`, `goalDiff`, `xgForPerMatch`), totali/rate squadra (`foulsDrawnPerMatch`, xG/xGA totali, `shotOnTargetPct`, totali storici corner/cartellini), metriche giocatore (`goal_conversion`, `shots_per90`, `shots_on_target_per90`, `cards_per90`, `total_goals`, `shot_on_target_pct`, `avg_xgot_per_game`, `red_cards_total`).
- **Accettati dal modello ma mai valorizzati dal chiamante:** `playerFoulsCommittedPer90`, tutto il contesto pre-partita (forma, riposo, motivazione, squalifiche, assenze) che deve arrivare nella request e non ha un importer.
- **Mai importati:** possesso reale, formazioni previste/ufficiali, infortuni/squalifiche live, vero xGOT post-shot, dati disciplinari individuali, e feature avanzate (passaggi, PPDA, calci piazzati, meteo, ecc.).
- **Nota su `corners`/`fouls`:** il dato statistico entra nei modelli, ma i mercati vengono svuotati (`PredictionService` ~1543-1545) e disabilitati (`ValueBettingEngine` DISABLED_CATEGORIES) → non raggiungono l'utente.
