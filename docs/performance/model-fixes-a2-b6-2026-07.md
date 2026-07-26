# Fix di modello e wiring — batch A2/A3/A4/A7 + A6/B4 + B6 — Luglio 2026

Data: 2026-07-26

Serie di correzioni emerse da un audit del motore (squadra + giocatore). Tutti
gli interventi sono stati validati (build + suite test) e, dove applicabile, con
misura selection-independent o verifica sostitutiva. I falli restano un mercato
non attivabile (nessuna quota provider); il valore si concentra su goal-derivati,
tiri, cartellini e player props.

## A2 — Corner: termine difensivo usa i corner CONCESSI · commit `004d65a6`

Il modello corner passava i corner *fatti* dall'altra squadra negli slot
"against" di `computeCornersDistribution`: nel mix `0.6·for + 0.4·against` i due
contributi 0.4 si annullavano e `muTotal` collassava sulla somma delle medie,
azzerando ogni effetto avversario.

- **Fix:** aggregati i corner concessi venue-aware (con decay, additivi in
  `team_stats_json.computed.home/away`, nessuna nuova colonna), esposti da
  `PredictionContextBuilder` e usati negli slot difensivi in `DixonColesModel`.
- **Verifica:** Δ `muTotal` tra avversario debole/forte da **0.000 → 1.600**
  (Over 9.5: 0.58 vs 0.42).
- **Nota:** mercato ancora `DISABLED` (nessuna quota corner) → il fix non
  raggiunge l'utente; backtest corner non possibile (engine non aggrega i corner).
  Varianza corner ancora hardcoded (B2, non incluso).

## A3 + A4 — Share tiri giocatore · commit `58e1c516`

- **A4:** `shot_share_of_team` usava come denominatore i tiri squadra su TUTTE le
  partite del periodo, col numeratore sulle sole gare giocate → share depressa
  per chi salta gare. Ora denominatore = tiri squadra nelle **sole gare giocate**
  (fallback a lunghezza shotmap se colonna NULL). Rimossa la mappa morta
  `teamShotsTotals`. Verifica: share **×3.8** per chi ha giocato 10 di 38 gare.
- **A3:** `computePlayerShotsPredictions` normalizzava le share su TUTTA la rosa
  (~25, `isStarter` non popolato): lo shrinkage verso il prior di ruolo gonfiava
  la quota dei panchinari e la normalizzazione a somma 1 sottraeva tiri ai
  titolari. Ora normalizza sugli **11 di movimento più coinvolti al tiro** (XI
  probabile). Verifica: bomber da **1.15 → 2.75** tiri attesi, share XI = 1.000.
- **Scope aperto:** pesatura per minuti attesi / formazioni ufficiali (E2/E4,
  dati non cablati). Player props non backtestabili (engine non valuta i player).

## A7 — Handicap europeo a linea intera (3 vie) · commit `cc3d5ad4`

La probabilità `away-L` era posta a `1 - hw`; sulle linee INTERE il complemento
includeva il push (away vince di esattamente L, stake reso) come vittoria,
sovrastimando `away-1`/`away-2`.

- **Fix:** `aw` calcolata con la sua disuguaglianza stretta `a - h - L > 0`,
  simmetrica a home → push escluso da entrambi i lati; combacia col settlement
  del backtest. Linee `.5`: nessun cambiamento (aw ≡ 1-hw).
- **Verifica (logLoss vs settlement backtest, griglia λ):** away-1 massa push
  media 0.183, **logLoss −18.9%**; away-2 massa 0.093, **−19.1%**.

## A6 + B4 — Cartellini totali su booking points · commit `5b1bd881`

Le quote `alternate_totals_cards` (the-odds-api: "Total Cards / Bookings") erano
confrontate con la probabilità **solo-gialli** e il backtest regolava
`cards_total` sui **soli gialli realizzati** → bias sistematico verso l'Under sul
mercato non-goal più giocato.

- **Analisi dato (verificata sul DB, 4 stagioni):** i cartellini sono 100%
  `source=understat`; i totali coincidono al 100% con le somme dei roster.
  Understat NON registra mai una doppia ammonizione come 2 gialli + 1 rosso: la
  codifica di ogni espulsione è `0 gialli + 1 rosso`. Non esiste alcun campo
  card-type/dismissal nello schema → rosso diretto e doppia ammonizione sono
  **indistinguibili**.
- **Conseguenza:** la formula `bookingPoints = gialli + 2·rossi` è **già
  corretta** per questo dataset (regola bookmaker: giallo=1, rosso diretto=2,
  doppia ammonizione=2, giallo+rosso diretto=3) e NON va cambiata in "solo rossi
  diretti" (sottoconterebbe le doppie ammonizioni). Vedi helper `bookingPoints`.
- **Fix reale:** helper condiviso `bookingPoints`; card points esposti in
  `flatProbabilities` (`cardsTotalOver/Under`, B4); parser `cards/bookings` →
  dominio `cards_total` (era `yellow`); alias `cards_over/under` → `cards_total_*`;
  pairing `cardsTotal` nel value engine; settlement backtest `cards_total` su
  `gialli + 2·rossi`; 6 test di regressione (i 4 casi + edge).
- **Impatto backtest (7076 partite reali):** base settlement **4.013 → 4.399
  punti (+9.6%)**; Over 4.5 **38.0% → 43.9%**; **4.2–6.3%** degli esiti cambiano
  sulle linee comuni. Effetto sul 16.7% di partite con ≥1 rosso.

## B6 — Baseline gialli per-lega nel modello cartellino GIOCATORE · commit `bdaa48b9`

Il modello giocatore usava `leagueAvgTeamYellows=1.9` / `leagueAvgRefereeYellow=3.8`
hardcoded. `supp.leagueAvgYellow` non è mai popolato nella pipeline (default 3.8).

- **Dato reale (DB, 4 stagioni):** gialli/match per lega — La Liga 4.58, Serie A
  4.01, Bundesliga 3.90, Premier 3.89, Ligue 1 3.61. Copertura arbitro: 100% solo
  Premier, ~1-2% altrove.
- **Fix:** tabella empirica per-lega + resolver in `predictionConfig`, usata SOLO
  dal modello giocatore. Modello squadra invariato (il parametro per-lega lì è
  documentato NO-GO).
- **Effetto (arbitro assente):** La Liga difensore E[gialli] 0.397 → 0.377
  (−5.2%); Ligue 1 0.373 → 0.378 (+1.4%). Non backtestabile (player props fuori
  dal backtest).

## Stato test
Suite backend: 229/229 pass (da 223, +6 booking points). Build `tsc` pulito.

## Prossimo (in valutazione)
Bundle **B1+B3+D1+D2** sul modello falli/cartellini (split casa/trasferta,
`fouls_drawn` come termine avversario falli, termine avversario cartellini,
correlazione casa/ospite gialli). Valore concentrato sui cartellini (ora
backtestabili correttamente via A6). Confronto empirico opzione "cartellini
indotti" vs proxy `fouls_drawn` — vedi report dedicato.
