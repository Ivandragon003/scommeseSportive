import {
  BestValueOpportunity, CanonicalRecommendationProjection, OddsSourceBadgeInfo,
  PredictionRecommendationProjection, TechnicalRecommendationAbstention,
} from './predictionTypes';
import {
  formatMatchDate,
  formatMatchTime,
  getMatchDayKey,
} from '../../utils/dateTime';

export const currentSeason = () => {
  const now = new Date();
  const y = now.getFullYear();
  const month = now.getMonth() + 1;
  const seasonStart = month >= 7 ? y : y - 1;
  return `${seasonStart}/${seasonStart + 1}`;
};

export const formatKickoff = (value?: string) => {
  if (!value) return '-';
  const date = formatMatchDate(value);
  const time = formatMatchTime(value);
  if (date === 'Data da definire' || time === '--') return '-';
  return `${date}, ${time}`;
};

const normalizeCompetition = (value?: string) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export const isSerieA = (value?: string) => normalizeCompetition(value) === 'serie a';

export const dateToDayKey = (value?: string) => {
  return getMatchDayKey(value);
};

export const formatDayLabel = (key: string) => {
  if (key === 'unknown') return 'Data sconosciuta';
  const [year, month, day] = key.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return key;
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const label = new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    timeZone: 'Europe/Rome',
  }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

export const buildOddsReliabilityBadge = (prediction: any, isReplay: boolean): OddsSourceBadgeInfo => {
  if (isTechnicalRecommendationAbstention(prediction?.automaticRecommendation)) {
    return { label: 'Quota Nightly non disponibile', className: 'pr-badge-gray' };
  }
  if (isReplay) {
    return prediction?.oddsReplaySource === 'historical_bookmaker_snapshot'
      ? { label: 'Snapshot Eurobet storico', className: 'pr-badge-green' }
      : { label: 'Quota Eurobet non disponibile', className: 'pr-badge-gray' };
  }
  if (prediction?.oddsSource === 'odds_api') {
    const bookmakerName = String(prediction?.oddsBookmaker ?? '').trim();
    return bookmakerName
      ? { label: `Quota bookmaker verificata: ${bookmakerName}`, className: 'pr-badge-green' }
      : { label: 'Quota bookmaker non disponibile', className: 'pr-badge-gray' };
  }
  return { label: 'Quota bookmaker non disponibile', className: 'pr-badge-gray' };
};

export const isTechnicalRecommendationAbstention = (
  packet: CanonicalRecommendationProjection | null | undefined,
): packet is TechnicalRecommendationAbstention => packet != null && 'projectionKind' in packet
  && packet.projectionKind === 'technical_abstention';

/** A persisted Nightly decision remains authoritative even when it abstained. */
export const canonicalRecommendationForPrediction = (
  prediction: PredictionRecommendationProjection | null | undefined,
): CanonicalRecommendationProjection | null => prediction?.automaticRecommendation ?? prediction?.canonicalRecommendation ?? null;

/** Consume the server order; neither confidence nor EV is ranked again in the browser. */
export const canonicalRankedOpportunities = (prediction: PredictionRecommendationProjection | null | undefined): BestValueOpportunity[] => {
  const packet = canonicalRecommendationForPrediction(prediction);
  if (!packet?.selected) return [];
  const selectedKey = `${packet.selected.selection}::${packet.selected.marketName}`;
  return [packet.selected, ...(packet.ranked ?? []).filter((opportunity) =>
    `${opportunity.selection}::${opportunity.marketName}` !== selectedKey)].slice(0, 3);
};

export const canonicalSuggestedStakeAmount = (
  prediction: PredictionRecommendationProjection | null | undefined, bankroll: number,
): number => {
  const packet = canonicalRecommendationForPrediction(prediction);
  if (!packet?.selected) return 0;
  if (prediction?.automaticRecommendation) {
    const amount = Number(prediction.automaticRecommendation.actualStakeAmount);
    return Number.isFinite(amount) && amount >= 0 ? amount : 0;
  }
  return bankroll > 0 ? Number(packet.selected.suggestedStakePercent ?? 0) / 100 * bankroll : 0;
};

export const formatMarketKey = (market: string): string => {
  const key = String(market ?? '').toLowerCase();
  if (key === 'h2h') return '1X2';
  if (key === 'h2h_3_way') return '1X2 (3-way)';
  if (key === 'double_chance') return 'Double Chance';
  if (key === 'draw_no_bet') return 'Pareggio non conta (DNB)';
  if (key === 'btts') return 'Goal/No Goal';
  if (key === 'totals') return 'Totali Goal';
  if (key === 'team_totals') return 'Team Totals';
  if (key === 'alternate_totals') return 'Totali Alternativi';
  if (key === 'spreads') return 'Handicap';
  if (key === 'alternate_spreads') return 'Handicap Alternativi';
  if (key === 'alternate_team_totals') return 'Team Totals Alternativi';
  if (key === 'model_estimated') return 'Quote stimate dal modello';
  return market;
};

export const oddsCategoryLabel = (selection: string): string => {
  const key = String(selection ?? '').toLowerCase();
  // Provider keys can begin with the market family (for example
  // alternate_totals_cards) rather than the user-facing selection. Normalize
  // the already-loaded snapshot here: market tabs then only filter local data.
  if (/^player_.+_(shots|sot)_/.test(key)) return 'Tiri giocatore';
  if (/^player_.+_goals_/.test(key)) return 'Marcatori';
  if (['homewin', 'draw', 'awaywin'].includes(key)) return 'Esito partita';
  if (key.startsWith('double_chance_') || key.startsWith('dnb_')) return 'Esiti protetti';
  if (key === 'btts' || key === 'bttsno') return 'Goal / No Goal';
  if (/^team_(home|away)_(over|under)_/.test(key)) return 'Goal squadra';
  if (/^(over|under)\d/.test(key)) return 'Totali goal';
  if (key.startsWith('ahcp_') || key.startsWith('hcp_') || key.startsWith('asian_')) return 'Handicap';
  if (key.startsWith('cardstotal') || key.includes('cards') || key.startsWith('yellow')) return 'Cartellini';
  if (key.startsWith('fouls') || key.includes('fouls')) return 'Falli';
  if (key.startsWith('shots') || key.includes('shots') || key.includes('_sot_')) return 'Tiri';
  if (key.startsWith('corners') || key.includes('corners')) return 'Corner';
  return 'Altri mercati';
};

export const buildBetKey = (matchId: string, selection: string, marketName: string): string =>
  `${String(matchId ?? '')}::${String(selection ?? '')}::${String(marketName ?? '')}`;

/** Market tabs only filter already loaded analysis data; they must never request a new analysis. */
export const switchMarketTab = (marketId: string, setActiveMarket: (marketId: string) => void) => {
  setActiveMarket(marketId);
};

export const sanitizePredictionForBookmakerOdds = (prediction: any, oddsSource?: string | null, oddsBookmaker?: string | null) => {
  if (!prediction) return prediction;
  const verifiedBookmaker = String(oddsBookmaker ?? '').trim();
  if (oddsSource === 'odds_api' && verifiedBookmaker) {
    return {
      ...prediction,
      oddsSource: 'odds_api',
      oddsBookmaker: verifiedBookmaker,
      usedSyntheticOdds: false,
      usedFallbackBookmaker: false,
    };
  }
  const resolvedSource = oddsSource ?? 'odds_unavailable';
  return {
    ...prediction,
    oddsSource: resolvedSource,
    usedSyntheticOdds: false,
    usedFallbackBookmaker: resolvedSource === 'fallback_provider',
    valueOpportunities: [],
    canonicalRecommendation: prediction.canonicalRecommendation
      ? { ...prediction.canonicalRecommendation, selected: null, ranked: [], decisionStatus: 'NO_BET' }
      : null,
    bestValueOpportunity: null,
    bestBetStatus: 'NO_MARKET',
    oddsBookmaker: null,
    bestBetReason: 'Quota bookmaker non disponibile: nessuna giocata operativa proposta.',
    bestBetAlternatives: [],
  };
};


export const VALUE_LEGEND: Array<{ term: string; meaning: string; termId?: string }> = [
  { term: 'Quota', termId: 'decimal-odds', meaning: 'Prezzo decimale del bookmaker verificato per la selezione (es. 2.10).' },
  { term: 'Probabilità stimata', termId: 'model-probability', meaning: 'Probabilità attribuita dal modello alla selezione.' },
  { term: 'Probabilità implicita', termId: 'implied-probability', meaning: 'Probabilità ricavata dalla quota: 1 / quota.' },
  { term: 'EV', termId: 'expected-value', meaning: 'Valore atteso della giocata, da valutare insieme a rischio e campione.' },
  { term: 'Edge', termId: 'edge', meaning: 'Differenza tra probabilità del modello e probabilità di mercato.' },
  { term: 'Kelly 1/4', termId: 'fractional-kelly', meaning: 'Quota prudente del bankroll calcolata con Kelly frazionale.' },
  { term: 'Affidabilità', termId: 'confidence', meaning: 'Solidità dei dati e del segnale; non è una garanzia di vincita.' },
  { term: 'Qualità dei dati', termId: 'data-quality', meaning: 'Copertura, freschezza e coerenza dei dati disponibili.' },
];
