/**
 * Value Betting Engine — v3 (Ibrido Adattivo Kelly)
 * ===================================================
 *
 * FILOSOFIA v3:
 * -------------
 * Kelly Criterion è già un filtro adattivo naturale:
 * - Bet prob 20%, quota 4.50, EV +10% → stake Kelly ≈ 0.7% bankroll
 * - Bet prob 60%, quota 1.90, EV +14% → stake Kelly ≈ 4.2% → capped 4%
 * Non serve quindi un filtro arbitrario MIN_PROBABILITY o MAX_ODDS.
 * Il modello decide quanto scommettere in base all'edge reale.
 *
 * FILTRI MANTENUTI (matematicamente giustificati):
 * -------------------------------------------------
 * 1. MIN_ODDS 1.40: sotto questa quota il margine bookmaker erode qualsiasi edge.
 *    (Un'odds 1.30 con vig 6% → implied no-vig ≈ 1.23 → pochissimo spazio.)
 * 2. MAX_ODDS 8.00: oltre questa quota il modello Dixon-Coles non ha abbastanza
 *    dati storici per stimare correttamente probabilità così basse.
 * 3. Edge no-vig > 0: filtro qualità fondamentale. Confrontiamo la nostra prob
 *    con quella del bookmaker SENZA il suo margine. Se anche dopo aver tolto
 *    il vig siamo sotto, non c'è valore.
 * 4. EV MINIMO PER CATEGORIA (soglie differenziate per modello):
 *    - goal/1x2/btts:          EV > 3.0%  (modello DC maturo, affidabile)
 *    - over/under goal:        EV > 2.5%  (DC ottimo su goal totali)
 *    - tiri/shots:             EV > 4.0%  (NegBin shots, buono ma più rumore)
 *    - cartellini/gialli:      EV > 4.5%  (NegBin cards, fattore arbitro stima incerta)
 *    - falli:                  EV > 5.0%  (NegBin fouls, modello con più incertezza)
 *    - exact score/handicap:   EV > 5.0%  (alta varianza, serve margine ampio)
 * 5. MAX_STAKE 4% bankroll (Quarter Kelly già lo limita, questo è un cap assoluto).
 * 6. Coerenza: nostra prob >= 80% * implied_raw (se il mercato ci "sorpassa"
 *    di oltre il 20% probabilmente non sappiamo qualcosa che il mercato sa).
 *
 * VOLUME TARGET 150-400 BET/STAGIONE:
 * ------------------------------------
 * Le soglie EV differenziate per categoria fungono da volume control naturale.
 * Alzare una soglia → meno bet in quella categoria.
 * Il metodo getBetVolumeEstimate() restituisce una stima del volume atteso.
 *
 * CONFIDENCE → STAKE MULTIPLIER (non floor):
 * -------------------------------------------
 * HIGH:   Kelly × 1.20  (leggero boost: alta EV e alta prob)
 * MEDIUM: Kelly × 1.00  (neutro)
 * LOW:    Kelly × 0.70  (riduzione: segnale debole)
 * LOW viene ancora accettata se Kelly è positivo — solo con stake ridotto.
 */

// ==================== COMBINATA (MULTI-BET) ====================

/**
 * Rappresenta una scommessa combinata (accumulatore) di N quote singole.
 *
 * MATEMATICA:
 * - Probabilità combinata = Π(ourProbability_i) — SOLO se le quote sono su
 *   partite diverse (indipendenza statistica). Quote della stessa partita
 *   possono essere correlate: il campo warningCorrelation lo segnala.
 * - Quota combinata = Π(bookmakerOdds_i)
 * - EV combinato = P_combinata × Quota_combinata − 1
 * - Kelly combinato = (P × Q − 1) / (Q − 1) × 0.25 (Quarter Kelly)
 * - MAX_STAKE combinata: cap più basso (2.4% vs 4%) perché la varianza
 *   aumenta moltiplicativamente con il numero di gambe.
 */
export interface ComboBetOpportunity {
  /** Quote singole che compongono la combinata */
  legs: BetOpportunity[];
  /** Numero di gambe (2, 3, ...) */
  numLegs: number;
  /** Quota decimale combinata = Π(odds_i) */
  combinedOdds: number;
  /** Probabilità combinata del modello in percentuale = Π(ourProb_i/100)×100 */
  combinedProbability: number;
  /** EV combinato in percentuale */
  combinedEV: number;
  /** Quarter Kelly applicato alla combinata, in percentuale */
  kellyFraction: number;
  /** Stake suggerito in % bankroll (capped più basso delle singole) */
  suggestedStakePercent: number;
  /** Confidence: HIGH solo se tutte le gambe sono HIGH; LOW se almeno una è LOW */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** True se tutte le gambe provengono da matchId diversi */
  isIndependent: boolean;
  /** Presente se due o più gambe provengono dalla stessa partita */
  warningCorrelation?: string;
}

export interface BetOpportunity {
  marketName: string;
  selection: string;
  marketCategory: MarketCategory;
  marketTier: MarketTier;
  selectionFamily?: string;
  adaptiveRankMultiplier?: number;
  ourProbability: number;           // percentuale (0-100)
  bookmakerOdds: number;
  impliedProbability: number;       // percentuale raw (con vig)
  impliedProbabilityNoVig: number;  // percentuale senza vig
  expectedValue: number;            // percentuale
  kellyFraction: number;            // percentuale (full Kelly × 0.25)
  suggestedStakePercent: number;    // stake effettivo post-confidence
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  isValueBet: boolean;
  edge: number;                     // vs implied raw
  edgeNoVig: number;                // vs implied senza vig
  /** matchId della partita di riferimento — usato per rilevare correlazione nelle combinate */
  matchId?: string;
}

export type MarketCategory =
  | 'goal_1x2'       // homeWin, draw, awayWin, btts, bttsNo, dnb
  | 'goal_ou'        // over/under 0.5 - 4.5
  | 'shots'          // tiri squadra e totali
  | 'shots_ot'       // tiri in porta
  | 'corners'        // angoli totali
  | 'yellow_cards'   // cartellini gialli
  | 'fouls'          // falli
  | 'exact_score'    // risultato esatto
  | 'handicap'       // handicap europeo e asiatico
  | 'other';

export type MarketTier = 'CORE' | 'SECONDARY' | 'SPECULATIVE';
export type SelectionFamily = string;

export interface AdaptiveCategoryTuning {
  evDelta: number;
  coherenceDelta: number;
  rankingMultiplier: number;
  sampleSize: number;
  rankingErrorRate: number;
  filterRejectionRate: number;
  confirmationRate: number;
  wrongPickRate: number;
}

export interface AdaptiveEngineTuningProfile {
  source: string;
  generatedAt: string;
  totalReviews: number;
  categories: Partial<Record<MarketCategory, AdaptiveCategoryTuning>>;
  selectionFamilies?: Record<string, AdaptiveCategoryTuning>;
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

export interface MarketOddsGroup {
  selection: string;
  odds: number;
  companions: number[];
}

export interface SelectionDiagnostics {
  selection: string;
  marketName: string;
  marketCategory: MarketCategory;
  marketTier: MarketTier;
  selectionFamily: SelectionFamily;
  bookmakerOdds: number | null;
  ourProbability: number | null;
  impliedProbability: number | null;
  impliedProbabilityNoVig: number | null;
  expectedValue: number | null;
  edge: number | null;
  edgeNoVig: number | null;
  kellyFraction: number | null;
  suggestedStakePercent: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  bookmakerMargin: number;
  minEvThreshold: number;
  filterSettings: {
    minOdds: number;
    maxOdds: number;
    coherenceRatio: number;
  };
  adaptiveRankMultiplier: number;
  passed: boolean;
  rejectionCodes: string[];
  rejectionReasons: string[];
}

// ==================== SOGLIE EV PER CATEGORIA ====================

/**
 * Soglie EV minimo (in decimale, non percentuale) per categoria.
 * Razionale: più il modello è incerto, più serve margine di sicurezza.
 *
 * Calibrazione empirica:
 * - goal_1x2:    Dixon-Coles validato su 10k+ partite → soglia bassa
 * - goal_ou:     Poisson su goal totali → molto affidabile
 * - shots:       NegBin su tiri → buono ma influenzato da stile di gioco
 * - shots_ot:    Tasso in porta variabile → più incerto
 * - yellow_cards: Fattore arbitro con ampia varianza → soglia alta
 * - fouls:       Correlazione possesso non lineare → incertezza maggiore
 * - exact_score: Alta varianza strutturale → soglia massima
 * - handicap:    Dipende da stima goal, propagazione errore → alta soglia
 */
const EV_THRESHOLDS: Record<MarketCategory, number> = {
  goal_1x2:    0.030,   // 3.0%
  goal_ou:     0.025,   // 2.5%
  shots:       0.005,   // mercato core
  shots_ot:    0.005,   // mercato core
  corners:     0.008,
  yellow_cards: 0.008,
  fouls:       0.008,
  exact_score: 0.050,
  handicap:    0.050,
  other:       0.040,
};

const EV_MARGIN_BUFFERS: Record<MarketCategory, number> = {
  goal_1x2:    0.02,
  goal_ou:     0.02,
  shots:       0.03,
  corners:     0.03,
  yellow_cards: 0.025,
  fouls:       0.03,
  shots_ot:    0.03,
  handicap:    0.02,
  exact_score: 0.05,
  other:       0.04,
};

export class ValueBettingEngine {
  // Filtri globali (valgono per tutte le categorie)
  private readonly MIN_ODDS         = 1.40;   // margine bookmaker troppo alto sotto
  private readonly MAX_ODDS         = 12.00;  // modello inaffidabile oltre
  private readonly KELLY_FRACTION   = 0.25;   // Quarter Kelly (conservativo)
  private readonly MAX_STAKE_PERCENT = 4.0;   // cap assoluto % bankroll
  private readonly MIN_STAKE_PERCENT = 0.25;  // stake minimo (non vale la pena sotto)
  private readonly COHERENCE_RATIO  = 0.65;   // nostra prob >= 65% implied_raw

  private readonly CONFIDENCE_MULTIPLIERS = {
    HIGH:   1.20,
    MEDIUM: 1.00,
    LOW:    0.70,   // accettata ma con stake ridotto
  };
  private adaptiveTuningProfile: AdaptiveEngineTuningProfile | null = null;

  private clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  setAdaptiveTuning(profile: AdaptiveEngineTuningProfile | null | undefined): void {
    this.adaptiveTuningProfile = profile ?? null;
  }

  getAdaptiveTuning(): AdaptiveEngineTuningProfile | null {
    return this.adaptiveTuningProfile;
  }

  private getCategoryTuning(category: MarketCategory): AdaptiveCategoryTuning {
    return this.adaptiveTuningProfile?.categories?.[category] ?? {
      evDelta: 0,
      coherenceDelta: 0,
      rankingMultiplier: 1,
      sampleSize: 0,
      rankingErrorRate: 0,
      filterRejectionRate: 0,
      confirmationRate: 0,
      wrongPickRate: 0,
    };
  }

  private getFamilyTuning(selectionFamily: SelectionFamily): AdaptiveCategoryTuning {
    return this.adaptiveTuningProfile?.selectionFamilies?.[selectionFamily] ?? {
      evDelta: 0,
      coherenceDelta: 0,
      rankingMultiplier: 1,
      sampleSize: 0,
      rankingErrorRate: 0,
      filterRejectionRate: 0,
      confirmationRate: 0,
      wrongPickRate: 0,
    };
  }

  private getCombinedTuning(category: MarketCategory, selection: string): AdaptiveCategoryTuning {
    const categoryTuning = this.getCategoryTuning(category);
    const familyTuning = this.getFamilyTuning(this.getSelectionFamily(selection));

    return {
      evDelta: this.clampNumber(categoryTuning.evDelta + familyTuning.evDelta, -0.03, 0.03),
      coherenceDelta: this.clampNumber(categoryTuning.coherenceDelta + familyTuning.coherenceDelta, -0.18, 0.12),
      rankingMultiplier: this.clampNumber(categoryTuning.rankingMultiplier * familyTuning.rankingMultiplier, 0.8, 1.35),
      sampleSize: Number((Number(categoryTuning.sampleSize ?? 0) + Number(familyTuning.sampleSize ?? 0)).toFixed(2)),
      rankingErrorRate: Number((Number(categoryTuning.rankingErrorRate ?? 0) + Number(familyTuning.rankingErrorRate ?? 0)).toFixed(2)),
      filterRejectionRate: Number((Number(categoryTuning.filterRejectionRate ?? 0) + Number(familyTuning.filterRejectionRate ?? 0)).toFixed(2)),
      confirmationRate: Number((Number(categoryTuning.confirmationRate ?? 0) + Number(familyTuning.confirmationRate ?? 0)).toFixed(2)),
      wrongPickRate: Number((Number(categoryTuning.wrongPickRate ?? 0) + Number(familyTuning.wrongPickRate ?? 0)).toFixed(2)),
    };
  }

  private getFilterSettings(category: MarketCategory, selection?: string): {
    minOdds: number;
    maxOdds: number;
    coherenceRatio: number;
  } {
    const isShotsDisciplineCore =
      category === 'shots' ||
      category === 'shots_ot' ||
      category === 'corners' ||
      category === 'fouls' ||
      category === 'yellow_cards';

    const tuning = selection ? this.getCombinedTuning(category, selection) : this.getCategoryTuning(category);
    const baseCoherence = isShotsDisciplineCore ? 0.55 : this.COHERENCE_RATIO;
    return {
      minOdds: isShotsDisciplineCore ? 1.20 : this.MIN_ODDS,
      maxOdds: isShotsDisciplineCore ? 15.00 : this.MAX_ODDS,
      coherenceRatio: this.clampNumber(baseCoherence + tuning.coherenceDelta, 0.45, 0.85),
    };
  }

  getMarketTier(category: MarketCategory): MarketTier {
    if (category === 'goal_1x2' || category === 'goal_ou') return 'CORE';
    if (category === 'shots' || category === 'shots_ot' || category === 'corners' || category === 'yellow_cards' || category === 'fouls')
      return 'SECONDARY';
    return 'SPECULATIVE';
  }

  getSelectionFamily(selection: string): SelectionFamily {
    const s = String(selection ?? '').toLowerCase();

    if (s === 'homewin') return 'home_win';
    if (s === 'draw') return 'draw';
    if (s === 'awaywin') return 'away_win';
    if (s === 'btts') return 'btts_yes';
    if (s === 'bttsno') return 'btts_no';
    if (s === 'dnb_home') return 'dnb_home';
    if (s === 'dnb_away') return 'dnb_away';
    if (s === 'double_chance_1x') return 'double_chance_1x';
    if (s === 'double_chance_x2') return 'double_chance_x2';
    if (s === 'double_chance_12') return 'double_chance_12';
    if (/^team_home_(over|under)_/.test(s)) return s.includes('_over_') ? 'team_home_goal_over' : 'team_home_goal_under';
    if (/^team_away_(over|under)_/.test(s)) return s.includes('_over_') ? 'team_away_goal_over' : 'team_away_goal_under';
    if (/^(over|under)(0[5]|1[5]|2[5]|3[5]|4[5])$/.test(s)) return s.startsWith('over') ? 'goal_over' : 'goal_under';
    if (/^shots_total_(over|under)_/.test(s) || /^shots(over|under)\d+$/i.test(s)) return s.includes('under') ? 'shots_total_under' : 'shots_total_over';
    if (/^shots_home_(over|under)_/.test(s) || /^shotshome(over|under)\d+$/i.test(s)) return s.includes('under') ? 'shots_home_under' : 'shots_home_over';
    if (/^shots_away_(over|under)_/.test(s) || /^shotsaway(over|under)\d+$/i.test(s)) return s.includes('under') ? 'shots_away_under' : 'shots_away_over';
    if (/^sot_total_(over|under)_/.test(s) || /^shotsot(over|under)\d+$/i.test(s)) return s.includes('under') ? 'shots_ot_under' : 'shots_ot_over';
    if (/^corners_(over|under)_/.test(s) || /^corners(over|under)\d+$/i.test(s)) return s.includes('under') ? 'corners_under' : 'corners_over';
    if (/^yellow_(over|under)_/.test(s) || /^cards_total_(over|under)_/.test(s) || /^(yellow|cardstotal)(over|under)\d+$/i.test(s)) {
      return s.includes('under') ? 'cards_under' : 'cards_over';
    }
    if (/^fouls_(over|under)_/.test(s) || /^fouls(over|under)\d+$/i.test(s)) return s.includes('under') ? 'fouls_under' : 'fouls_over';
    if (s.startsWith('hcp_') || s.startsWith('ahcp_') || s.startsWith('asian_')) {
      if (s.includes('away')) return 'handicap_away';
      return 'handicap_home';
    }
    if (s.startsWith('exact_')) return 'exact_score';

    return `${this.categorizeSelection(selection)}_generic`;
  }

  // ==================== CATEGORIZZAZIONE ====================

  categorizeSelection(selection: string): MarketCategory {
    const s = String(selection ?? '').toLowerCase();

    // 1X2 e derivati
    if (['homewin','draw','awaywin','btts','bttsno','dnb_home','dnb_away',
         'double_chance_1x','double_chance_x2','double_chance_12'].includes(s))
      return 'goal_1x2';

    // Goal over/under
    if (/^(over|under)(0[5]|1[5]|2[5]|3[5]|4[5])$/.test(s))
      return 'goal_ou';
    if (/^team_(home|away)_(over|under)/.test(s))
      return 'goal_ou';

    // Handicap
    if (s.startsWith('hcp_') || s.startsWith('ahcp_') || s.startsWith('asian_'))
      return 'handicap';

    // Risultato esatto
    if (s.startsWith('exact_'))
      return 'exact_score';

    // Snake_case bookmaker
    if (/^shots_total_(over|under)/.test(s)) return 'shots';
    if (/^shots_home_(over|under)/.test(s)) return 'shots';
    if (/^shots_away_(over|under)/.test(s)) return 'shots';
    if (/^sot_total_(over|under)/.test(s)) return 'shots_ot';
    if (/^corners_(over|under)/.test(s)) return 'corners';
    if (/^yellow_(over|under)/.test(s)) return 'yellow_cards';
    if (/^cards_total_(over|under)/.test(s)) return 'yellow_cards';
    if (/^fouls_(over|under)/.test(s)) return 'fouls';

    // CamelCase interno
    if (/^shots(over|under)\d+$/.test(s)) return 'shots';
    if (/^shotshome(over|under)\d+$/.test(s)) return 'shots';
    if (/^shotsaway(over|under)\d+$/.test(s)) return 'shots';
    if (/^shotsot(over|under)\d+$/.test(s)) return 'shots_ot';
    if (/^corners(over|under)\d+$/.test(s)) return 'corners';
    if (/^yellow(over|under)\d+$/.test(s)) return 'yellow_cards';
    if (/^cardstotal(over|under)\d+$/.test(s)) return 'yellow_cards';
    if (/^fouls(over|under)\d+$/.test(s)) return 'fouls';

    return 'other';
  }

  // ==================== EXPECTED VALUE ====================

  computeExpectedValue(probability: number, decimalOdds: number): number {
    if (!isFinite(probability) || probability <= 0 || probability >= 1) return -1;
    if (!isFinite(decimalOdds) || decimalOdds <= 1) return -1;
    return probability * decimalOdds - 1;
  }

  // ==================== IMPLIED PROBABILITY ====================

  impliedProbabilityFromOdds(decimalOdds: number): number {
    if (!isFinite(decimalOdds) || decimalOdds <= 1) return 0;
    return 1 / decimalOdds;
  }

  /**
   * Vig removal proporzionale (Pinnacle standard).
   * P_no_vig_i = (1/odds_i) / Σ(1/odds_j)
   */
  impliedProbabilityNoVig(odds: number, allOdds: number[]): number {
    if (!isFinite(odds) || odds <= 1) return 0;
    if (!allOdds || allOdds.length === 0) return this.impliedProbabilityFromOdds(odds);
    const overround = allOdds.reduce((s,o) => (!isFinite(o)||o<=1 ? s : s+1/o), 0);
    if (overround <= 0) return this.impliedProbabilityFromOdds(odds);
    return Math.min(0.99, Math.max(0.01, (1/odds) / overround));
  }

  computeOverround(allOdds: number[]): number {
    return allOdds.reduce((s,o) => (!isFinite(o)||o<=1 ? s : s+1/o), 0);
  }

  private computeBookmakerMargin(allOdds: number[]): number {
    const overround = this.computeOverround(allOdds);
    if (!isFinite(overround) || overround <= 0) return 0;
    return Math.max(0, overround - 1);
  }

  private minEvForCategory(category: MarketCategory, margin?: number, selection?: string): number {
    const tuning = selection ? this.getCombinedTuning(category, selection) : this.getCategoryTuning(category);
    if (!isFinite(Number(margin))) return this.clampNumber(EV_THRESHOLDS[category] + tuning.evDelta, 0.001, 0.12);
    const buffer = EV_MARGIN_BUFFERS[category] ?? 0.03;
    return this.clampNumber(Math.max(0, Number(margin) + buffer) + tuning.evDelta, 0.001, 0.12);
  }

  private getCategoryRankingMultiplier(category: MarketCategory, selection?: string): number {
    const tuning = selection ? this.getCombinedTuning(category, selection) : this.getCategoryTuning(category);
    return this.clampNumber(tuning.rankingMultiplier, 0.85, 1.25);
  }

  private computeCategoryMargins(
    bookmakerOdds: Record<string, number>
  ): Record<MarketCategory, number> {
    const groups = this.buildMarketGroups(bookmakerOdds);
    const sums: Record<MarketCategory, number> = {} as Record<MarketCategory, number>;
    const counts: Record<MarketCategory, number> = {} as Record<MarketCategory, number>;
    const seen = new Set<string>();

    for (const [selection, group] of Object.entries(groups)) {
      const category = this.categorizeSelection(selection);
      const oddsList = [group.odds, ...group.companions].filter(o => isFinite(o) && o > 1).sort((a,b)=>a-b);
      if (oddsList.length < 2) continue;
      const key = `${category}|${oddsList.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const margin = this.computeBookmakerMargin(oddsList);
      if (!isFinite(margin)) continue;
      sums[category] = (sums[category] ?? 0) + margin;
      counts[category] = (counts[category] ?? 0) + 1;
    }

    const out: Record<MarketCategory, number> = {} as Record<MarketCategory, number>;
    (Object.keys(sums) as MarketCategory[]).forEach((cat) => {
      const avg = sums[cat] / Math.max(1, counts[cat] ?? 1);
      out[cat] = Math.max(0, Math.min(0.25, avg));
    });
    return out;
  }

  private computeCategoryMarginsFromGroups(
    marketGroups: Record<string, MarketOddsGroup>
  ): Record<MarketCategory, number> {
    const sums: Record<MarketCategory, number> = {} as Record<MarketCategory, number>;
    const counts: Record<MarketCategory, number> = {} as Record<MarketCategory, number>;
    const seen = new Set<string>();

    for (const [selection, group] of Object.entries(marketGroups)) {
      const category = this.categorizeSelection(selection);
      const oddsList = [group.odds, ...group.companions].filter(o => isFinite(o) && o > 1).sort((a,b)=>a-b);
      if (oddsList.length < 2) continue;
      const key = `${category}|${oddsList.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const margin = this.computeBookmakerMargin(oddsList);
      if (!isFinite(margin)) continue;
      sums[category] = (sums[category] ?? 0) + margin;
      counts[category] = (counts[category] ?? 0) + 1;
    }

    const out: Record<MarketCategory, number> = {} as Record<MarketCategory, number>;
    (Object.keys(sums) as MarketCategory[]).forEach((cat) => {
      const avg = sums[cat] / Math.max(1, counts[cat] ?? 1);
      out[cat] = Math.max(0, Math.min(0.25, avg));
    });
    return out;
  }

  // ==================== KELLY CRITERION ====================

  kellyFraction(probability: number, decimalOdds: number): number {
    if (!isFinite(probability) || probability <= 0 || probability >= 1) return 0;
    if (!isFinite(decimalOdds) || decimalOdds <= 1) return 0;
    const b = decimalOdds - 1;
    const fullKelly = (b * probability - (1 - probability)) / b;
    if (fullKelly <= 0) return 0;
    return Math.min(fullKelly * this.KELLY_FRACTION, this.MAX_STAKE_PERCENT / 100);
  }

  computeSuggestedStake(
    probability: number,
    decimalOdds: number,
    ev: number
  ): { stakePercent: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
    const kelly = this.kellyFraction(probability, decimalOdds) * 100;

    // Confidence basata su EV e probabilità, NON su soglie fisse di odds
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    if      (ev >= 0.08 && kelly >= 1.5) confidence = 'HIGH';
    else if (ev >= 0.05 && kelly >= 0.8) confidence = 'MEDIUM';
    else                                  confidence = 'LOW';

    const rawStake = kelly * this.CONFIDENCE_MULTIPLIERS[confidence];
    const stakePercent = Math.max(
      this.MIN_STAKE_PERCENT,
      Math.min(this.MAX_STAKE_PERCENT, rawStake)
    );
    return { stakePercent: parseFloat(stakePercent.toFixed(2)), confidence };
  }

  // ==================== FILTRI ADATTATIVI v3 ====================

  /**
   * Gate principale — Kelly adattivo, filtri minimi giustificati.
   *
   * NON filtra per probabilità minima assoluta: Kelly già penalizza
   * le bet su underdog assegnando stake proporzionalmente piccoli.
   * NON filtra per MAX_ODDS fisso basso: un underdog a quota 7.00 con
   * EV genuino riceve stake piccolo ma viene accettato.
   *
   * FILTRA:
   * 1. Odds fuori da [MIN_ODDS, MAX_ODDS] = [1.40, 8.00]
   * 2. EV <= soglia della categoria (differenziata per affidabilità modello)
   * 3. Edge no-vig <= 0 (il bookmaker ci batte anche senza margine)
   * 4. Incoerenza: nostra prob < 80% implied_raw (mercato sa qualcosa che non sappiamo)
   * 5. Kelly = 0 (EV negativo dal punto di vista Kelly → non scommettere mai)
   */
  private passesFilters(
    ourProb: number,
    odds: number,
    ev: number,
    edgeNoVig: number,
    category: MarketCategory,
    minEv: number
  ): boolean {
    const { minOdds, maxOdds, coherenceRatio } = this.getFilterSettings(category);

    // 1. Range odds assoluto
    if (odds < minOdds || odds > maxOdds) return false;

    // 2. EV minimo per categoria
    if (ev <= minEv) return false;

    // 3. Edge no-vig positivo
    if (edgeNoVig <= 0) return false;

    // 4. Coerenza prob/mercato
    const impliedRaw = this.impliedProbabilityFromOdds(odds);
    if (ourProb < impliedRaw * coherenceRatio) return false;

    // 5. Kelly positivo (ridondante con EV > 0, ma guard esplicito)
    if (this.kellyFraction(ourProb, odds) <= 0) return false;

    return true;
  }

  diagnoseSelection(
    probabilities: Record<string, number>,
    bookmakerOdds: Record<string, number>,
    selection: string,
    marketNames: Record<string, string> = {}
  ): SelectionDiagnostics {
    const category = this.categorizeSelection(selection);
    const marketTier = this.getMarketTier(category);
    const selectionFamily = this.getSelectionFamily(selection);
    const { minOdds, maxOdds, coherenceRatio } = this.getFilterSettings(category, selection);
    const odds = Number(bookmakerOdds?.[selection]);
    const ourProb = Number(probabilities?.[selection]);
    const groups = this.buildMarketGroups(bookmakerOdds ?? {});
    const group = groups[selection];
    const allOdds = group
      ? [group.odds, ...group.companions].filter((o) => isFinite(o) && o > 1)
      : (Number.isFinite(odds) && odds > 1 ? [odds] : []);
    const marginByCategory = this.computeCategoryMarginsFromGroups(groups);
    const bookmakerMargin = allOdds.length >= 2 ? this.computeBookmakerMargin(allOdds) : 0;
    const minEvThreshold = this.minEvForCategory(category, marginByCategory[category], selection);

    if (!Number.isFinite(odds) || odds <= 1 || !Number.isFinite(ourProb) || ourProb <= 0 || ourProb >= 1) {
      return {
        selection,
        marketName: marketNames[selection] ?? selection,
        marketCategory: category,
        marketTier,
        selectionFamily,
        bookmakerOdds: Number.isFinite(odds) && odds > 1 ? odds : null,
        ourProbability: Number.isFinite(ourProb) && ourProb > 0 && ourProb < 1 ? Number((ourProb * 100).toFixed(2)) : null,
        impliedProbability: null,
        impliedProbabilityNoVig: null,
        expectedValue: null,
        edge: null,
        edgeNoVig: null,
        kellyFraction: null,
        suggestedStakePercent: null,
        confidence: null,
        bookmakerMargin: Number((bookmakerMargin * 100).toFixed(2)),
        minEvThreshold: Number((minEvThreshold * 100).toFixed(2)),
        filterSettings: { minOdds, maxOdds, coherenceRatio },
        adaptiveRankMultiplier: Number(this.getCategoryRankingMultiplier(category, selection).toFixed(3)),
        passed: false,
        rejectionCodes: ['missing_market_data'],
        rejectionReasons: ['Mercato non disponibile nello snapshot quote o probabilita modello assente.'],
      };
    }

    const impliedRaw = this.impliedProbabilityFromOdds(odds);
    const impliedNoVig = allOdds.length >= 2 ? this.impliedProbabilityNoVig(odds, allOdds) : impliedRaw;
    const ev = this.computeExpectedValue(ourProb, odds);
    const edge = ourProb - impliedRaw;
    const edgeNoVig = ourProb - impliedNoVig;
    const kelly = this.kellyFraction(ourProb, odds);

    const rejectionCodes: string[] = [];
    const rejectionReasons: string[] = [];
    const addReason = (code: string, text: string) => {
      if (rejectionCodes.includes(code)) return;
      rejectionCodes.push(code);
      rejectionReasons.push(text);
    };

    if (odds < minOdds || odds > maxOdds) {
      addReason('odds_out_of_range', `Quota fuori range operativo (${minOdds.toFixed(2)} - ${maxOdds.toFixed(2)}).`);
    }
    if (ev <= minEvThreshold) {
      addReason('ev_below_threshold', `Valore atteso insufficiente per la categoria: ${Number((ev * 100).toFixed(2))}% contro soglia ${Number((minEvThreshold * 100).toFixed(2))}%.`);
    }
    if (edgeNoVig <= 0) {
      addReason('edge_no_vig_non_positive', 'Anche tolto il margine bookmaker, il modello non vedeva vantaggio reale.');
    }
    if (ourProb < impliedRaw * coherenceRatio) {
      addReason('coherence_too_low', 'La probabilita del modello era troppo distante da quella implicita del mercato.');
    }
    if (kelly <= 0) {
      addReason('kelly_non_positive', 'Lo stake Kelly risultava nullo, quindi il motore non la considerava giocabile.');
    }

    const passed = rejectionCodes.length === 0;
    const stake = passed ? this.computeSuggestedStake(ourProb, odds, ev) : null;

    return {
      selection,
      marketName: marketNames[selection] ?? selection,
      marketCategory: category,
      marketTier,
      selectionFamily,
      bookmakerOdds: Number(odds.toFixed(2)),
      ourProbability: Number((ourProb * 100).toFixed(2)),
      impliedProbability: Number((impliedRaw * 100).toFixed(2)),
      impliedProbabilityNoVig: Number((impliedNoVig * 100).toFixed(2)),
      expectedValue: Number((ev * 100).toFixed(2)),
      edge: Number((edge * 100).toFixed(2)),
      edgeNoVig: Number((edgeNoVig * 100).toFixed(2)),
      kellyFraction: Number((kelly * 100).toFixed(2)),
      suggestedStakePercent: stake ? stake.stakePercent : null,
      confidence: stake ? stake.confidence : null,
      bookmakerMargin: Number((bookmakerMargin * 100).toFixed(2)),
      minEvThreshold: Number((minEvThreshold * 100).toFixed(2)),
      filterSettings: { minOdds, maxOdds, coherenceRatio },
      adaptiveRankMultiplier: Number(this.getCategoryRankingMultiplier(category, selection).toFixed(3)),
      passed,
      rejectionCodes,
      rejectionReasons,
    };
  }

  // ==================== ANALISI MERCATI ====================

  analyzeMarkets(
    probabilities: Record<string, number>,
    bookmakerOdds: Record<string, number>,
    marketNames: Record<string, string>
  ): BetOpportunity[] {
    const opportunities: BetOpportunity[] = [];
    const marginByCategory = this.computeCategoryMargins(bookmakerOdds);

    for (const [key, ourProb] of Object.entries(probabilities)) {
      const odds = bookmakerOdds[key];
      if (!odds || !ourProb || ourProb <= 0 || ourProb >= 1) continue;

      const category   = this.categorizeSelection(key);
      const marketTier = this.getMarketTier(category);
      const selectionFamily = this.getSelectionFamily(key);
      const adaptiveRankMultiplier = this.getCategoryRankingMultiplier(category, key);
      const implied    = this.impliedProbabilityFromOdds(odds);
      const ev         = this.computeExpectedValue(ourProb, odds);
      const edge       = ourProb - implied;
      const edgeNoVig  = edge; // senza companions, uguale all'edge raw
      const minEv      = this.minEvForCategory(category, marginByCategory[category], key);

      if (!this.passesFilters(ourProb, odds, ev, edgeNoVig, category, minEv)) continue;

      const { stakePercent, confidence } = this.computeSuggestedStake(ourProb, odds, ev);

      opportunities.push({
        marketName:              marketNames[key] ?? key,
        selection:               key,
        marketCategory:          category,
        marketTier,
        selectionFamily,
        adaptiveRankMultiplier,
        ourProbability:          parseFloat((ourProb * 100).toFixed(2)),
        bookmakerOdds:           odds,
        impliedProbability:      parseFloat((implied    * 100).toFixed(2)),
        impliedProbabilityNoVig: parseFloat((implied    * 100).toFixed(2)),
        expectedValue:           parseFloat((ev         * 100).toFixed(2)),
        kellyFraction:           parseFloat((this.kellyFraction(ourProb, odds) * 100).toFixed(2)),
        suggestedStakePercent:   stakePercent,
        confidence,
        isValueBet:              true,
        edge:                    parseFloat((edge    * 100).toFixed(2)),
        edgeNoVig:               parseFloat((edgeNoVig * 100).toFixed(2)),
      });
    }

    return opportunities.sort((a, b) => (b.expectedValue * (b.adaptiveRankMultiplier ?? 1)) - (a.expectedValue * (a.adaptiveRankMultiplier ?? 1)));
  }

  /**
   * Versione con vig removal completo: usa le quote di tutti gli outcome
   * dello stesso mercato per calcolare l'edge reale (più preciso).
   */
  analyzeMarketsWithVigRemoval(
    probabilities: Record<string, number>,
    marketGroups: Record<string, MarketOddsGroup>,
    marketNames: Record<string, string>
  ): BetOpportunity[] {
    const opportunities: BetOpportunity[] = [];
    const marginByCategory = this.computeCategoryMarginsFromGroups(marketGroups);

    for (const [key, ourProb] of Object.entries(probabilities)) {
      const group = marketGroups[key];
      if (!group || !ourProb || ourProb <= 0 || ourProb >= 1) continue;

      const { odds, companions } = group;
      const allOdds      = [odds, ...companions.filter(o => isFinite(o) && o > 1)];
      const impliedRaw   = this.impliedProbabilityFromOdds(odds);
      const impliedNoVig = this.impliedProbabilityNoVig(odds, allOdds);
      const ev           = this.computeExpectedValue(ourProb, odds);
      const edgeRaw      = ourProb - impliedRaw;
      const edgeNoVig    = ourProb - impliedNoVig;
      const category     = this.categorizeSelection(key);
      const marketTier   = this.getMarketTier(category);
      const selectionFamily = this.getSelectionFamily(key);
      const adaptiveRankMultiplier = this.getCategoryRankingMultiplier(category, key);
      const minEv        = this.minEvForCategory(category, marginByCategory[category], key);

      if (!this.passesFilters(ourProb, odds, ev, edgeNoVig, category, minEv)) continue;

      const { stakePercent, confidence } = this.computeSuggestedStake(ourProb, odds, ev);

      opportunities.push({
        marketName:              marketNames[key] ?? key,
        selection:               key,
        marketCategory:          category,
        marketTier,
        selectionFamily,
        adaptiveRankMultiplier,
        ourProbability:          parseFloat((ourProb      * 100).toFixed(2)),
        bookmakerOdds:           odds,
        impliedProbability:      parseFloat((impliedRaw   * 100).toFixed(2)),
        impliedProbabilityNoVig: parseFloat((impliedNoVig * 100).toFixed(2)),
        expectedValue:           parseFloat((ev           * 100).toFixed(2)),
        kellyFraction:           parseFloat((this.kellyFraction(ourProb, odds) * 100).toFixed(2)),
        suggestedStakePercent:   stakePercent,
        confidence,
        isValueBet:              true,
        edge:                    parseFloat((edgeRaw   * 100).toFixed(2)),
        edgeNoVig:               parseFloat((edgeNoVig * 100).toFixed(2)),
      });
    }

    return opportunities.sort((a, b) => (b.expectedValue * (b.adaptiveRankMultiplier ?? 1)) - (a.expectedValue * (a.adaptiveRankMultiplier ?? 1)));
  }

  /**
   * Stima volume bet atteso per partita (utile per capire se si è nel
   * range target 150-400/stagione su 38 partite per squadra top di lega).
   */
  getBetVolumeEstimate(
    opportunities: BetOpportunity[]
  ): { total: number; byCategory: Record<MarketCategory, number> } {
    const byCategory = {} as Record<MarketCategory, number>;
    for (const opp of opportunities) {
      byCategory[opp.marketCategory] = (byCategory[opp.marketCategory] ?? 0) + 1;
    }
    return { total: opportunities.length, byCategory };
  }

  /**
   * Seleziona solo HIGH confidence — usato dal BacktestingEngine
   * per simulazioni conservative.
   */
  selectHighConfidence(opportunities: BetOpportunity[]): BetOpportunity[] {
    return opportunities.filter(o => o.confidence === 'HIGH');
  }

  /**
   * Seleziona HIGH + MEDIUM confidence — usato per target 150-400 bet.
   */
  selectMediumAndAbove(opportunities: BetOpportunity[]): BetOpportunity[] {
    return opportunities.filter(o => o.confidence === 'HIGH' || o.confidence === 'MEDIUM');
  }

  // ==================== MARKET GROUPS ====================

  buildMarketGroups(bookmakerOdds: Record<string, number>): Record<string, MarketOddsGroup> {
    const groups: Record<string, MarketOddsGroup> = {};
    const v = (o: number | undefined): o is number =>
      typeof o === 'number' && isFinite(o) && o > 1;

    const pair = (k1: string, k2: string) => {
      const o1 = bookmakerOdds[k1], o2 = bookmakerOdds[k2];
      if (v(o1)) groups[k1] = { selection: k1, odds: o1, companions: v(o2) ? [o2] : [] };
      if (v(o2)) groups[k2] = { selection: k2, odds: o2, companions: v(o1) ? [o1] : [] };
    };

    const triple = (k1: string, k2: string, k3: string) => {
      const o1 = bookmakerOdds[k1], o2 = bookmakerOdds[k2], o3 = bookmakerOdds[k3];
      if (v(o1)) groups[k1] = { selection: k1, odds: o1, companions: [o2,o3].filter(v) as number[] };
      if (v(o2)) groups[k2] = { selection: k2, odds: o2, companions: [o1,o3].filter(v) as number[] };
      if (v(o3)) groups[k3] = { selection: k3, odds: o3, companions: [o1,o2].filter(v) as number[] };
    };

    triple('homeWin', 'draw', 'awayWin');
    pair('btts', 'bttsNo');
    pair('dnb_home', 'dnb_away');
    triple('double_chance_1x', 'double_chance_x2', 'double_chance_12');

    for (const l of ['05','15','25','35','45'])        pair(`over${l}`, `under${l}`);
    for (const l of ['75','85','95','105','115','125','135','145','155','165','175']) {
      pair(`shotsOver${l}`, `shotsUnder${l}`);
      pair(`shotsHomeOver${l}`, `shotsHomeUnder${l}`);
      pair(`shotsAwayOver${l}`, `shotsAwayUnder${l}`);
    }
    for (const l of ['25','35','45','55','65','75','85','95','105','115']) {
      pair(`shotsOTOver${l}`, `shotsOTUnder${l}`);
    }
    for (const l of ['65','75','85','95','105','115','125','135','145']) {
      pair(`cornersOver${l}`, `cornersUnder${l}`);
    }
    for (const l of ['05','15','25','35','45','55','65','75','85'])
      pair(`yellowOver${l}`, `yellowUnder${l}`);
    for (const l of ['125','145','175','205','235','265','295','325','355'])
      pair(`foulsOver${l}`, `foulsUnder${l}`);

    // Mercati generici residui
    for (const key of Object.keys(bookmakerOdds)) {
      if (groups[key]) continue;
      const odds = bookmakerOdds[key];
      if (!v(odds)) continue;
      let comp: string | null = null;
      if      (key.startsWith('over'))      comp = 'under' + key.slice(4);
      else if (key.startsWith('under'))     comp = 'over'  + key.slice(5);
      else if (key.includes('_over_'))      comp = key.replace('_over_',  '_under_');
      else if (key.includes('_under_'))     comp = key.replace('_under_', '_over_');
      const cOdds = comp ? bookmakerOdds[comp] : undefined;
      groups[key] = { selection: key, odds, companions: v(cOdds) ? [cOdds!] : [] };
    }

    return groups;
  }

  // ==================== CALIBRAZIONE ISOTONICA ====================

  fitIsotonicCalibration(
    predictions: number[],
    outcomes: number[]
  ): { calibrationPoints: Array<{ x: number; y: number }> } {
    if (predictions.length !== outcomes.length || predictions.length === 0)
      return { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };

    const paired = predictions
      .map((p, i) => ({ p, o: outcomes[i] }))
      .filter(({ p }) => isFinite(p) && p >= 0 && p <= 1)
      .sort((a, b) => a.p - b.p);

    const nBuckets = Math.min(10, Math.floor(paired.length / 5));
    if (nBuckets < 2) return { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };

    const bSize = Math.ceil(paired.length / nBuckets);
    const buckets = [];
    for (let i = 0; i < paired.length; i += bSize) {
      const sl = paired.slice(i, i + bSize);
      buckets.push({
        xMean: sl.reduce((s,v) => s+v.p, 0) / sl.length,
        yMean: sl.reduce((s,v) => s+v.o, 0) / sl.length,
      });
    }

    const pools = buckets.map(b => ({ x: b.xMean, y: b.yMean, weight: 1 }));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < pools.length - 1; i++) {
        if (pools[i].y > pools[i+1].y) {
          const w1 = pools[i].weight, w2 = pools[i+1].weight;
          pools.splice(i, 2, {
            x: (pools[i].x*w1 + pools[i+1].x*w2) / (w1+w2),
            y: (pools[i].y*w1 + pools[i+1].y*w2) / (w1+w2),
            weight: w1+w2,
          });
          changed = true; break;
        }
      }
    }

    return { calibrationPoints: [{ x:0, y:0 }, ...pools.map(p => ({ x:p.x, y:p.y })), { x:1, y:1 }] };
  }

  calibrate(
    rawProb: number,
    calibrationPoints: Array<{ x: number; y: number }>,
    nObservations = 0
  ): number {
    if (!calibrationPoints || calibrationPoints.length < 2) return rawProb;
    if (rawProb <= 0) return 0;
    if (rawProb >= 1) return 1;

    let pCal = rawProb;
    for (let i = 0; i < calibrationPoints.length - 1; i++) {
      const lo = calibrationPoints[i], hi = calibrationPoints[i+1];
      if (rawProb >= lo.x && rawProb <= hi.x) {
        const t = hi.x > lo.x ? (rawProb - lo.x) / (hi.x - lo.x) : 0;
        pCal = lo.y + t * (hi.y - lo.y);
        break;
      }
    }

    const n = Math.max(0, nObservations);
    const alpha = n < 200 ? 0.90 : Math.max(0.10, 1 / (1 + n / 1000));
    return Math.min(0.99, Math.max(0.01, alpha * rawProb + (1-alpha) * pCal));
  }

  // ==================== BUDGET ====================

  validateBudget(budget: BudgetState): boolean {
    const exp = budget.totalBudget + budget.totalWon - budget.totalLost - budget.totalStaked;
    return Math.abs(exp - budget.availableBudget) < 0.01;
  }

  settleBet(
    budget: BudgetState, bet: BetRecord, won: boolean,
    returnAmount?: number, allBets?: BetRecord[]
  ): { updatedBudget: BudgetState; updatedBet: BetRecord } {
    const updatedBet    = { ...bet };
    const updatedBudget = { ...budget };

    if (won) {
      const win = returnAmount ?? bet.stake * bet.odds;
      updatedBet.status = 'WON'; updatedBet.returnAmount = win; updatedBet.profit = win - bet.stake;
      updatedBudget.availableBudget += win; updatedBudget.totalWon += win;
    } else {
      updatedBet.status = 'LOST'; updatedBet.returnAmount = 0; updatedBet.profit = -bet.stake;
      updatedBudget.totalLost += bet.stake;
    }
    updatedBet.settledAt = new Date(); updatedBudget.updatedAt = new Date();

    const settled       = (allBets ?? []).filter(b => b.status === 'WON' || b.status === 'LOST');
    const settledStaked = settled.reduce((s,b) => s+b.stake, 0) + bet.stake;
    const totalReturn   = settled.reduce((s,b) => s+(b.status==='WON'?(b.returnAmount??b.stake*b.odds):0), 0)
                        + (won ? (returnAmount??bet.stake*bet.odds) : 0);
    if (settledStaked > 0)
      updatedBudget.roi = ((totalReturn - settledStaked) / settledStaked) * 100;

    return { updatedBudget, updatedBet };
  }

  placeBet(budget: BudgetState, stakeAmount: number): BudgetState {
    if (!isFinite(stakeAmount) || stakeAmount <= 0) throw new Error('Importo scommessa non valido');
    if (stakeAmount > budget.availableBudget)
      throw new Error(`Budget insufficiente: servono €${stakeAmount.toFixed(2)}, disponibili €${budget.availableBudget.toFixed(2)}`);
    return {
      ...budget,
      availableBudget: budget.availableBudget - stakeAmount,
      totalStaked:     budget.totalStaked + stakeAmount,
      totalBets:       budget.totalBets + 1,
      updatedAt:       new Date(),
    };
  }

  // ==================== COMBINATA (MULTI-BET) ====================

  /**
   * Genera tutte le combinazioni di valore dalle scommesse singole passate.
   *
   * Logica di filtraggio:
   * - Combina da 2 a maxLegs scommesse.
   * - Scarta combinazioni con EV combinato inferiore a minCombinedEV.
   * - Segnala (ma non scarta) le combinazioni con quote della stessa partita
   *   (correlazione potenziale → EV potrebbe essere sovrastimato).
   * - Ordina per EV combinato decrescente.
   *
   * Uso tipico:
   *   const singles = engine.analyzeMarketsWithVigRemoval(...);
   *   const combos  = engine.buildCombinations(singles, 3, 0.08);
   *   // Considera solo le prime 5 combinate per partita
   *   const top5    = combos.slice(0, 5);
   *
   * @param opportunities  Lista di scommesse singole già filtrate con isValueBet=true.
   * @param maxLegs        Numero massimo di gambe per combinata (default 3).
   *                       Non superare 4: oltre quella soglia l'EV combinato
   *                       dipende troppo dall'accuratezza delle singole probabilità.
   * @param minCombinedEV  Soglia EV minimo in decimale (default 0.06 = 6%).
   *                       Più alta rispetto alle singole perché la varianza
   *                       aumenta con il numero di gambe.
   */
  buildCombinations(
    opportunities: BetOpportunity[],
    maxLegs = 3,
    minCombinedEV = 0.06
  ): ComboBetOpportunity[] {
    // Considera solo le bet singole già passate i filtri
    const valid = opportunities.filter((o) => o.isValueBet && o.ourProbability > 0 && o.bookmakerOdds > 1);
    if (valid.length < 2) return [];

    const results: ComboBetOpportunity[] = [];
    const clampedMax = Math.min(maxLegs, 4, valid.length);

    for (let size = 2; size <= clampedMax; size++) {
      const combos = this.generateCombinations(valid, size);
      for (const legs of combos) {
        const combo = this.evaluateCombo(legs, minCombinedEV);
        if (combo) results.push(combo);
      }
    }

    return results.sort(
      (a, b) => b.combinedEV - a.combinedEV
    );
  }

  /**
   * Valuta una singola combinazione di gambe.
   * Restituisce null se non supera la soglia EV o se il Kelly è nullo.
   */
  private evaluateCombo(legs: BetOpportunity[], minCombinedEV: number): ComboBetOpportunity | null {
    // Probabilità e quota combinate
    const combinedProbabilityDecimal = legs.reduce(
      (acc, leg) => acc * (leg.ourProbability / 100),
      1
    );
    const combinedOdds = legs.reduce((acc, leg) => acc * leg.bookmakerOdds, 1);
    const combinedEV = combinedProbabilityDecimal * combinedOdds - 1;

    if (combinedEV < minCombinedEV) return null;

    // Kelly per la combinata: stessa formula ma cap più basso
    const b = combinedOdds - 1;
    const fullKelly = b > 0
      ? (b * combinedProbabilityDecimal - (1 - combinedProbabilityDecimal)) / b
      : 0;
    if (fullKelly <= 0) return null;

    const quarterKelly = fullKelly * this.KELLY_FRACTION;
    // Cap combinata più conservativo: max 2.4% (60% del cap singola 4%)
    const MAX_COMBO_STAKE = this.MAX_STAKE_PERCENT * 0.6;
    const stakePercent = this.clampNumber(
      quarterKelly * 100,
      this.MIN_STAKE_PERCENT,
      MAX_COMBO_STAKE
    );

    // Confidence: peggiore delle gambe
    const hasLow  = legs.some((l) => l.confidence === 'LOW');
    const allHigh = legs.every((l) => l.confidence === 'HIGH');
    const confidence: 'HIGH' | 'MEDIUM' | 'LOW' = hasLow ? 'LOW' : allHigh ? 'HIGH' : 'MEDIUM';

    // Rilevamento correlazione: gambe della stessa partita
    const matchIds = legs.map((l) => l.matchId).filter(Boolean) as string[];
    const uniqueMatches = new Set(matchIds);
    const hasDuplicateMatch = matchIds.length > 0 && uniqueMatches.size < legs.length;

    return {
      legs,
      numLegs: legs.length,
      combinedOdds: Number(combinedOdds.toFixed(2)),
      combinedProbability: Number((combinedProbabilityDecimal * 100).toFixed(3)),
      combinedEV: Number((combinedEV * 100).toFixed(2)),
      kellyFraction: Number((quarterKelly * 100).toFixed(3)),
      suggestedStakePercent: Number(stakePercent.toFixed(2)),
      confidence,
      isIndependent: !hasDuplicateMatch,
      warningCorrelation: hasDuplicateMatch
        ? `Attenzione: ${legs.filter((l) => matchIds.filter((id) => id === l.matchId).length > 1).length} gambe provengono dalla stessa partita — la probabilità combinata potrebbe essere sovrastimata perché i mercati sono correlati.`
        : undefined,
    };
  }

  /**
   * Genera tutte le combinazioni di dimensione `size` dall'array `arr`.
   * Usa ricorsione tail-friendly con slice per evitare stack overflow su
   * array grandi (in pratica le bet singole per partita sono < 30).
   */
  private generateCombinations<T>(arr: T[], size: number): T[][] {
    if (size === 0) return [[]];
    if (size > arr.length) return [];
    if (size === arr.length) return [arr.slice()];

    const [first, ...rest] = arr;
    const withFirst = this.generateCombinations(rest, size - 1).map((combo) => [first, ...combo]);
    const withoutFirst = this.generateCombinations(rest, size);
    return [...withFirst, ...withoutFirst];
  }

  // ==================== UTILITY ====================

  devig1X2(oddsHome: number, oddsDraw: number, oddsAway: number) {
    const all = [oddsHome, oddsDraw, oddsAway].filter(o => isFinite(o) && o > 1);
    const or  = all.reduce((s,o) => s+1/o, 0);
    return {
      home: this.impliedProbabilityNoVig(oddsHome, all),
      draw: this.impliedProbabilityNoVig(oddsDraw, all),
      away: this.impliedProbabilityNoVig(oddsAway, all),
      overround: parseFloat(or.toFixed(4)),
    };
  }

  devigOverUnder(oddsOver: number, oddsUnder: number) {
    const all = [oddsOver, oddsUnder].filter(o => isFinite(o) && o > 1);
    const or  = all.reduce((s,o) => s+1/o, 0);
    return {
      over:      this.impliedProbabilityNoVig(oddsOver,  all),
      under:     this.impliedProbabilityNoVig(oddsUnder, all),
      overround: parseFloat(or.toFixed(4)),
    };
  }
}
