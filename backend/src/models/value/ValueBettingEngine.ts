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
import { predictionEngineConfig, PredictionEngineConfig, ComboRiskMode } from '../../config/PredictionEngineConfig';

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
  /** Effective risk mode used; covarianceMonteCarlo currently means deterministic covariance proxy. */
  comboRiskMode?: ComboRiskMode;
  /** Return variance proxy, populated only when covariance correlations are configured. */
  returnVariance?: number;
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
  modelProbability?: number;
  calibratedProbability?: number;
  blendedProbability?: number;
  marketProbabilityNoVig?: number;
  modelWeight?: number;
  marketWeight?: number;
  categoryCalibrationStatus?: 'none' | 'applied' | 'global_fallback' | 'insufficient_sample';
  calibrationSampleSize?: number;
  calibrationReliability?: number;
  mainReason?: string;
  riskReasons?: string[];
  dataQuality?: number;
  companionOddsAvailable?: boolean;
  uncertaintyFactor?: number;
  riskPenalty?: number;
  rankingScore?: number;
  logGrowth?: number;
  dynamicEvThreshold?: number;
  contextStrength?: number;
  playerId?: string;
  playerName?: string;
  teamName?: string;
  marketType?: 'player_shots' | 'player_shots_ot' | 'player_yellow_cards';
  line?: number;
  expectedMinutes?: number;
  sampleSize?: number;
  playerConfidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  dataWarnings?: string[];
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
  | 'player_shots'   // tiri singolo calciatore
  | 'player_shots_ot' // tiri in porta singolo calciatore
  | 'player_yellow_cards' // giallo singolo calciatore
  | 'fouls'          // falli
  | 'exact_score'    // risultato esatto
  | 'handicap'       // handicap europeo e asiatico
  | 'other';

export type MarketTier = 'CORE' | 'SECONDARY' | 'SPECULATIVE';
export type SelectionFamily = string;

export interface ValueAnalysisFactors {
  homeAdvantageIndex?: number;
  formDelta?: number;
  motivationDelta?: number;
  restDelta?: number;
  scheduleLoadDelta?: number;
  suspensionsDelta?: number;
  disciplinaryDelta?: number;
  atRiskPlayersDelta?: number;
  competitiveness?: number;
  statSampleStrength?: number;
  shotsReliability?: number;
  cornersReliability?: number;
  disciplineReliability?: number;
  expectedCards?: number;
  expectedFouls?: number;
  refereeAvgYellow?: number;
  refereeAvgFouls?: number;
  refereeSampleSize?: number;
  leagueAvgYellow?: number;
  leagueAvgFouls?: number;
  disciplinaryRiskScore?: number;
  isDerby?: boolean;
  highStakes?: boolean;
}

export interface MarketCalibrationEntry {
  predictedAvg: number;
  actualHitRate: number;
  sampleSize: number;
  reliability: number;
  calibrationGap?: number;
}

export interface MarketCalibrationProfile {
  global?: MarketCalibrationEntry;
  byMarket?: Record<string, MarketCalibrationEntry>;
  byCompetition?: Record<string, {
    global?: MarketCalibrationEntry;
    byMarket?: Record<string, MarketCalibrationEntry>;
  }>;
}

export interface ValueAnalysisContext {
  richnessScore?: number;
  competition?: string;
  teamSampleSize?: { home?: number; away?: number };
  hasXg?: boolean;
  hasPlayerData?: boolean;
  hasRefereeData?: boolean;
  marketVariance?: Partial<Record<MarketCategory, number>>;
  marketCalibrationProfile?: MarketCalibrationProfile;
  enableMarketCalibration?: boolean;
  enableMarketBlending?: boolean;
  analysisFactors?: ValueAnalysisFactors;
  expectedCards?: number;
  expectedCardsByLine?: Record<string, number>;
  expectedFouls?: number;
  refereeAvgYellow?: number;
  refereeAvgFouls?: number;
  refereeSampleSize?: number;
  leagueAvgYellow?: number;
  leagueAvgFouls?: number;
  disciplinaryRiskScore?: number;
  isDerby?: boolean;
  highStakes?: boolean;
}

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

type ValueBettingRuntimeConfig = Partial<PredictionEngineConfig['valueBetting']> & {
  /** Legacy name: current behavior is deterministic covariance proxy scaling, not random Monte Carlo simulation. */
  comboRiskMode?: ComboRiskMode;
  comboCorrelationMatrix?: Record<string, number>;
  rankingWeights?: RankingWeightsConfig;
};

export interface RankingWeightVector {
  edgeNoVig: number;
  edgeRaw: number;
  ev: number;
  kelly: number;
  confidence: number;
  logGrowth: number;
  riskPenalty: number;
  uncertainty: number;
  contextStrength: number;
}

export interface RankingWeightsConfig {
  global?: Partial<RankingWeightVector>;
  byCategory?: Partial<Record<MarketCategory, Partial<RankingWeightVector>>>;
  bySelectionFamily?: Record<string, Partial<RankingWeightVector>>;
  byCompetition?: Record<string, {
    global?: Partial<RankingWeightVector>;
    byCategory?: Partial<Record<MarketCategory, Partial<RankingWeightVector>>>;
    bySelectionFamily?: Record<string, Partial<RankingWeightVector>>;
  }>;
}

type UnderCardsGuard = {
  isUnderCards: boolean;
  line: number | null;
  expectedCards: number | null;
  distanceToLine: number | null;
  disciplinaryRiskScore: number;
  warnings: string[];
  reject: boolean;
  minEdgeNoVig: number;
  evThresholdBump: number;
  uncertaintyBump: number;
  riskPenaltyBump: number;
  stakeMultiplier: number;
  maxConfidence?: 'MEDIUM' | 'LOW';
};

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
  shots:       0.040,   // 4.0%
  shots_ot:    0.040,   // 4.0%
  corners:     0.120,   // disattivato nel flusso attivo (Understat-only)
  yellow_cards: 0.045,  // 4.5%
  player_shots: 0.060,
  player_shots_ot: 0.070,
  player_yellow_cards: 0.075,
  fouls:       0.120,   // disattivato nel flusso attivo (Understat-only)
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
  player_shots: 0.035,
  player_shots_ot: 0.040,
  player_yellow_cards: 0.045,
  fouls:       0.03,
  shots_ot:    0.03,
  handicap:    0.02,
  exact_score: 0.05,
  other:       0.04,
};

const DEFAULT_RANKING_WEIGHTS: RankingWeightVector = {
  edgeNoVig: 0.35,
  edgeRaw: 0.04,
  ev: 0.18,
  kelly: 0.16,
  confidence: 0.07,
  logGrowth: 0.11,
  riskPenalty: 0.35,
  uncertainty: 0.09,
  contextStrength: 0.06,
};

const DEFAULT_CATEGORY_RANKING_WEIGHTS: Partial<Record<MarketCategory, Partial<RankingWeightVector>>> = {
  goal_1x2: {
    edgeNoVig: 0.38,
    ev: 0.16,
    logGrowth: 0.12,
    riskPenalty: 0.32,
  },
  goal_ou: {
    edgeNoVig: 0.42,
    ev: 0.14,
    logGrowth: 0.16,
    riskPenalty: 0.3,
  },
  shots: {
    edgeNoVig: 0.34,
    ev: 0.16,
    confidence: 0.09,
    riskPenalty: 0.42,
    uncertainty: 0.16,
    contextStrength: 0.1,
  },
  shots_ot: {
    edgeNoVig: 0.34,
    ev: 0.15,
    confidence: 0.09,
    riskPenalty: 0.45,
    uncertainty: 0.18,
    contextStrength: 0.1,
  },
  yellow_cards: {
    edgeNoVig: 0.32,
    ev: 0.13,
    riskPenalty: 0.55,
    uncertainty: 0.28,
    contextStrength: 0.08,
  },
  player_shots: {
    edgeNoVig: 0.36,
    ev: 0.14,
    confidence: 0.08,
    logGrowth: 0.12,
    riskPenalty: 0.52,
    uncertainty: 0.24,
    contextStrength: 0.08,
  },
  player_shots_ot: {
    edgeNoVig: 0.36,
    ev: 0.12,
    confidence: 0.07,
    logGrowth: 0.11,
    riskPenalty: 0.62,
    uncertainty: 0.30,
    contextStrength: 0.06,
  },
  player_yellow_cards: {
    edgeNoVig: 0.34,
    ev: 0.11,
    confidence: 0.06,
    logGrowth: 0.10,
    riskPenalty: 0.70,
    uncertainty: 0.34,
    contextStrength: 0.06,
  },
  handicap: {
    edgeNoVig: 0.3,
    ev: 0.1,
    logGrowth: 0.1,
    riskPenalty: 0.7,
    uncertainty: 0.32,
  },
  exact_score: {
    edgeNoVig: 0.28,
    ev: 0.08,
    kelly: 0.1,
    logGrowth: 0.08,
    riskPenalty: 0.85,
    uncertainty: 0.38,
  },
};

export class ValueBettingEngine {
  private readonly runtimeConfig: ValueBettingRuntimeConfig;
  // Filtri globali (valgono per tutte le categorie)
  private readonly MIN_ODDS         = 1.40;   // margine bookmaker troppo alto sotto
  private readonly MAX_ODDS         = 8.00;   // modello inaffidabile oltre
  private readonly KELLY_FRACTION   = 0.25;   // Quarter Kelly (conservativo)
  private readonly MAX_STAKE_PERCENT = 4.0;   // cap assoluto % bankroll
  private readonly MIN_STAKE_PERCENT = 0.25;  // stake minimo (non vale la pena sotto)
  private readonly COHERENCE_RATIO  = 0.65;   // nostra prob >= 65% implied_raw
  // Mercati disattivati per policy prodotto (AGENTS.md).
  private readonly DISABLED_CATEGORIES: ReadonlySet<MarketCategory> = new Set(['corners', 'fouls']);

  private readonly CONFIDENCE_MULTIPLIERS = {
    HIGH:   1.20,
    MEDIUM: 1.00,
    LOW:    0.70,   // accettata ma con stake ridotto
  };
  private adaptiveTuningProfile: AdaptiveEngineTuningProfile | null = null;

  constructor(config: ValueBettingRuntimeConfig = {}) {
    this.runtimeConfig = {
      ...predictionEngineConfig.valueBetting,
      ...config,
      comboRiskMode: config.comboRiskMode ?? predictionEngineConfig.comboBetting.comboRiskMode,
      comboCorrelationMatrix: config.comboCorrelationMatrix ?? {},
      operational: {
        ...predictionEngineConfig.valueBetting.operational,
        ...(config.operational ?? {}),
      },
    };
  }

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

  setRankingWeights(config: RankingWeightsConfig | null | undefined): void {
    this.runtimeConfig.rankingWeights = config ?? undefined;
  }

  getRankingWeightsConfig(): RankingWeightsConfig {
    return {
      global: { ...(this.runtimeConfig.rankingWeights?.global ?? {}) },
      byCategory: { ...(this.runtimeConfig.rankingWeights?.byCategory ?? {}) },
      bySelectionFamily: { ...(this.runtimeConfig.rankingWeights?.bySelectionFamily ?? {}) },
      byCompetition: { ...(this.runtimeConfig.rankingWeights?.byCompetition ?? {}) },
    };
  }

  private normalizeCompetitionKey(competition?: string | null): string {
    return String(competition ?? '').trim().toLowerCase();
  }

  getRankingWeightsForCategory(
    category: MarketCategory,
    scope: { competition?: string | null; selectionFamily?: string | null } = {}
  ): RankingWeightVector {
    const competitionConfig = this.runtimeConfig.rankingWeights?.byCompetition?.[this.normalizeCompetitionKey(scope.competition)];
    const selectionFamily = String(scope.selectionFamily ?? '').trim();
    return {
      ...DEFAULT_RANKING_WEIGHTS,
      ...(DEFAULT_CATEGORY_RANKING_WEIGHTS[category] ?? {}),
      ...(this.runtimeConfig.rankingWeights?.global ?? {}),
      ...(this.runtimeConfig.rankingWeights?.byCategory?.[category] ?? {}),
      ...(selectionFamily ? this.runtimeConfig.rankingWeights?.bySelectionFamily?.[selectionFamily] ?? {} : {}),
      ...(competitionConfig?.global ?? {}),
      ...(competitionConfig?.byCategory?.[category] ?? {}),
      ...(selectionFamily ? competitionConfig?.bySelectionFamily?.[selectionFamily] ?? {} : {}),
    };
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

  private getClampedEvDelta(category: MarketCategory, selection?: string): number {
    const tuning = selection ? this.getCombinedTuning(category, selection) : this.getCategoryTuning(category);
    return this.clampNumber(Number(tuning.evDelta ?? 0), -0.012, 0.008);
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
      category === 'yellow_cards' ||
      category === 'player_shots' ||
      category === 'player_shots_ot' ||
      category === 'player_yellow_cards';

    const tuning = selection ? this.getCombinedTuning(category, selection) : this.getCategoryTuning(category);
    const baseCoherence = isShotsDisciplineCore ? 0.55 : this.COHERENCE_RATIO;
    const operationalMaxOdds = this.runtimeConfig.operational?.maxOdds ?? this.MAX_ODDS;
    const applyMaxOddsToAllMarkets = this.runtimeConfig.operational?.applyMaxOddsToAllMarkets ?? true;
    return {
      minOdds: isShotsDisciplineCore ? 1.20 : this.MIN_ODDS,
      maxOdds: category === 'player_shots' || category === 'player_shots_ot' || category === 'player_yellow_cards'
        ? Math.min(operationalMaxOdds, 7.5)
        : applyMaxOddsToAllMarkets ? operationalMaxOdds : (isShotsDisciplineCore ? 15.00 : operationalMaxOdds),
      coherenceRatio: this.clampNumber(baseCoherence + tuning.coherenceDelta, 0.45, 0.85),
    };
  }

  getMarketTier(category: MarketCategory): MarketTier {
    if (category === 'goal_1x2' || category === 'goal_ou') return 'CORE';
    if (category === 'shots' || category === 'shots_ot' || category === 'corners' || category === 'yellow_cards' || category === 'fouls' || category === 'player_shots')
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
    if (/^player_.+_shots_(over|under)_/.test(s)) return s.includes('_under_') ? 'player_shots_under' : 'player_shots_over';
    if (/^player_.+_sot_(over|under)_/.test(s)) return s.includes('_under_') ? 'player_shots_ot_under' : 'player_shots_ot_over';
    if (/^player_.+_yellow_(over|under)_/.test(s)) return s.includes('_under_') ? 'player_yellow_under' : 'player_yellow_over';
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

    // Player props bookmaker normalizzate: player_{playerId}_{market}_{side}_{line}
    if (/^player_.+_shots_(over|under)_/.test(s)) return 'player_shots';
    if (/^player_.+_sot_(over|under)_/.test(s)) return 'player_shots_ot';
    if (/^player_.+_yellow_(over|under)_/.test(s)) return 'player_yellow_cards';

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
    const evDelta = this.getClampedEvDelta(category, selection);
    if (!isFinite(Number(margin))) return this.clampNumber(EV_THRESHOLDS[category] + evDelta, 0.001, 0.12);
    const buffer = EV_MARGIN_BUFFERS[category] ?? 0.03;
    return this.clampNumber(Math.max(0, Number(margin) + buffer) + evDelta, 0.001, 0.12);
  }

  getEffectiveEvThreshold(category: MarketCategory, margin?: number, selection?: string): number {
    return this.minEvForCategory(category, margin, selection);
  }

  computeDynamicEvThreshold(
    category: MarketCategory,
    context: {
      richnessScore?: number;
      marketVariance?: number;
      calibrationPenalty?: number;
      baseThreshold?: number;
    } = {}
  ): number {
    const baseThreshold = context.baseThreshold ?? EV_THRESHOLDS[category] ?? EV_THRESHOLDS.other;
    if (!(this.runtimeConfig.dynamicEvThresholdEnabled ?? false)) return baseThreshold;

    const richnessScore = this.clampNumber(context.richnessScore ?? 1, 0, 1);
    const richnessMultiplier = 1 + (1 - richnessScore) * 1.2;
    const varianceMultiplier = this.clampNumber(context.marketVariance ?? 1, 0.75, 2.5);
    const calibrationPenalty = this.clampNumber(context.calibrationPenalty ?? 1, 1, 2.5);
    return Number((baseThreshold * richnessMultiplier * varianceMultiplier * calibrationPenalty).toFixed(6));
  }

  private computeContextualEvThreshold(
    category: MarketCategory,
    baseThreshold: number,
    odds: number,
    context: ValueAnalysisContext = {},
    uncertaintyFactor = 0,
    contextStrength = 0
  ): number {
    const richness = this.clampNumber(context.richnessScore ?? 0.65, 0, 1);
    const marketVariance = this.clampNumber(
      context.marketVariance?.[category] ?? this.getDefaultMarketVariance(category),
      0.75,
      2.5
    );

    let threshold = baseThreshold;
    threshold += (1 - richness) * 0.04;
    threshold += Math.max(0, marketVariance - 1) * 0.015;
    threshold += uncertaintyFactor * 0.018;

    if (odds > this.MAX_ODDS) {
      threshold += 0.035;
      if (contextStrength >= 0.7) threshold -= 0.02;
    } else if (odds >= 5) {
      threshold += 0.012;
      if (contextStrength >= 0.7) threshold -= 0.006;
    }

    if (category === 'goal_1x2' || category === 'goal_ou') threshold -= 0.004;
    if (category === 'player_shots') threshold += 0.010;
    if (category === 'player_shots_ot') threshold += 0.016;
    if (category === 'player_yellow_cards') threshold += 0.020;
    if (category === 'exact_score' || category === 'handicap') threshold += 0.015;
    if (category === 'yellow_cards') threshold += 0.008;

    return this.clampNumber(Number(threshold.toFixed(6)), 0.015, 0.16);
  }

  private getDefaultMarketVariance(category: MarketCategory): number {
    if (category === 'goal_1x2' || category === 'goal_ou') return 0.85;
    if (category === 'shots' || category === 'shots_ot') return 1.05;
    if (category === 'yellow_cards') return 1.22;
    if (category === 'player_shots') return 1.30;
    if (category === 'player_shots_ot') return 1.45;
    if (category === 'player_yellow_cards') return 1.55;
    if (category === 'exact_score' || category === 'handicap') return 1.55;
    return 1.15;
  }

  private inferSelectionDirection(selection: string): number {
    const key = String(selection ?? '').toLowerCase();
    if (
      key === 'homewin' ||
      key === 'dnb_home' ||
      key === 'double_chance_1x' ||
      key.startsWith('hcp_home') ||
      key.startsWith('team_home_') ||
      key.startsWith('ahcp_home')
    ) return 1;
    if (
      key === 'awaywin' ||
      key === 'dnb_away' ||
      key === 'double_chance_x2' ||
      key.startsWith('hcp_away') ||
      key.startsWith('team_away_') ||
      key.startsWith('ahcp_away')
    ) return -1;
    return 0;
  }

  private computeContextStrength(selection: string, category: MarketCategory, context: ValueAnalysisContext = {}): number {
    const factors = context.analysisFactors;
    if (!factors) return 0.35;

    const direction = this.inferSelectionDirection(selection);
    const signedSignal =
      Number(factors.homeAdvantageIndex ?? 0) * 0.8 +
      Number(factors.formDelta ?? 0) * 0.7 +
      Number(factors.motivationDelta ?? 0) * 0.9 +
      Number(factors.restDelta ?? 0) * 0.5 +
      Number(factors.scheduleLoadDelta ?? 0) * 0.35 +
      Number(factors.suspensionsDelta ?? 0) * 0.45 +
      Number(factors.disciplinaryDelta ?? 0) * 0.2 +
      Number(factors.atRiskPlayersDelta ?? 0) * 0.25;

    let score = 0.18 + this.clampNumber(Number(factors.competitiveness ?? 0.5), 0, 1) * 0.16;
    if (direction !== 0) {
      score += this.clampNumber(direction * signedSignal, -0.6, 1.4) / 1.5;
    }

    const key = String(selection ?? '').toLowerCase();
    if (key.startsWith('over') || key.includes('_over_')) {
      score += Math.max(0, Number(factors.formDelta ?? 0)) * 0.22;
      score += Math.max(0, Number(factors.motivationDelta ?? 0)) * 0.18;
    } else if (key.startsWith('under') || key.includes('_under_')) {
      score += Math.max(0, -Number(factors.formDelta ?? 0)) * 0.18;
    }

    if (category === 'shots' || category === 'shots_ot' || category === 'player_shots' || category === 'player_shots_ot') {
      score += this.clampNumber(Number(factors.shotsReliability ?? 0), 0, 1) * 0.12;
    } else if (category === 'yellow_cards' || category === 'player_yellow_cards') {
      score += this.clampNumber(Number(factors.disciplineReliability ?? 0), 0, 1) * 0.1;
    }

    return this.clampNumber(score, 0, 1);
  }

  private computeUncertaintyFactor(category: MarketCategory, odds: number, context: ValueAnalysisContext = {}): number {
    const richness = this.clampNumber(context.richnessScore ?? 0.6, 0, 1);
    const homeSample = Number(context.teamSampleSize?.home ?? 18);
    const awaySample = Number(context.teamSampleSize?.away ?? 18);
    const sampleStrength = this.clampNumber(((homeSample + awaySample) / 2) / 30, 0, 1);

    let dataQuality =
      richness * 0.45 +
      sampleStrength * 0.2 +
      (context.hasXg === false ? 0 : 0.12) +
      (context.hasPlayerData === false ? 0 : 0.08) +
      (context.hasRefereeData === false ? 0 : 0.05);

    const factors = context.analysisFactors;
    if (category === 'shots' || category === 'shots_ot' || category === 'player_shots' || category === 'player_shots_ot') {
      dataQuality += this.clampNumber(Number(factors?.shotsReliability ?? factors?.statSampleStrength ?? 0.5), 0, 1) * 0.1;
    } else if (category === 'yellow_cards' || category === 'player_yellow_cards') {
      dataQuality += this.clampNumber(Number(factors?.disciplineReliability ?? 0.45), 0, 1) * 0.08;
    } else {
      dataQuality += 0.08;
    }

    let uncertainty = 1 - this.clampNumber(dataQuality, 0, 1);
    if (category === 'shots' || category === 'shots_ot') uncertainty += 0.06;
    if (category === 'yellow_cards') uncertainty += 0.12;
    if (category === 'player_shots') uncertainty += 0.16;
    if (category === 'player_shots_ot') uncertainty += 0.22;
    if (category === 'player_yellow_cards') uncertainty += 0.25;
    if (category === 'exact_score' || category === 'handicap') uncertainty += 0.18;
    if (odds > this.MAX_ODDS) uncertainty += 0.12;
    else if (odds >= 5) uncertainty += 0.06;

    return this.clampNumber(Number(uncertainty.toFixed(3)), 0.04, 0.85);
  }

  private computeRiskPenalty(
    category: MarketCategory,
    odds: number,
    uncertaintyFactor: number,
    contextStrength: number
  ): number {
    let penalty = uncertaintyFactor * 0.35;
    if (odds > this.MAX_ODDS) penalty += 0.22;
    else if (odds >= 5) penalty += 0.1;
    if (category === 'exact_score' || category === 'handicap') penalty += 0.12;
    if (category === 'yellow_cards') penalty += 0.06;
    if (category === 'player_shots') penalty += 0.10;
    if (category === 'player_shots_ot') penalty += 0.15;
    if (category === 'player_yellow_cards') penalty += 0.18;
    penalty -= Math.max(0, contextStrength - 0.7) * 0.12;
    return this.clampNumber(Number(penalty.toFixed(3)), 0, 0.65);
  }

  getMarketCalibrationKey(selection: string, category: MarketCategory = this.categorizeSelection(selection)): string {
    const key = String(selection ?? '').toLowerCase();
    if (category === 'yellow_cards') {
      if (key.includes('_under_') || /^yellowunder\d+$/i.test(key) || /^cardstotalunder\d+$/i.test(key)) return 'yellow_cards_under';
      if (key.includes('_over_') || /^yellowover\d+$/i.test(key) || /^cardstotalover\d+$/i.test(key)) return 'yellow_cards_over';
    }
    return category;
  }

  private applyMarketCalibration(
    rawProbability: number,
    selection: string,
    category: MarketCategory,
    context: ValueAnalysisContext = {}
  ): {
    probability: number;
    status: 'none' | 'applied' | 'global_fallback' | 'insufficient_sample';
    sampleSize: number;
    reliability: number;
    calibrationGap: number;
  } {
    const profile = context.marketCalibrationProfile;
    if (!profile || context.enableMarketCalibration === false) {
      return { probability: rawProbability, status: 'none', sampleSize: 0, reliability: 0, calibrationGap: 0 };
    }

    const competitionKey = this.normalizeCompetitionKey(context.competition);
    const competitionProfile = competitionKey ? profile.byCompetition?.[competitionKey] : undefined;
    const marketKey = this.getMarketCalibrationKey(selection, category);
    const categoryEntry =
      competitionProfile?.byMarket?.[marketKey]
      ?? profile.byMarket?.[marketKey]
      ?? competitionProfile?.byMarket?.[category]
      ?? profile.byMarket?.[category];
    const globalEntry = competitionProfile?.global ?? profile.global;
    const isReliable = (entry?: MarketCalibrationEntry) =>
      Boolean(entry && Number(entry.sampleSize) >= 30 && Number(entry.reliability) >= 0.35);

    let entry = categoryEntry;
    let status: 'none' | 'applied' | 'global_fallback' | 'insufficient_sample' = 'applied';
    if (!isReliable(entry)) {
      if (isReliable(globalEntry)) {
        entry = globalEntry;
        status = 'global_fallback';
      } else if (entry || globalEntry) {
        const weak = entry ?? globalEntry!;
        return {
          probability: rawProbability,
          status: 'insufficient_sample',
          sampleSize: Number(weak.sampleSize ?? 0),
          reliability: Number(weak.reliability ?? 0),
          calibrationGap: Number(weak.calibrationGap ?? Number(weak.actualHitRate ?? 0) - Number(weak.predictedAvg ?? 0)),
        };
      } else {
        return { probability: rawProbability, status: 'none', sampleSize: 0, reliability: 0, calibrationGap: 0 };
      }
    }

    const sampleSize = Math.max(0, Number(entry?.sampleSize ?? 0));
    const reliability = this.clampNumber(Number(entry?.reliability ?? 0), 0, 1);
    const predictedAvg = this.clampNumber(Number(entry?.predictedAvg ?? rawProbability), 0.001, 0.999);
    const actualHitRate = this.clampNumber(Number(entry?.actualHitRate ?? rawProbability), 0.001, 0.999);
    const calibrationGap = Number((actualHitRate - predictedAvg).toFixed(6));
    const sampleAlpha = this.clampNumber(sampleSize / 160, 0.08, 1);
    const correctionWeight = this.clampNumber(sampleAlpha * reliability * (status === 'global_fallback' ? 0.45 : 0.85), 0.04, 0.85);
    const corrected = this.clampNumber(rawProbability + calibrationGap * correctionWeight, 0.001, 0.999);

    return {
      probability: Number(corrected.toFixed(6)),
      status,
      sampleSize,
      reliability: Number(reliability.toFixed(3)),
      calibrationGap,
    };
  }

  private computeDataQualityScore(
    category: MarketCategory,
    context: ValueAnalysisContext,
    hasCompanionOdds: boolean,
    uncertaintyFactor: number
  ): number {
    const richness = this.clampNumber(context.richnessScore ?? 0.6, 0, 1);
    const sampleAvg = (Number(context.teamSampleSize?.home ?? 18) + Number(context.teamSampleSize?.away ?? 18)) / 2;
    let quality = richness * 0.48 + this.clampNumber(sampleAvg / 30, 0, 1) * 0.22 + (1 - uncertaintyFactor) * 0.18;
    if (context.hasXg !== false) quality += 0.04;
    if (context.hasPlayerData !== false) quality += category.toString().startsWith('player_') ? 0.06 : 0.03;
    if (context.hasRefereeData !== false) quality += category === 'yellow_cards' || category === 'player_yellow_cards' ? 0.05 : 0.02;
    if (!hasCompanionOdds) quality -= 0.14;
    if (category === 'player_shots_ot' || category === 'player_yellow_cards') quality -= 0.08;
    if (category === 'exact_score' || category === 'handicap') quality -= 0.08;
    return this.clampNumber(Number(quality.toFixed(3)), 0, 1);
  }

  private blendWithMarketProbability(
    modelProbability: number,
    marketProbabilityNoVig: number,
    category: MarketCategory,
    context: ValueAnalysisContext,
    hasCompanionOdds: boolean,
    uncertaintyFactor: number
  ): {
    probability: number;
    modelWeight: number;
    marketWeight: number;
    dataQuality: number;
    applied: boolean;
  } {
    if (context.enableMarketBlending !== true || !Number.isFinite(marketProbabilityNoVig) || marketProbabilityNoVig <= 0 || marketProbabilityNoVig >= 1) {
      return { probability: modelProbability, modelWeight: 1, marketWeight: 0, dataQuality: 1 - uncertaintyFactor, applied: false };
    }

    const dataQuality = this.computeDataQualityScore(category, context, hasCompanionOdds, uncertaintyFactor);
    let modelWeight = 0.50 + dataQuality * 0.35;
    if (category === 'goal_1x2' || category === 'goal_ou') modelWeight += 0.04;
    if (category === 'player_shots_ot' || category === 'player_yellow_cards') modelWeight -= 0.10;
    if (!hasCompanionOdds) modelWeight -= 0.16;
    modelWeight = this.clampNumber(modelWeight, 0.40, 0.84);
    const marketWeight = 1 - modelWeight;
    const probability = this.clampNumber(modelProbability * modelWeight + marketProbabilityNoVig * marketWeight, 0.001, 0.999);
    return {
      probability: Number(probability.toFixed(6)),
      modelWeight: Number(modelWeight.toFixed(3)),
      marketWeight: Number(marketWeight.toFixed(3)),
      dataQuality,
      applied: true,
    };
  }

  private buildPickDiagnostics(input: {
    selection: string;
    category: MarketCategory;
    edgeNoVig: number;
    dataQuality: number;
    calibrationStatus: string;
    blendingApplied: boolean;
    hasCompanionOdds: boolean;
    warnings: string[];
  }): { mainReason: string; riskReasons: string[]; warnings: string[] } {
    const warnings = [...input.warnings];
    const riskReasons: string[] = [];
    if (input.edgeNoVig > 0.03) warnings.push('positive_edge_no_vig');
    if (input.dataQuality < 0.5) {
      warnings.push('data_quality_weak');
      riskReasons.push('Dati deboli');
    }
    if (input.blendingApplied) warnings.push('market_blending_applied');
    if (input.calibrationStatus === 'applied') warnings.push('market_calibration_applied');
    if (!input.hasCompanionOdds) riskReasons.push('Quote companion mancanti');
    if (input.category === 'yellow_cards' && this.isUnderCardsSelection(input.selection)) riskReasons.push('Mercato fragile');
    const mainReason =
      input.edgeNoVig > 0.03
        ? 'Edge no-vig positivo'
        : input.blendingApplied
          ? 'Probabilita corretta dal mercato'
          : 'Quota superiore alla probabilita stimata';
    return {
      mainReason,
      riskReasons: Array.from(new Set(riskReasons)),
      warnings: Array.from(new Set(warnings)),
    };
  }

  private computeExpectedLogGrowth(probability: number, decimalOdds: number, stakePercent: number): number {
    const p = this.clampNumber(probability, 0.000001, 0.999999);
    const stake = this.clampNumber(stakePercent / 100, 0, 0.99);
    if (stake <= 0 || decimalOdds <= 1) return 0;
    const winGrowth = 1 + stake * (decimalOdds - 1);
    const lossGrowth = 1 - stake;
    return p * Math.log(winGrowth) + (1 - p) * Math.log(lossGrowth);
  }

  private computeRankingScore(input: {
    ev: number;
    edgeRaw: number;
    edgeNoVig: number;
    kelly: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    odds: number;
    category: MarketCategory;
    uncertaintyFactor: number;
    riskPenalty: number;
    contextStrength: number;
    logGrowth: number;
    adaptiveRankMultiplier: number;
    selectionFamily?: string;
    competition?: string;
  }): number {
    const confidenceScore = input.confidence === 'HIGH' ? 1 : input.confidence === 'MEDIUM' ? 0.68 : 0.38;
    const edgeNoVigScore = this.clampNumber(input.edgeNoVig / 0.1, -1, 2);
    const rawEdgeScore = this.clampNumber(input.edgeRaw / 0.1, -1, 2);
    const evScore = this.clampNumber(input.ev / 0.2, -1, 2);
    const kellyScore = this.clampNumber(input.kelly / 0.04, 0, 1.5);
    const reliabilityScore = 1 - input.uncertaintyFactor;
    const logGrowthScore = this.clampNumber((input.logGrowth + 0.01) / 0.04, 0, 1.5);
    const highOddsDrag = input.odds > this.MAX_ODDS ? (input.odds - this.MAX_ODDS) * 0.08 : 0;
    const weights = this.getRankingWeightsForCategory(input.category, {
      competition: input.competition,
      selectionFamily: input.selectionFamily,
    });

    // Edge raw confronta la probabilita modello con la quota bookmaker grezza.
    // Edge no-vig confronta la stessa probabilita con la quota bookmaker pulita dal margine:
    // per il ranking finale pesa di piu perche misura meglio se stiamo battendo il mercato.
    const score =
      edgeNoVigScore * weights.edgeNoVig +
      rawEdgeScore * weights.edgeRaw +
      evScore * weights.ev +
      kellyScore * weights.kelly +
      confidenceScore * weights.confidence +
      reliabilityScore * weights.uncertainty +
      logGrowthScore * weights.logGrowth +
      input.contextStrength * weights.contextStrength -
      input.riskPenalty * weights.riskPenalty -
      input.uncertaintyFactor * weights.uncertainty -
      highOddsDrag;

    return Number((score * input.adaptiveRankMultiplier).toFixed(6));
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

  /**
   * Bayesian Kelly adattivo con penalità per incertezza del modello.
   *
   * PROBLEMA DEL KELLY STANDARD:
   * Kelly assume che P_model sia la probabilità vera. Ma P_model è una
   * stima con incertezza: un modello allenato su 8 partite home della
   * Juventus ha un'incertezza molto più alta di uno con 35 partite.
   * Kelly su un P_model incerto tende a sovracommettere, specialmente
   * sulle high-confidence bet dove i parametri sono meno stabili.
   *
   * SOLUZIONE — Kelly con penalità varianza:
   *   stake_bayesian = stake_kelly × (1 - uncertaintyPenalty × uncertaintyFactor)
   *
   * dove:
   *   uncertaintyFactor ∈ [0,1]: output di DixonColesModel.bootstrapLambdas()
   *     0 = parametri stabili (molte partite, λ ben determinato)
   *     1 = alta incertezza (poche partite, λ molto variabile)
   *
   *   uncertaintyPenalty ∈ [0,1]: quanto l'incertezza riduce lo stake.
   *     Default 0.5 → con uncertaintyFactor=1 lo stake è dimezzato.
   *     Questo è conservativo ma giustificato: con alta incertezza
   *     il Kelly pieno è quasi certamente troppo aggressivo.
   *
   * EFFETTO PRATICO su HIGH-confidence bet:
   *   Le bet HIGH hanno EV alto → Kelly suggerisce stake alto.
   *   Ma se l'EV alto viene da parametri incerti (poche partite),
   *   uncertaintyFactor è alto → stake ridotto automaticamente.
   *   Questo risolve il problema di sovraconfidenza su HIGH.
   *
   * @param uncertaintyFactor  Da DixonColesModel.bootstrapLambdas() (default 0 = no penalità)
   * @param uncertaintyPenalty Quanto ridurre lo stake al max (default 0.5 = -50%)
   */
  computeSuggestedStakeWithUncertainty(
    probability: number,
    decimalOdds: number,
    ev: number,
    uncertaintyFactor = 0,
    uncertaintyPenalty = 0.5
  ): { stakePercent: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; uncertaintyDiscount: number } {
    const kelly = this.kellyFraction(probability, decimalOdds) * 100;

    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    if      (ev >= 0.08 && kelly >= 1.5) confidence = 'HIGH';
    else if (ev >= 0.05 && kelly >= 0.8) confidence = 'MEDIUM';
    else                                  confidence = 'LOW';

    const rawStake = kelly * this.CONFIDENCE_MULTIPLIERS[confidence];
    const clampedStake = Math.max(
      this.MIN_STAKE_PERCENT,
      Math.min(this.MAX_STAKE_PERCENT, rawStake)
    );

    // Sconto per incertezza del modello
    const clampedUF = Math.max(0, Math.min(1, uncertaintyFactor));
    const uncertaintyDiscount = clampedUF * uncertaintyPenalty;
    const stakePercent = Math.max(
      this.MIN_STAKE_PERCENT,
      clampedStake * (1 - uncertaintyDiscount)
    );

    return {
      stakePercent:      parseFloat(stakePercent.toFixed(2)),
      confidence,
      uncertaintyDiscount: Number(uncertaintyDiscount.toFixed(3)),
    };
  }

  computeSuggestedStake(
    probability: number,
    decimalOdds: number,
    ev: number
  ): { stakePercent: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
    const { stakePercent, confidence } = this.computeSuggestedStakeWithUncertainty(
      probability, decimalOdds, ev, 0, 0.5
    );
    return { stakePercent, confidence };
  }

  private isPlayerPropCategory(category: MarketCategory): boolean {
    return category === 'player_shots' || category === 'player_shots_ot' || category === 'player_yellow_cards';
  }

  private getStakeCapForCategory(category: MarketCategory): number {
    if (category === 'player_shots') return 1.5;
    if (category === 'player_shots_ot' || category === 'player_yellow_cards') return 1.0;
    return this.MAX_STAKE_PERCENT;
  }

  private isUnderCardsSelection(selection: string): boolean {
    const s = String(selection ?? '').toLowerCase();
    return /^yellow_under_/.test(s)
      || /^cards_total_under_/.test(s)
      || /^yellowunder\d+$/i.test(s)
      || /^cardstotalunder\d+$/i.test(s);
  }

  private parseCardsLine(selection: string): number | null {
    const s = String(selection ?? '').toLowerCase();
    const snake = s.match(/^(yellow|cards_total)_under_([0-9]+(?:[.,][0-9]+)?)$/i);
    if (snake) {
      const parsed = Number(snake[2].replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    }

    const compact = s.match(/^(yellow|cardstotal)under(\d+)$/i);
    if (!compact) return null;
    const raw = compact[2];
    const parsed = raw.length >= 2 ? Number(raw) / 10 : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private expectedCardsForLine(line: number | null, context: ValueAnalysisContext): number | null {
    if (line !== null) {
      const byLine = context.expectedCardsByLine ?? {};
      const keys = [
        String(line),
        line.toFixed(1),
        line.toFixed(2),
      ];
      for (const key of keys) {
        const value = Number(byLine[key]);
        if (Number.isFinite(value)) return value;
      }
    }

    const direct = Number(context.expectedCards ?? context.analysisFactors?.expectedCards);
    return Number.isFinite(direct) ? direct : null;
  }

  private requiredUnderCardsBuffer(line: number | null): number {
    if (line === null) return 0.8;
    if (line <= 4.5) return 0.7;
    if (line <= 5.5) return 0.9;
    return 1.0;
  }

  private computeDisciplinaryRiskScore(context: ValueAnalysisContext = {}): number {
    if (Number.isFinite(Number(context.disciplinaryRiskScore))) {
      return this.clampNumber(Number(context.disciplinaryRiskScore), 0, 1);
    }

    const factors = context.analysisFactors ?? {};
    if (Number.isFinite(Number(factors.disciplinaryRiskScore))) {
      return this.clampNumber(Number(factors.disciplinaryRiskScore), 0, 1);
    }

    const leagueYellow = Math.max(0.1, Number(context.leagueAvgYellow ?? factors.leagueAvgYellow ?? 3.8));
    const leagueFouls = Math.max(1, Number(context.leagueAvgFouls ?? factors.leagueAvgFouls ?? 22.4));
    const refereeYellow = Number(context.refereeAvgYellow ?? factors.refereeAvgYellow);
    const refereeFouls = Number(context.refereeAvgFouls ?? factors.refereeAvgFouls);
    const expectedFouls = Number(context.expectedFouls ?? factors.expectedFouls);

    const refereeYellowRisk = Number.isFinite(refereeYellow)
      ? this.clampNumber((refereeYellow / leagueYellow - 0.9) / 0.55, 0, 1) * 0.22
      : 0.08;
    const refereeFoulsRisk = Number.isFinite(refereeFouls)
      ? this.clampNumber((refereeFouls / leagueFouls - 0.9) / 0.55, 0, 1) * 0.16
      : 0.05;
    const expectedFoulsRisk = Number.isFinite(expectedFouls)
      ? this.clampNumber((expectedFouls / leagueFouls - 0.92) / 0.45, 0, 1) * 0.14
      : 0;
    const contextRisk =
      this.clampNumber(Number(factors.competitiveness ?? 0.5), 0, 1) * 0.18 +
      Math.abs(this.clampNumber(Number(factors.disciplinaryDelta ?? 0), -1, 1)) * 0.12 +
      Math.abs(this.clampNumber(Number(factors.atRiskPlayersDelta ?? 0), -1, 1)) * 0.10 +
      Math.abs(this.clampNumber(Number(factors.scheduleLoadDelta ?? 0), -1, 1)) * 0.08 +
      Math.abs(this.clampNumber(Number(factors.motivationDelta ?? 0), -1, 1)) * 0.05 +
      (context.isDerby || factors.isDerby ? 0.08 : 0) +
      (context.highStakes || factors.highStakes ? 0.07 : 0);

    return this.clampNumber(
      Number((refereeYellowRisk + refereeFoulsRisk + expectedFoulsRisk + contextRisk).toFixed(3)),
      0,
      1
    );
  }

  private computeUnderCardsGuard(selection: string, category: MarketCategory, context: ValueAnalysisContext = {}): UnderCardsGuard {
    const isUnderCards = category === 'yellow_cards' && this.isUnderCardsSelection(selection);
    if (!isUnderCards) {
      return {
        isUnderCards: false,
        line: null,
        expectedCards: null,
        distanceToLine: null,
        disciplinaryRiskScore: 0,
        warnings: [],
        reject: false,
        minEdgeNoVig: 0,
        evThresholdBump: 0,
        uncertaintyBump: 0,
        riskPenaltyBump: 0,
        stakeMultiplier: 1,
      };
    }

    const warnings: string[] = [];
    const factors = context.analysisFactors ?? {};
    const line = this.parseCardsLine(selection);
    const expectedCards = this.expectedCardsForLine(line, context);
    const distanceToLine = line !== null && expectedCards !== null ? line - expectedCards : null;
    const requiredBuffer = this.requiredUnderCardsBuffer(line);
    const disciplinaryRiskScore = this.computeDisciplinaryRiskScore(context);
    const refereeSample = Number(context.refereeSampleSize ?? factors.refereeSampleSize);
    const leagueYellow = Math.max(0.1, Number(context.leagueAvgYellow ?? factors.leagueAvgYellow ?? 3.8));
    const leagueFouls = Math.max(1, Number(context.leagueAvgFouls ?? factors.leagueAvgFouls ?? 22.4));
    const refereeYellow = Number(context.refereeAvgYellow ?? factors.refereeAvgYellow);
    const refereeFouls = Number(context.refereeAvgFouls ?? factors.refereeAvgFouls);
    const strictReferee =
      (Number.isFinite(refereeYellow) && refereeYellow > leagueYellow * 1.12)
      || (Number.isFinite(refereeFouls) && refereeFouls > leagueFouls * 1.12);
    const highIntensity =
      disciplinaryRiskScore >= 0.72
      || this.clampNumber(Number(factors.competitiveness ?? 0), 0, 1) >= 0.78
      || Boolean(context.isDerby || factors.isDerby || context.highStakes || factors.highStakes);

    if (distanceToLine !== null && distanceToLine < requiredBuffer) warnings.push('under_cards_close_to_line');
    if (context.hasRefereeData === false) warnings.push('missing_referee_data');
    if (Number.isFinite(refereeSample) && refereeSample > 0 && refereeSample < 12) warnings.push('low_referee_sample');
    if (strictReferee) warnings.push('strict_referee_against_under_cards');
    if (highIntensity) warnings.push('high_intensity_match');

    const closePenalty = distanceToLine === null
      ? 0.006
      : Math.max(0, requiredBuffer - distanceToLine) * 0.04;
    const refereePenalty =
      (context.hasRefereeData === false ? 0.010 : 0)
      + (Number.isFinite(refereeSample) && refereeSample > 0 && refereeSample < 12 ? 0.006 : 0)
      + (strictReferee ? 0.012 : 0);
    const intensityPenalty = highIntensity ? 0.012 : 0;
    const reject =
      (distanceToLine !== null && distanceToLine < requiredBuffer)
      || (strictReferee && highIntensity && disciplinaryRiskScore >= 0.58);

    const maxConfidence =
      warnings.includes('missing_referee_data') || warnings.includes('under_cards_close_to_line')
        ? 'LOW'
        : warnings.length > 0
          ? 'MEDIUM'
          : undefined;

    return {
      isUnderCards,
      line,
      expectedCards,
      distanceToLine,
      disciplinaryRiskScore,
      warnings: Array.from(new Set(warnings)),
      reject,
      minEdgeNoVig: this.clampNumber(0.018 + disciplinaryRiskScore * 0.035 + (strictReferee ? 0.012 : 0), 0.018, 0.075),
      evThresholdBump: this.clampNumber(0.012 + disciplinaryRiskScore * 0.022 + closePenalty + refereePenalty + intensityPenalty, 0.012, 0.075),
      uncertaintyBump: this.clampNumber(0.04 + disciplinaryRiskScore * 0.14 + (warnings.length > 0 ? 0.04 : 0), 0.04, 0.24),
      riskPenaltyBump: this.clampNumber(0.06 + disciplinaryRiskScore * 0.20 + (strictReferee ? 0.06 : 0) + (highIntensity ? 0.05 : 0), 0.06, 0.32),
      stakeMultiplier: this.clampNumber(0.78 - disciplinaryRiskScore * 0.32 - (warnings.length > 0 ? 0.12 : 0), 0.35, 0.78),
      maxConfidence,
    };
  }

  private capConfidence(
    confidence: 'HIGH' | 'MEDIUM' | 'LOW',
    maxConfidence?: 'MEDIUM' | 'LOW'
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (maxConfidence === 'LOW') return 'LOW';
    if (maxConfidence === 'MEDIUM' && confidence === 'HIGH') return 'MEDIUM';
    return confidence;
  }

  private capConfidenceForMarket(
    confidence: 'HIGH' | 'MEDIUM' | 'LOW',
    category: MarketCategory,
    hasCompanionOdds: boolean,
  ): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (!this.isPlayerPropCategory(category)) return confidence;
    if (category === 'player_yellow_cards') return confidence === 'LOW' ? 'LOW' : 'MEDIUM';
    if (!hasCompanionOdds && confidence === 'HIGH') return 'MEDIUM';
    return confidence;
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
    minEv: number,
    contextStrength = 0,
    selection?: string
  ): boolean {
    if (this.DISABLED_CATEGORIES.has(category)) return false;

    const { minOdds, maxOdds, coherenceRatio } = this.getFilterSettings(category, selection);

    // 1. Range odds assoluto
    if (odds < minOdds) return false;
    const highOddsContextException =
      odds > maxOdds &&
      odds <= Math.max(maxOdds, 12) &&
      (category === 'goal_1x2' || category === 'goal_ou') &&
      contextStrength >= 0.68 &&
      ev >= minEv + 0.05 &&
      edgeNoVig >= 0.035;
    if (odds > maxOdds && !highOddsContextException) return false;

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
    marketNames: Record<string, string>,
    context: ValueAnalysisContext = {}
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
      const underCardsGuard = this.computeUnderCardsGuard(key, category, context);
      const implied    = this.impliedProbabilityFromOdds(odds);
      const ev         = this.computeExpectedValue(ourProb, odds);
      const edge       = ourProb - implied;
      const edgeNoVig  = edge; // senza companions, uguale all'edge raw
      const baseMinEv  = this.minEvForCategory(category, marginByCategory[category], key);
      const contextStrength = this.computeContextStrength(key, category, context);
      const uncertaintyFactor = this.clampNumber(
        this.computeUncertaintyFactor(category, odds, context) + underCardsGuard.uncertaintyBump,
        0.04,
        0.92
      );
      const minEv = this.computeContextualEvThreshold(
        category,
        baseMinEv,
        odds,
        context,
        uncertaintyFactor,
        contextStrength
      ) + underCardsGuard.evThresholdBump;

      if (underCardsGuard.reject) continue;
      if (edgeNoVig < underCardsGuard.minEdgeNoVig) continue;
      if (!this.passesFilters(ourProb, odds, ev, edgeNoVig, category, minEv, contextStrength, key)) continue;

      const stake = this.computeSuggestedStakeWithUncertainty(ourProb, odds, ev, uncertaintyFactor, 0.55);
      const stakeConfidence = this.capConfidence(
        this.capConfidenceForMarket(stake.confidence, category, false),
        underCardsGuard.maxConfidence
      );
      const riskPenalty = this.clampNumber(
        this.computeRiskPenalty(category, odds, uncertaintyFactor, contextStrength) + underCardsGuard.riskPenaltyBump,
        0,
        0.82
      );
      const kellyPercent = this.kellyFraction(ourProb, odds) * 100;
      const categoryStakeCap = this.getStakeCapForCategory(category);
      const stakePercent = Number(
        Math.max(
          this.MIN_STAKE_PERCENT,
          Math.min(categoryStakeCap, kellyPercent, stake.stakePercent * (1 - riskPenalty * 0.7) * underCardsGuard.stakeMultiplier)
        ).toFixed(2)
      );
      const logGrowth = this.computeExpectedLogGrowth(ourProb, odds, stakePercent);
      const rankingScore = this.computeRankingScore({
        ev,
        edgeRaw: edge,
        edgeNoVig,
        kelly: this.kellyFraction(ourProb, odds),
        confidence: stakeConfidence,
        odds,
        category,
        uncertaintyFactor,
        riskPenalty,
        contextStrength,
        logGrowth,
        adaptiveRankMultiplier,
      });

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
        confidence:              stakeConfidence,
        isValueBet:              true,
        edge:                    parseFloat((edge    * 100).toFixed(2)),
        edgeNoVig:               parseFloat((edgeNoVig * 100).toFixed(2)),
        uncertaintyFactor:       Number(uncertaintyFactor.toFixed(3)),
        riskPenalty:             Number(riskPenalty.toFixed(3)),
        rankingScore,
        logGrowth:               Number(logGrowth.toFixed(6)),
        dynamicEvThreshold:      Number((minEv * 100).toFixed(2)),
        contextStrength:         Number(contextStrength.toFixed(3)),
        dataWarnings:            underCardsGuard.warnings.length > 0 ? underCardsGuard.warnings : undefined,
        line:                    underCardsGuard.line ?? undefined,
      });
    }

    return opportunities.sort(
      (a, b) =>
        Number(b.rankingScore ?? b.expectedValue * (b.adaptiveRankMultiplier ?? 1)) -
        Number(a.rankingScore ?? a.expectedValue * (a.adaptiveRankMultiplier ?? 1))
    );
  }

  /**
   * Versione con vig removal completo: usa le quote di tutti gli outcome
   * dello stesso mercato per calcolare l'edge reale (più preciso).
   */
  analyzeMarketsWithVigRemoval(
    probabilities: Record<string, number>,
    marketGroups: Record<string, MarketOddsGroup>,
    marketNames: Record<string, string>,
    context: ValueAnalysisContext = {}
  ): BetOpportunity[] {
    const opportunities: BetOpportunity[] = [];
    const marginByCategory = this.computeCategoryMarginsFromGroups(marketGroups);

    for (const [key, ourProb] of Object.entries(probabilities)) {
      const group = marketGroups[key];
      if (!group || !ourProb || ourProb <= 0 || ourProb >= 1) continue;

      const { odds, companions } = group;
      const allOdds      = [odds, ...companions.filter(o => isFinite(o) && o > 1)];
      const impliedRaw   = this.impliedProbabilityFromOdds(odds);
      const impliedNoVig = allOdds.length >= 2 ? this.impliedProbabilityNoVig(odds, allOdds) : impliedRaw;
      const category     = this.categorizeSelection(key);
      const marketTier   = this.getMarketTier(category);
      const selectionFamily = this.getSelectionFamily(key);
      const adaptiveRankMultiplier = this.getCategoryRankingMultiplier(category, key);
      const underCardsGuard = this.computeUnderCardsGuard(key, category, context);
      const baseMinEv    = this.minEvForCategory(category, marginByCategory[category], key);
      const contextStrength = this.computeContextStrength(key, category, context);
      const uncertaintyFactor = this.clampNumber(
        this.computeUncertaintyFactor(category, odds, context) + underCardsGuard.uncertaintyBump,
        0.04,
        0.92
      );
      const calibration = this.applyMarketCalibration(Number(ourProb), key, category, context);
      const hasCompanionOdds = allOdds.length >= 2;
      const blended = this.blendWithMarketProbability(
        calibration.probability,
        impliedNoVig,
        category,
        context,
        hasCompanionOdds,
        uncertaintyFactor
      );
      const effectiveProb = blended.probability;
      const ev           = this.computeExpectedValue(effectiveProb, odds);
      const edgeRaw      = effectiveProb - impliedRaw;
      const edgeNoVig    = effectiveProb - impliedNoVig;
      const minEv        = this.computeContextualEvThreshold(
        category,
        baseMinEv,
        odds,
        context,
        uncertaintyFactor,
        contextStrength
      ) + underCardsGuard.evThresholdBump;

      if (underCardsGuard.reject) continue;
      if (edgeNoVig < underCardsGuard.minEdgeNoVig) continue;
      if (!this.passesFilters(effectiveProb, odds, ev, edgeNoVig, category, minEv, contextStrength, key)) continue;

      const stake = this.computeSuggestedStakeWithUncertainty(effectiveProb, odds, ev, uncertaintyFactor, 0.55);
      const stakeConfidence = this.capConfidence(
        this.capConfidenceForMarket(stake.confidence, category, hasCompanionOdds),
        underCardsGuard.maxConfidence
      );
      const riskPenalty = this.clampNumber(
        this.computeRiskPenalty(category, odds, uncertaintyFactor, contextStrength) + underCardsGuard.riskPenaltyBump,
        0,
        0.82
      );
      const kellyPercent = this.kellyFraction(effectiveProb, odds) * 100;
      const categoryStakeCap = this.getStakeCapForCategory(category);
      const stakePercent = Number(
        Math.max(
          this.MIN_STAKE_PERCENT,
          Math.min(categoryStakeCap, kellyPercent, stake.stakePercent * (1 - riskPenalty * 0.7) * underCardsGuard.stakeMultiplier)
        ).toFixed(2)
      );
      const logGrowth = this.computeExpectedLogGrowth(effectiveProb, odds, stakePercent);
      const rankingScore = this.computeRankingScore({
        ev,
        edgeRaw,
        edgeNoVig,
        kelly: this.kellyFraction(effectiveProb, odds),
        confidence: stakeConfidence,
        odds,
        category,
        uncertaintyFactor,
        riskPenalty,
        contextStrength,
        logGrowth,
        adaptiveRankMultiplier,
        selectionFamily,
        competition: context.competition,
      });
      const diagnostics = this.buildPickDiagnostics({
        selection: key,
        category,
        edgeNoVig,
        dataQuality: blended.dataQuality,
        calibrationStatus: calibration.status,
        blendingApplied: blended.applied,
        hasCompanionOdds,
        warnings: underCardsGuard.warnings,
      });

      opportunities.push({
        marketName:              marketNames[key] ?? key,
        selection:               key,
        marketCategory:          category,
        marketTier,
        selectionFamily,
        adaptiveRankMultiplier,
        ourProbability:          parseFloat((effectiveProb * 100).toFixed(2)),
        bookmakerOdds:           odds,
        impliedProbability:      parseFloat((impliedRaw   * 100).toFixed(2)),
        impliedProbabilityNoVig: parseFloat((impliedNoVig * 100).toFixed(2)),
        expectedValue:           parseFloat((ev           * 100).toFixed(2)),
        kellyFraction:           parseFloat((this.kellyFraction(effectiveProb, odds) * 100).toFixed(2)),
        suggestedStakePercent:   stakePercent,
        confidence:              stakeConfidence,
        isValueBet:              true,
        edge:                    parseFloat((edgeRaw   * 100).toFixed(2)),
        edgeNoVig:               parseFloat((edgeNoVig * 100).toFixed(2)),
        modelProbability:        parseFloat((Number(ourProb) * 100).toFixed(2)),
        calibratedProbability:   parseFloat((calibration.probability * 100).toFixed(2)),
        blendedProbability:      parseFloat((effectiveProb * 100).toFixed(2)),
        marketProbabilityNoVig:  parseFloat((impliedNoVig * 100).toFixed(2)),
        modelWeight:             blended.modelWeight,
        marketWeight:            blended.marketWeight,
        categoryCalibrationStatus: calibration.status,
        calibrationSampleSize:   calibration.sampleSize,
        calibrationReliability:  calibration.reliability,
        mainReason:              diagnostics.mainReason,
        riskReasons:             diagnostics.riskReasons,
        dataQuality:             blended.dataQuality,
        companionOddsAvailable:  hasCompanionOdds,
        uncertaintyFactor:       Number(uncertaintyFactor.toFixed(3)),
        riskPenalty:             Number(riskPenalty.toFixed(3)),
        rankingScore,
        logGrowth:               Number(logGrowth.toFixed(6)),
        dynamicEvThreshold:      Number((minEv * 100).toFixed(2)),
        contextStrength:         Number(contextStrength.toFixed(3)),
        dataWarnings:            diagnostics.warnings.length > 0 ? diagnostics.warnings : undefined,
        line:                    underCardsGuard.line ?? undefined,
      });
    }

    return opportunities.sort(
      (a, b) =>
        Number(b.rankingScore ?? b.expectedValue * (b.adaptiveRankMultiplier ?? 1)) -
        Number(a.rankingScore ?? a.expectedValue * (a.adaptiveRankMultiplier ?? 1))
    );
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

    /**
     * MAX_COMBO_STAKE scalato inversamente con √n_legs.
     *
     * MOTIVAZIONE MATEMATICA:
     * Una combinata con n legs indipendenti ha varianza totale che cresce
     * proporzionalmente a n (somma di varianze). La deviazione standard
     * cresce quindi con √n. Per mantenere lo stesso livello di rischio
     * relativo al bankroll, lo stake deve scendere con 1/√n.
     *
     * Formula: MAX_COMBO_STAKE(n) = BASE_CAP / √n
     *   n=1 → 2.4%  (identico al vecchio comportamento per singola)
     *   n=2 → 1.70% (−29%)
     *   n=3 → 1.39% (−42%)
     *   n=4 → 1.20% (−50%)
     *
     * BASE_CAP = MAX_STAKE_PERCENT × 0.6 = 4.0 × 0.6 = 2.4%
     * Questo preserva il cap originale per le singole e riduce
     * automaticamente l'esposizione al crescere del numero di legs.
     *
     * FLOOR: 0.5% — sotto questa soglia la combinata non vale il rischio
     * operativo (spread, liquidità, errori di esecuzione).
     */
    const BASE_COMBO_CAP = this.MAX_STAKE_PERCENT * 0.6;  // 2.4%
    const nLegs = legs.length;
    const baseMaxComboStake = Math.max(0.5, BASE_COMBO_CAP / Math.sqrt(nLegs));
    const covarianceRisk = this.computeComboCovarianceRisk(legs);
    const comboRiskMode: ComboRiskMode = covarianceRisk.available ? 'covarianceMonteCarlo' : 'sqrtLegs';
    const MAX_COMBO_STAKE = covarianceRisk.available
      ? Math.max(0.5, baseMaxComboStake / Math.sqrt(Math.max(1, covarianceRisk.varianceMultiplier)))
      : baseMaxComboStake;
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
      comboRiskMode,
      returnVariance: covarianceRisk.available ? Number(covarianceRisk.returnVariance.toFixed(6)) : undefined,
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

  /**
   * Deterministic covariance proxy for combo stake scaling.
   *
   * Despite the legacy config name `covarianceMonteCarlo`, this method does not
   * run random Monte Carlo simulation. It uses the configured pairwise
   * correlation matrix to derive a variance multiplier and keeps results
   * deterministic for repeatable backtests/tests.
   */
  private computeComboCovarianceRisk(legs: BetOpportunity[]): {
    available: boolean;
    varianceMultiplier: number;
    returnVariance: number;
  } {
    if (this.runtimeConfig.comboRiskMode !== 'covarianceMonteCarlo') {
      return { available: false, varianceMultiplier: 1, returnVariance: 0 };
    }
    const matrix = this.runtimeConfig.comboCorrelationMatrix ?? {};
    const correlations: number[] = [];
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const left = String(legs[i].marketCategory);
        const right = String(legs[j].marketCategory);
        const configured = matrix[`${left}|${right}`] ?? matrix[`${right}|${left}`];
        if (Number.isFinite(configured)) {
          correlations.push(this.clampNumber(Number(configured), -0.95, 0.95));
        }
      }
    }
    if (correlations.length === 0) {
      return { available: false, varianceMultiplier: 1, returnVariance: 0 };
    }

    const avgCorrelation = correlations.reduce((sum, value) => sum + value, 0) / correlations.length;
    const positiveCorrelation = Math.max(0, avgCorrelation);
    const varianceMultiplier = this.clampNumber(1 + positiveCorrelation * (legs.length - 1), 0.65, 3.5);
    const pCombo = legs.reduce((acc, leg) => acc * (leg.ourProbability / 100), 1);
    const oddsCombo = legs.reduce((acc, leg) => acc * leg.bookmakerOdds, 1);
    const meanReturn = pCombo * oddsCombo - 1;
    const binaryReturnVariance = pCombo * (oddsCombo - 1) ** 2 + (1 - pCombo) - meanReturn ** 2;
    return {
      available: true,
      varianceMultiplier,
      returnVariance: Math.max(0, binaryReturnVariance * varianceMultiplier),
    };
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
