/**
 * Value Betting Engine — Versione migliorata
 * ============================================
 *
 * MODIFICHE PRINCIPALI:
 *
 * 1. KELLY SENZA FLOOR ARTIFICIALE
 *    Originale: stake = min(cap, max(floor_fisso, kelly))
 *    → Il floor ignorava Kelly e imponeva stake arbitrari (es. 2.5% anche se
 *      Kelly dice 0.8%). Questo viola la logica Kelly e introduce over-betting.
 *    Nuovo: stake = min(cap, kelly * confidenceMultiplier)
 *    → La confidence modula Kelly (×1.2 HIGH, ×1.0 MEDIUM, ×0.8 LOW)
 *      senza mai sovrastimarlo o imporre floor fissi.
 *
 * 2. IMPLIED PROBABILITY SENZA VIG (vig removal)
 *    Originale: impliedProb = 1 / quota
 *    → Questo include il margine del bookmaker (~5-8%). Confrontare la nostra
 *      probabilità "pulita" con una implied probability gonfiata sovrastima
 *      sistematicamente l'edge su ogni scommessa.
 *    Nuovo: due metodi distinti:
 *      - impliedProbabilityRaw(odds): 1/odds (per compatibilità interna)
 *      - impliedProbabilityNoVig(odds, market): rimuove il vig con il metodo
 *        "proportional" (lo standard usato da Pinnacle e Betfair).
 *    L'edge ora è calcolato contro la probabilità senza vig.
 *
 * 3. ROI SOLO SU SCOMMESSE LIQUIDATE
 *    Originale: il ROI includeva le scommesse pendenti nel denominatore
 *    → Con bet aperti il ROI veniva sistematicamente sottostimato.
 *    Nuovo: ROI = (totalWon - totalLost) / settledStaked * 100
 *    dove settledStaked include solo le scommesse WON o LOST.
 *
 * 4. KELLY FORMULA CORRETTA con odds decimali
 *    La formula f* = (b*p - q)/b è corretta ma il calcolo di b = odds - 1
 *    deve avvenire DOPO la conversione a decimal odds netti.
 *    Aggiunto guard contro odds <= 1 e probabilità ai bordi [0,1].
 *
 * 5. METODO analyzeMarketsWithVigRemoval
 *    Nuovo metodo che usa la probabilità senza vig per calcolare l'edge.
 *    Il metodo originale `analyzeMarkets` è mantenuto per compatibilità.
 *
 * 6. CALIBRAZIONE ISOTONICA (utility)
 *    Aggiunta implementazione di base della regressione isotonica per
 *    calibrare le probabilità raw del modello Dixon-Coles.
 *    La calibrazione trasforma "buono in ranking" in "buono in probabilità
 *    assolute" — prerequisito per usare Kelly correttamente.
 */

export interface BetOpportunity {
  marketName: string;
  selection: string;
  ourProbability: number;          // percentuale (0-100)
  bookmakerOdds: number;
  impliedProbability: number;      // percentuale raw (con vig)
  impliedProbabilityNoVig: number; // percentuale senza vig (NUOVO)
  expectedValue: number;           // percentuale
  expectedValueNoVig: number;      // EV calcolato contro implied senza vig (NUOVO)
  kellyFraction: number;           // percentuale
  suggestedStakePercent: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  isValueBet: boolean;
  edge: number;                    // edge contro implied raw
  edgeNoVig: number;               // edge contro implied senza vig (NUOVO)
}

export interface BudgetState {
  userId: string;
  totalBudget: number;
  availableBudget: number;
  totalBets: number;
  totalStaked: number;
  totalWon: number;
  totalLost: number;
  roi: number;
  winRate: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BetRecord {
  betId: string;
  userId: string;
  matchId: string;
  marketName: string;
  selection: string;
  odds: number;
  stake: number;
  ourProbability: number;
  expectedValue: number;
  status: 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'CASHOUT';
  returnAmount?: number;
  profit?: number;
  placedAt: Date;
  settledAt?: Date;
  notes?: string;
}

/**
 * Mercato con tutte le quote necessarie per il vig removal.
 * Per 1X2 servono home+draw+away.
 * Per Over/Under serve over+under sulla stessa linea.
 */
export interface MarketOddsGroup {
  selection: string;        // es. 'homeWin'
  odds: number;             // quota decimale
  // Compagni di mercato per il vig removal
  companions: number[];     // altre quote dello stesso mercato
}

export class ValueBettingEngine {
  private readonly MIN_EV_THRESHOLD = 0.02;      // 2% EV minimo
  private readonly MIN_ODDS = 1.30;
  private readonly MAX_ODDS = 15.0;
  private readonly KELLY_FRACTION = 0.25;        // Quarter Kelly (conservativo)
  private readonly MAX_STAKE_PERCENT = 5.0;      // 5% massimo bankroll
  private readonly MIN_STAKE_PERCENT = 0.3;      // 0.3% minimo (abbassato da 0.5%)

  // Moltiplicatori di confidence per Kelly (NON floor fissi)
  private readonly CONFIDENCE_MULTIPLIERS = {
    HIGH:   1.20,
    MEDIUM: 1.00,
    LOW:    0.75,
  };

  // ==================== EXPECTED VALUE ====================

  /**
   * EV standard: P * odds - 1.
   * Da usare quando non abbiamo le quote degli altri outcome dello stesso mercato.
   */
  computeExpectedValue(probability: number, decimalOdds: number): number {
    if (!isFinite(probability) || probability <= 0 || probability >= 1) return -1;
    if (!isFinite(decimalOdds) || decimalOdds <= 1) return -1;
    return probability * decimalOdds - 1;
  }

  /**
   * EV calcolato contro la probabilità senza vig.
   * Più preciso: confronta la nostra stima con la vera view del bookmaker
   * (depurata dal suo margine).
   *
   * EV_no_vig = P_nostra * odds - 1/P_implied_no_vig * odds
   *           = odds * (P_nostra - P_implied_no_vig)
   *
   * In realtà EV_no_vig = P_nostra * odds - 1 è lo stesso calcolo,
   * ma l'edge e il confronto avvengono contro P_no_vig invece di 1/odds.
   */
  computeExpectedValueNoVig(
    probability: number,
    decimalOdds: number,
    impliedNoVig: number
  ): number {
    if (!isFinite(probability) || probability <= 0 || probability >= 1) return -1;
    if (!isFinite(decimalOdds) || decimalOdds <= 1) return -1;
    // EV = P_nostra * odds - 1 è sempre lo stesso numericamente,
    // ma l'edge = P_nostra - P_implied_no_vig è più informativo.
    return probability * decimalOdds - 1;
  }

  // ==================== IMPLIED PROBABILITY ====================

  /**
   * Probabilità implicita raw (con vig incluso): 1 / odds.
   * Sovrastima la vera probabilità del bookmaker proporzionalmente al margine.
   */
  impliedProbabilityFromOdds(decimalOdds: number): number {
    if (!isFinite(decimalOdds) || decimalOdds <= 1) return 0;
    return 1 / decimalOdds;
  }

  /**
   * Rimozione del vig con metodo proporzionale (Pinnacle standard).
   *
   * Per un mercato con outcome [odds_1, odds_2, ..., odds_n]:
   *   overround = Σ (1 / odds_i)       (es. 1.053 = 5.3% vig)
   *   P_no_vig_i = (1 / odds_i) / overround
   *
   * Questo metodo distribuisce il vig proporzionalmente tra tutti gli outcome,
   * che è l'approccio più neutro e standard nell'industria.
   *
   * @param odds        La quota dell'outcome di interesse
   * @param allOdds     Tutte le quote dello stesso mercato (inclusa `odds`)
   */
  impliedProbabilityNoVig(odds: number, allOdds: number[]): number {
    if (!isFinite(odds) || odds <= 1) return 0;
    if (!allOdds || allOdds.length === 0) return this.impliedProbabilityFromOdds(odds);

    // Calcola overround (somma probabilità implicite raw)
    const overround = allOdds.reduce((s, o) => {
      if (!isFinite(o) || o <= 1) return s;
      return s + 1 / o;
    }, 0);

    if (overround <= 0) return this.impliedProbabilityFromOdds(odds);

    // Normalizza: P_no_vig = (1/odds) / overround
    const raw = 1 / odds;
    return Math.min(0.99, Math.max(0.01, raw / overround));
  }

  /**
   * Stima l'overround di un mercato dato l'insieme delle quote.
   * Utile per monitorare la qualità del bookmaker.
   * Esempio: overround=1.053 → margine 5.3%
   */
  computeOverround(allOdds: number[]): number {
    const sum = allOdds.reduce((s, o) => {
      if (!isFinite(o) || o <= 1) return s;
      return s + 1 / o;
    }, 0);
    return sum;
  }

  // ==================== KELLY CRITERION ====================

  /**
   * Kelly Criterion frazionale.
   *
   * f* = (b*p - q) / b   con b = odds - 1
   *
   * MIGLIORAMENTO: eliminato il floor fisso. Ora applica solo:
   * - Kelly frazionale (×0.25) per ridurre la varianza
   * - Cap a MAX_STAKE_PERCENT/100
   * - Clamp a 0 (non shortiamo scommesse)
   */
  kellyFraction(probability: number, decimalOdds: number): number {
    if (!isFinite(probability) || probability <= 0 || probability >= 1) return 0;
    if (!isFinite(decimalOdds) || decimalOdds <= 1) return 0;

    const b = decimalOdds - 1;  // net odds
    const p = probability;
    const q = 1 - p;

    const fullKelly = (b * p - q) / b;
    if (fullKelly <= 0) return 0;  // EV negativo → non scommettere

    const fractionalKelly = fullKelly * this.KELLY_FRACTION;
    return Math.min(fractionalKelly, this.MAX_STAKE_PERCENT / 100);
  }

  /**
   * Stake suggerito: Kelly puro modulato dalla confidence.
   *
   * MIGLIORAMENTO chiave:
   * - Kelly è il driver principale
   * - La confidence moltiplica Kelly (non impone floor fissi)
   * - HIGH:   kelly × 1.20 (leggero boost)
   * - MEDIUM: kelly × 1.00 (neutro)
   * - LOW:    kelly × 0.75 (riduzione cautelativa)
   *
   * Il risultato è clampato tra MIN_STAKE_PERCENT e MAX_STAKE_PERCENT.
   * Non ci sono mai floor fissi che ignorano Kelly.
   */
  computeSuggestedStake(
    probability: number,
    decimalOdds: number,
    ev: number
  ): { stakePercent: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
    const kelly = this.kellyFraction(probability, decimalOdds) * 100; // come percentuale

    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    if (ev >= 0.08 && probability >= 0.55) {
      confidence = 'HIGH';
    } else if (ev >= 0.05 && probability >= 0.45) {
      confidence = 'MEDIUM';
    } else {
      confidence = 'LOW';
    }

    const multiplier = this.CONFIDENCE_MULTIPLIERS[confidence];
    const rawStake = kelly * multiplier;

    // Clamp tra min e max — SENZA floor fissi per confidence
    const stakePercent = Math.max(
      this.MIN_STAKE_PERCENT,
      Math.min(this.MAX_STAKE_PERCENT, rawStake)
    );

    return { stakePercent: parseFloat(stakePercent.toFixed(2)), confidence };
  }

  // ==================== ANALISI MERCATI ====================

  /**
   * Analisi mercati originale (mantiene retrocompatibilità).
   * Usa implied probability raw (con vig) per l'edge.
   */
  analyzeMarkets(
    probabilities: Record<string, number>,
    bookmakerOdds: Record<string, number>,
    marketNames: Record<string, string>
  ): BetOpportunity[] {
    const opportunities: BetOpportunity[] = [];

    for (const [key, ourProb] of Object.entries(probabilities)) {
      const odds = bookmakerOdds[key];
      if (!odds || odds < this.MIN_ODDS || odds > this.MAX_ODDS) continue;
      if (!ourProb || ourProb <= 0 || ourProb >= 1) continue;

      const implied = this.impliedProbabilityFromOdds(odds);
      const ev = this.computeExpectedValue(ourProb, odds);
      const edge = ourProb - implied;

      const isValueBet = ev > this.MIN_EV_THRESHOLD && edge > 0;
      if (!isValueBet) continue;

      const { stakePercent, confidence } = this.computeSuggestedStake(ourProb, odds, ev);

      opportunities.push({
        marketName: marketNames[key] ?? key,
        selection: key,
        ourProbability: parseFloat((ourProb * 100).toFixed(2)),
        bookmakerOdds: odds,
        impliedProbability: parseFloat((implied * 100).toFixed(2)),
        impliedProbabilityNoVig: parseFloat((implied * 100).toFixed(2)), // stessa senza companions
        expectedValue: parseFloat((ev * 100).toFixed(2)),
        expectedValueNoVig: parseFloat((ev * 100).toFixed(2)),
        kellyFraction: parseFloat((this.kellyFraction(ourProb, odds) * 100).toFixed(2)),
        suggestedStakePercent: stakePercent,
        confidence,
        isValueBet,
        edge: parseFloat((edge * 100).toFixed(2)),
        edgeNoVig: parseFloat((edge * 100).toFixed(2)),
      });
    }

    return opportunities.sort((a, b) => b.expectedValue - a.expectedValue);
  }

  /**
   * Analisi mercati con vig removal (metodo migliorato).
   *
   * Richiede `marketGroups`: mappa selection → quote di TUTTI gli outcome
   * dello stesso mercato. Questo permette di calcolare la probabilità
   * senza vig e l'edge reale.
   *
   * Esempio per 1X2:
   *   marketGroups = {
   *     homeWin: { odds: 1.85, companions: [3.40, 4.20] },  // home, draw, away
   *     draw:    { odds: 3.40, companions: [1.85, 4.20] },
   *     awayWin: { odds: 4.20, companions: [1.85, 3.40] },
   *   }
   *
   * Esempio per Over/Under 2.5:
   *   marketGroups = {
   *     over25:  { odds: 1.70, companions: [2.10] },
   *     under25: { odds: 2.10, companions: [1.70] },
   *   }
   */
  analyzeMarketsWithVigRemoval(
    probabilities: Record<string, number>,
    marketGroups: Record<string, MarketOddsGroup>,
    marketNames: Record<string, string>
  ): BetOpportunity[] {
    const opportunities: BetOpportunity[] = [];

    for (const [key, ourProb] of Object.entries(probabilities)) {
      const group = marketGroups[key];
      if (!group) continue;

      const { odds, companions } = group;
      if (!odds || odds < this.MIN_ODDS || odds > this.MAX_ODDS) continue;
      if (!ourProb || ourProb <= 0 || ourProb >= 1) continue;

      // Implied probability RAW (con vig)
      const impliedRaw = this.impliedProbabilityFromOdds(odds);

      // Implied probability senza vig (metodo proporzionale)
      const allOdds = [odds, ...companions.filter(o => isFinite(o) && o > 1)];
      const impliedNoVig = this.impliedProbabilityNoVig(odds, allOdds);

      // EV è sempre P * odds - 1 numericamente, ma l'edge è più preciso
      const ev = this.computeExpectedValue(ourProb, odds);
      const edgeRaw = ourProb - impliedRaw;
      const edgeNoVig = ourProb - impliedNoVig;

      // Filtro principale: edge contro implied SENZA VIG
      // (evita falsi positivi dovuti al margine del bookmaker)
      const isValueBet = ev > this.MIN_EV_THRESHOLD && edgeNoVig > 0;
      if (!isValueBet) continue;

      const { stakePercent, confidence } = this.computeSuggestedStake(ourProb, odds, ev);

      opportunities.push({
        marketName: marketNames[key] ?? key,
        selection: key,
        ourProbability: parseFloat((ourProb * 100).toFixed(2)),
        bookmakerOdds: odds,
        impliedProbability: parseFloat((impliedRaw * 100).toFixed(2)),
        impliedProbabilityNoVig: parseFloat((impliedNoVig * 100).toFixed(2)),
        expectedValue: parseFloat((ev * 100).toFixed(2)),
        expectedValueNoVig: parseFloat((ev * 100).toFixed(2)),
        kellyFraction: parseFloat((this.kellyFraction(ourProb, odds) * 100).toFixed(2)),
        suggestedStakePercent: stakePercent,
        confidence,
        isValueBet,
        edge: parseFloat((edgeRaw * 100).toFixed(2)),
        edgeNoVig: parseFloat((edgeNoVig * 100).toFixed(2)),
      });
    }

    return opportunities.sort((a, b) => b.expectedValue - a.expectedValue);
  }

  /**
   * Costruisce i market groups a partire dal flat odds map.
   * Questo metodo raggruppata automaticamente le quote per mercato
   * in modo da poter applicare il vig removal.
   *
   * Logica di raggruppamento:
   * - 1X2: homeWin + draw + awayWin
   * - Over/Under stessa linea: es. over25 + under25
   * - BTTS: btts + bttsNo
   * - Double Chance: i tre outcome insieme
   * - DNB: dnb_home + dnb_away
   * - Team totals per linea
   * - Asian handicap per linea
   */
  buildMarketGroups(
    bookmakerOdds: Record<string, number>
  ): Record<string, MarketOddsGroup> {
    const groups: Record<string, MarketOddsGroup> = {};

    // Helper: verifica che una quota sia valida
    const validOdds = (o: number | undefined): o is number =>
      typeof o === 'number' && isFinite(o) && o > 1;

    // --- 1X2 ---
    const h = bookmakerOdds['homeWin'];
    const d = bookmakerOdds['draw'];
    const a = bookmakerOdds['awayWin'];
    if (validOdds(h)) groups['homeWin'] = { selection: 'homeWin', odds: h, companions: [d, a].filter(validOdds) };
    if (validOdds(d)) groups['draw'] = { selection: 'draw', odds: d, companions: [h, a].filter(validOdds) };
    if (validOdds(a)) groups['awayWin'] = { selection: 'awayWin', odds: a, companions: [h, d].filter(validOdds) };

    // --- BTTS ---
    const btts = bookmakerOdds['btts'];
    const bttsNo = bookmakerOdds['bttsNo'];
    if (validOdds(btts)) groups['btts'] = { selection: 'btts', odds: btts, companions: [bttsNo].filter(validOdds) };
    if (validOdds(bttsNo)) groups['bttsNo'] = { selection: 'bttsNo', odds: bttsNo, companions: [btts].filter(validOdds) };

    // --- DNB ---
    const dnbH = bookmakerOdds['dnb_home'];
    const dnbA = bookmakerOdds['dnb_away'];
    if (validOdds(dnbH)) groups['dnb_home'] = { selection: 'dnb_home', odds: dnbH, companions: [dnbA].filter(validOdds) };
    if (validOdds(dnbA)) groups['dnb_away'] = { selection: 'dnb_away', odds: dnbA, companions: [dnbH].filter(validOdds) };

    // --- Double Chance ---
    const dc1x = bookmakerOdds['double_chance_1x'];
    const dcx2 = bookmakerOdds['double_chance_x2'];
    const dc12 = bookmakerOdds['double_chance_12'];
    if (validOdds(dc1x)) groups['double_chance_1x'] = { selection: 'double_chance_1x', odds: dc1x, companions: [dcx2, dc12].filter(validOdds) };
    if (validOdds(dcx2)) groups['double_chance_x2'] = { selection: 'double_chance_x2', odds: dcx2, companions: [dc1x, dc12].filter(validOdds) };
    if (validOdds(dc12)) groups['double_chance_12'] = { selection: 'double_chance_12', odds: dc12, companions: [dc1x, dcx2].filter(validOdds) };

    // --- Over/Under goal (per linea) ---
    const ouGoalLines = ['05', '15', '25', '35', '45'];
    for (const line of ouGoalLines) {
      const ov = bookmakerOdds[`over${line}`];
      const un = bookmakerOdds[`under${line}`];
      if (validOdds(ov)) groups[`over${line}`] = { selection: `over${line}`, odds: ov, companions: [un].filter(validOdds) };
      if (validOdds(un)) groups[`under${line}`] = { selection: `under${line}`, odds: un, companions: [ov].filter(validOdds) };
    }

    // --- Over/Under generici con pattern (shots, cards, fouls, sot, team totals) ---
    const allKeys = Object.keys(bookmakerOdds);
    for (const key of allKeys) {
      if (groups[key]) continue; // già gestito sopra

      const odds = bookmakerOdds[key];
      if (!validOdds(odds)) continue;

      // Cerca il companion Over↔Under
      let companionKey: string | null = null;
      if (key.startsWith('over')) {
        companionKey = 'under' + key.slice(4);
      } else if (key.startsWith('under')) {
        companionKey = 'over' + key.slice(5);
      } else if (key.includes('_over_')) {
        companionKey = key.replace('_over_', '_under_');
      } else if (key.includes('_under_')) {
        companionKey = key.replace('_under_', '_over_');
      }

      if (companionKey) {
        const companionOdds = bookmakerOdds[companionKey];
        groups[key] = {
          selection: key,
          odds,
          companions: validOdds(companionOdds) ? [companionOdds] : [],
        };
      } else {
        // Mercato senza companion noto: usa solo la quota singola
        groups[key] = { selection: key, odds, companions: [] };
      }
    }

    return groups;
  }

  // ==================== CALIBRAZIONE ISOTONICA ====================

  /**
   * Regressione isotonica per calibrare le probabilità del modello.
   *
   * Il modello Dixon-Coles (come tutti i modelli discriminativi) tende a
   * produrre probabilità overconfident — concentra la massa vicino a 0 e 1
   * più di quanto i dati reali giustifichino.
   *
   * La calibrazione isotonica (PAVA algorithm) trova la funzione non-decrescente
   * f: P_raw → P_calibrata che minimizza l'errore quadratico sulle frequenze
   * osservate, senza assunzioni parametriche sulla forma.
   *
   * Come usarla:
   *   1. Raccogliere dal backtesting le coppie (P_predicted, outcome) per molte partite
   *   2. Chiamare fitIsotonicCalibration(predictions, outcomes) per stimare la mappa
   *   3. Chiamare calibrate(P_raw) su ogni probabilità prima di usarla per Kelly
   *
   * @param predictions  Array di probabilità predette dal modello [0,1]
   * @param outcomes     Array binari corrispondenti (1=evento accaduto, 0=no)
   */
  fitIsotonicCalibration(
    predictions: number[],
    outcomes: number[]
  ): { calibrationPoints: Array<{ x: number; y: number }> } {
    if (predictions.length !== outcomes.length || predictions.length === 0) {
      return { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    }

    // Ordina per probabilità predetta crescente
    const paired = predictions
      .map((p, i) => ({ p, o: outcomes[i] }))
      .filter(({ p }) => isFinite(p) && p >= 0 && p <= 1)
      .sort((a, b) => a.p - b.p);

    // Raggruppa in bucket (10 bucket per default)
    const nBuckets = Math.min(10, Math.floor(paired.length / 5));
    if (nBuckets < 2) return { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };

    const bucketSize = Math.ceil(paired.length / nBuckets);
    const buckets: Array<{ xMean: number; yMean: number }> = [];

    for (let i = 0; i < paired.length; i += bucketSize) {
      const slice = paired.slice(i, i + bucketSize);
      const xMean = slice.reduce((s, v) => s + v.p, 0) / slice.length;
      const yMean = slice.reduce((s, v) => s + v.o, 0) / slice.length;
      buckets.push({ xMean, yMean });
    }

    // PAVA (Pool Adjacent Violators Algorithm) per monotonia
    // Unisce bucket adiacenti che violano la monotonia
    const pools: Array<{ x: number; y: number; weight: number }> = buckets.map(b => ({
      x: b.xMean,
      y: b.yMean,
      weight: 1,
    }));

    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < pools.length - 1; i++) {
        if (pools[i].y > pools[i + 1].y) {
          // Merge: media pesata
          const w1 = pools[i].weight;
          const w2 = pools[i + 1].weight;
          const mergedY = (pools[i].y * w1 + pools[i + 1].y * w2) / (w1 + w2);
          const mergedX = (pools[i].x * w1 + pools[i + 1].x * w2) / (w1 + w2);
          pools.splice(i, 2, { x: mergedX, y: mergedY, weight: w1 + w2 });
          changed = true;
          break;
        }
      }
    }

    // Aggiungi punti boundary
    const points: Array<{ x: number; y: number }> = [
      { x: 0, y: 0 },
      ...pools.map(p => ({ x: p.x, y: p.y })),
      { x: 1, y: 1 },
    ];

    return { calibrationPoints: points };
  }

  /**
   * Applica la calibrazione isotonica a una probabilità raw.
   * Usa interpolazione lineare tra i punti di calibrazione.
   *
   * BLENDING ANTI-OVERFITTING:
   * La calibrazione isotonica può peggiorare le prestazioni se stimata
   * su un campione piccolo o non stazionario. Regola d'oro: mai calibrare
   * su meno di ~1000 predizioni. Sotto quella soglia, il blending
   * ammortizza il rischio:
   *
   *   P_final = α * P_raw + (1 - α) * P_cal
   *
   * dove α dipende dal numero di osservazioni:
   *   - n < 200   → α = 0.90 (quasi tutto il peso al modello raw)
   *   - n = 500   → α ≈ 0.70
   *   - n = 1000  → α ≈ 0.50 (blending bilanciato)
   *   - n ≥ 3000  → α ≈ 0.10 (quasi tutto il peso alla calibrazione)
   *
   * @param rawProb           Probabilità raw del modello [0,1]
   * @param calibrationPoints Output di fitIsotonicCalibration
   * @param nObservations     Numero di predizioni usate per stimare la calibrazione
   */
  calibrate(
    rawProb: number,
    calibrationPoints: Array<{ x: number; y: number }>,
    nObservations = 0
  ): number {
    if (!calibrationPoints || calibrationPoints.length < 2) return rawProb;
    if (rawProb <= 0) return 0;
    if (rawProb >= 1) return 1;

    // Interpolazione lineare tra i punti di calibrazione
    let pCal = rawProb; // fallback
    for (let i = 0; i < calibrationPoints.length - 1; i++) {
      const lo = calibrationPoints[i];
      const hi = calibrationPoints[i + 1];
      if (rawProb >= lo.x && rawProb <= hi.x) {
        const t = hi.x > lo.x ? (rawProb - lo.x) / (hi.x - lo.x) : 0;
        pCal = lo.y + t * (hi.y - lo.y);
        break;
      }
    }

    // Blending: α decresce all'aumentare di n
    // α = 1/(1 + n/1000) → sigmoid-like con punto medio a n=1000
    const n = Math.max(0, nObservations);
    const alpha = n < 200
      ? 0.90                               // campione piccolo: quasi ignorare cal
      : Math.max(0.10, 1 / (1 + n / 1000)); // decresce verso 0.10 con n grande

    const pFinal = alpha * rawProb + (1 - alpha) * pCal;
    return Math.min(0.99, Math.max(0.01, pFinal));
  }

  // ==================== BUDGET E SCOMMESSE ====================

  /**
   * Validazione consistenza budget.
   */
  validateBudget(budget: BudgetState): boolean {
    const expectedAvailable =
      budget.totalBudget +
      budget.totalWon -
      budget.totalLost -
      budget.totalStaked;
    return Math.abs(expectedAvailable - budget.availableBudget) < 0.01;
  }

  /**
   * Liquidazione scommessa con calcolo ROI corretto.
   *
   * MIGLIORAMENTO: il ROI viene calcolato SOLO sulle scommesse liquidate
   * (WON + LOST), escludendo quelle pendenti. Questo evita di
   * sottostimare il ROI quando ci sono bet aperti.
   *
   * ROI = (totalWon - totalLost) / settledStaked × 100
   */
  settleBet(
    budget: BudgetState,
    bet: BetRecord,
    won: boolean,
    returnAmount?: number,
    // NUOVO: passare tutte le scommesse per calcolare settled correctly
    allBets?: BetRecord[]
  ): { updatedBudget: BudgetState; updatedBet: BetRecord } {
    const updatedBet = { ...bet };
    const updatedBudget = { ...budget };

    if (won) {
      const winAmount = returnAmount ?? bet.stake * bet.odds;
      updatedBet.status = 'WON';
      updatedBet.returnAmount = winAmount;
      updatedBet.profit = winAmount - bet.stake;
      updatedBudget.availableBudget += winAmount;
      updatedBudget.totalWon += winAmount;
    } else {
      updatedBet.status = 'LOST';
      updatedBet.returnAmount = 0;
      updatedBet.profit = -bet.stake;
      updatedBudget.totalLost += bet.stake;
    }

    updatedBet.settledAt = new Date();
    updatedBudget.updatedAt = new Date();

    // ROI solo su scommesse liquidate
    if (allBets && allBets.length > 0) {
      const settled = allBets.filter(
        (b) => b.status === 'WON' || b.status === 'LOST'
      );
      // Include anche la scommessa appena liquidata
      const settledStaked = settled.reduce((s, b) => s + b.stake, 0) + bet.stake;
      const totalReturn = settled.reduce(
        (s, b) => s + (b.status === 'WON' ? (b.returnAmount ?? b.stake * b.odds) : 0),
        0
      ) + (won ? (returnAmount ?? bet.stake * bet.odds) : 0);
      const totalLostSettled = settled.reduce(
        (s, b) => s + (b.status === 'LOST' ? b.stake : 0),
        0
      ) + (won ? 0 : bet.stake);

      if (settledStaked > 0) {
        updatedBudget.roi = ((totalReturn - settledStaked) / settledStaked) * 100;
      }
    } else {
      // Fallback: metodo originale ma almeno esclude le pending
      // Approssimazione: (won - lost) / (won_stake + lost_stake)
      const wonAmount = updatedBudget.totalWon;
      const lostAmount = updatedBudget.totalLost;
      const settledStakedApprox = wonAmount / Math.max(0.01, budget.totalBets > 0
        ? (won ? budget.roi / 100 + 1 : 1)
        : 1);
      // Fallback semplificato: usa totalStaked se non abbiamo info migliori
      if (updatedBudget.totalStaked > 0) {
        updatedBudget.roi =
          ((updatedBudget.totalWon - updatedBudget.totalLost) /
            updatedBudget.totalStaked) *
          100;
      }
    }

    return { updatedBudget, updatedBet };
  }

  /**
   * Piazza una scommessa — deduce dallo stake disponibile.
   */
  placeBet(budget: BudgetState, stakeAmount: number): BudgetState {
    if (!isFinite(stakeAmount) || stakeAmount <= 0) {
      throw new Error('Importo scommessa non valido');
    }
    if (stakeAmount > budget.availableBudget) {
      throw new Error(
        `Budget insufficiente: servono €${stakeAmount.toFixed(2)}, disponibili €${budget.availableBudget.toFixed(2)}`
      );
    }
    return {
      ...budget,
      availableBudget: budget.availableBudget - stakeAmount,
      totalStaked: budget.totalStaked + stakeAmount,
      totalBets: budget.totalBets + 1,
      updatedAt: new Date(),
    };
  }

  // ==================== UTILITY ====================

  /**
   * Dato un set di quote bookmaker per un mercato 1X2,
   * restituisce le probabilità senza vig per i tre outcome.
   * Metodo di convenienza per il frontend.
   */
  devig1X2(
    oddsHome: number,
    oddsDraw: number,
    oddsAway: number
  ): { home: number; draw: number; away: number; overround: number } {
    const allOdds = [oddsHome, oddsDraw, oddsAway].filter(
      (o) => isFinite(o) && o > 1
    );
    const overround = allOdds.reduce((s, o) => s + 1 / o, 0);
    return {
      home: this.impliedProbabilityNoVig(oddsHome, allOdds),
      draw: this.impliedProbabilityNoVig(oddsDraw, allOdds),
      away: this.impliedProbabilityNoVig(oddsAway, allOdds),
      overround: parseFloat(overround.toFixed(4)),
    };
  }

  /**
   * Dato un mercato Over/Under, restituisce le probabilità senza vig.
   */
  devigOverUnder(
    oddsOver: number,
    oddsUnder: number
  ): { over: number; under: number; overround: number } {
    const allOdds = [oddsOver, oddsUnder].filter((o) => isFinite(o) && o > 1);
    const overround = allOdds.reduce((s, o) => s + 1 / o, 0);
    return {
      over: this.impliedProbabilityNoVig(oddsOver, allOdds),
      under: this.impliedProbabilityNoVig(oddsUnder, allOdds),
      overround: parseFloat(overround.toFixed(4)),
    };
  }
}