import { OddsSourceBadgeInfo } from './predictionTypes';

export const currentSeason = () => {
  const now = new Date();
  const y = now.getFullYear();
  const month = now.getMonth() + 1;
  const seasonStart = month >= 7 ? y : y - 1;
  return `${seasonStart}/${seasonStart + 1}`;
};

export const formatKickoff = (value?: string) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export const formatDayLabel = (key: string) => {
  if (key === 'unknown') return 'Data sconosciuta';
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  const label = new Intl.DateTimeFormat('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).format(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

export const confidenceRank = (value?: string): number => (value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : 1);

export const buildOddsReliabilityBadge = (prediction: any, isReplay: boolean): OddsSourceBadgeInfo => {
  if (isReplay) {
    return prediction?.oddsReplaySource === 'historical_bookmaker_snapshot'
      ? { label: 'Snapshot bookmaker reale', className: 'pr-badge-green' }
      : { label: 'Replay su quote modello', className: 'pr-badge-gold' };
  }
  if (prediction?.oddsSource === 'eurobet_scraper') return { label: 'Quote reali Eurobet', className: 'pr-badge-green' };
  if (prediction?.oddsSource === 'fallback_provider') return { label: 'Quote provider secondario', className: 'pr-badge-gold' };
  if (prediction?.oddsSource === 'eurobet_unavailable') return { label: 'Quote Eurobet non disponibili', className: 'pr-badge-gray' };
  return { label: 'Fonte quote n/d', className: 'pr-badge-gray' };
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
  if (key === 'draw_no_bet') return 'Draw No Bet';
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

export const sanitizePredictionForEurobetOnly = (prediction: any, oddsSource?: string | null) => {
  if (!prediction) return prediction;
  if (oddsSource === 'eurobet_scraper') {
    return {
      ...prediction,
      oddsSource: 'eurobet_scraper',
      usedSyntheticOdds: false,
      usedFallbackBookmaker: false,
    };
  }
  if (oddsSource === 'fallback_provider') {
    return {
      ...prediction,
      oddsSource: 'fallback_provider',
      usedSyntheticOdds: false,
      usedFallbackBookmaker: true,
    };
  }
  return {
    ...prediction,
    oddsSource: oddsSource ?? 'eurobet_unavailable',
    usedSyntheticOdds: false,
    usedFallbackBookmaker: false,
    valueOpportunities: [],
    bestValueOpportunity: null,
  };
};

export const VALUE_LEGEND: Array<{ term: string; meaning: string }> = [
  { term: 'Quota', meaning: 'Prezzo bookmaker decimale della selezione (es. 2.10).' },
  { term: 'P. Nostra', meaning: 'Probabilita stimata dal modello per quella selezione.' },
  { term: 'P. Implicita', meaning: 'Probabilita del bookmaker: 1 / quota.' },
  { term: 'EV', meaning: 'Valore atteso: EV = p_model * quota - 1. Se > 0, la quota e teoricamente di valore.' },
  { term: 'Edge', meaning: 'Vantaggio stimato: p_model - p_implicita.' },
  { term: 'Kelly 1/4', meaning: 'Percentuale consigliata di stake sul bankroll con Kelly frazionale (25%).' },
  { term: 'Base modello', meaning: 'Punteggio basato su EV, edge, Kelly e confidenza.' },
  { term: 'Contesto', meaning: 'Correzione con fattori match: campo, forma, obiettivi, assenze, espulsioni, diffidati.' },
  { term: 'Score totale', meaning: 'Base modello + Contesto. Il piu alto e la miglior giocata proposta.' },
  { term: 'Home advantage', meaning: 'Vantaggio campo: >0 favorisce casa, <0 favorisce ospite.' },
  { term: 'Form delta', meaning: 'Differenza forma recente: >0 casa meglio, <0 ospite meglio.' },
  { term: 'Motivation delta', meaning: 'Differenza obiettivi/motivazione: >0 casa piu motivata.' },
];
