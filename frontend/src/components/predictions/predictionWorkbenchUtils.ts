import { OddsSourceBadgeInfo } from './predictionTypes';
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
  const label = formatMatchDate(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

export const confidenceRank = (value?: string): number => (value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : 1);

export const buildOddsReliabilityBadge = (prediction: any, isReplay: boolean): OddsSourceBadgeInfo => {
  if (isReplay) {
    return prediction?.oddsReplaySource === 'historical_bookmaker_snapshot'
      ? { label: 'Snapshot Eurobet storico', className: 'pr-badge-green' }
      : { label: 'Quota Eurobet non disponibile', className: 'pr-badge-gray' };
  }
  if (prediction?.oddsSource === 'odds_api') {
    return { label: 'Quota Eurobet verificata', className: 'pr-badge-green' };
  }
  return { label: 'Quota Eurobet non disponibile', className: 'pr-badge-gray' };
};

export const rankOpportunity = (opportunity: any): number => {
  const expectedValue = Number(opportunity?.expectedValue ?? 0);
  const edge = Number(opportunity?.edge ?? 0);
  const probability = Number(opportunity?.ourProbability ?? 0);
  const normalizedProbability = probability > 1 ? probability / 100 : probability;
  return (expectedValue * 0.55) + (edge * 0.30) + (normalizedProbability * 8) + (confidenceRank(opportunity?.confidence) * 4);
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

export const buildBetKey = (matchId: string, selection: string, marketName: string): string =>
  `${String(matchId ?? '')}::${String(selection ?? '')}::${String(marketName ?? '')}`;

export const sanitizePredictionForBookmakerOdds = (prediction: any, oddsSource?: string | null) => {
  if (!prediction) return prediction;
  if (oddsSource === 'odds_api') {
    return {
      ...prediction,
      oddsSource: 'odds_api',
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
    bestValueOpportunity: null,
    bestBetStatus: 'NO_MARKET',
    bestBetReason: 'Quota Eurobet non disponibile: nessuna giocata operativa proposta.',
    bestBetAlternatives: [],
  };
};


export const VALUE_LEGEND: Array<{ term: string; meaning: string; termId?: string }> = [
  { term: 'Quota', termId: 'decimal-odds', meaning: 'Prezzo decimale Eurobet della selezione (es. 2.10).' },
  { term: 'Probabilità stimata', termId: 'model-probability', meaning: 'Probabilità attribuita dal modello alla selezione.' },
  { term: 'Probabilità implicita', termId: 'implied-probability', meaning: 'Probabilità ricavata dalla quota: 1 / quota.' },
  { term: 'EV', termId: 'expected-value', meaning: 'Valore atteso della giocata, da valutare insieme a rischio e campione.' },
  { term: 'Edge', termId: 'edge', meaning: 'Differenza tra probabilità del modello e probabilità di mercato.' },
  { term: 'Kelly 1/4', termId: 'fractional-kelly', meaning: 'Quota prudente del bankroll calcolata con Kelly frazionale.' },
  { term: 'Affidabilità', termId: 'confidence', meaning: 'Solidità dei dati e del segnale; non è una garanzia di vincita.' },
  { term: 'Qualità dei dati', termId: 'data-quality', meaning: 'Copertura, freschezza e coerenza dei dati disponibili.' },
];
