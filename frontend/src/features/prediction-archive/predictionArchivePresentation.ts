import { PredictionArchiveRecord } from '../../utils/api';

export const percentage = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';

export const decimal = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';

export const dateTime = (value?: string | null) => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(parsed);
};

export const archiveMatchTitle = (row: PredictionArchiveRecord) => {
  const home = String(row.home_team_name ?? '').trim();
  const away = String(row.away_team_name ?? '').trim();
  return home && away ? `${home} – ${away}` : `Match #${row.match_id}`;
};

export const archiveMatchMeta = (row: PredictionArchiveRecord) => {
  const parts = [String(row.competition ?? '').trim(), dateTime(row.match_date)].filter((part) => part && part !== '—');
  return parts.length > 0 ? parts.join(' · ') : 'Dettagli partita non disponibili';
};

const validOdds = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) && value > 1 ? value : null;

export const archiveOdds = (row: PredictionArchiveRecord) => {
  const source = String(row.source ?? '').trim().toLowerCase();
  const sourceIsSynthetic = ['synthetic', 'fallback', 'model_completion'].some((token) => source.includes(token));
  const prediction = !source || sourceIsSynthetic ? null : validOdds(row.odds_at_prediction);
  const played = row.was_played === 1 || row.was_played === true;
  const bet = played ? validOdds(row.bet_odds) : null;
  return { prediction, bet };
};

export const confidenceBadge = (value?: string | null) => {
  switch (String(value ?? '').trim().toUpperCase()) {
    case 'LOW': return { label: 'Low', tone: 'low' };
    case 'MEDIUM': return { label: 'Medium', tone: 'medium' };
    case 'HIGH': return { label: 'High', tone: 'high' };
    default: return { label: 'Non classificata', tone: 'unclassified' };
  }
};

export const resultBadge = (result?: string | null) => {
  switch (String(result ?? 'pending').toLowerCase()) {
    case 'win': return { label: 'Vinta', tone: 'success' };
    case 'loss': return { label: 'Persa', tone: 'danger' };
    case 'void': return { label: 'Rimborsata', tone: 'neutral' };
    default: return { label: 'In attesa', tone: 'pending' };
  }
};

export const archiveErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  return 'Impossibile caricare l’archivio prediction.';
};
