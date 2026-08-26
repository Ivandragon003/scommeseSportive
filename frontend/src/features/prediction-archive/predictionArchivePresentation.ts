import { BetOpportunityArchiveRecord } from '../../utils/api';
import { formatBetMarketName } from '../../utils/betPresentation';

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

export const archiveMatchTitle = (row: BetOpportunityArchiveRecord) => {
  const home = String(row.home_team_name ?? '').trim();
  const away = String(row.away_team_name ?? '').trim();
  return home && away ? `${home} – ${away}` : 'Partita archiviata';
};

export const archiveMatchMeta = (row: BetOpportunityArchiveRecord) => {
  const parts = [String(row.competition ?? '').trim(), dateTime(row.match_date)].filter((part) => part && part !== '—');
  return parts.length > 0 ? parts.join(' · ') : 'Dettagli partita non disponibili';
};

const formatLine = (value: string) => {
  const parsed = Number(value.replace('_', '.'));
  return Number.isFinite(parsed) ? parsed.toLocaleString('it-IT', { maximumFractionDigits: 2 }) : value;
};

const teamName = (side: string, home?: string | null, away?: string | null) => {
  if (side === 'home') return String(home ?? '').trim() || 'squadra di casa';
  return String(away ?? '').trim() || 'squadra ospite';
};

export const opportunityMarketLabel = (marketName?: string | null) => {
  const raw = String(marketName ?? '').trim();
  if (/^1x2(?:\s|$|-)/i.test(raw)) return 'Esito finale (1X2)';
  if (/exact|risultato esatto/i.test(raw)) return 'Risultato esatto';
  return formatBetMarketName(raw);
};

export const opportunityLabel = (
  marketName: string,
  selection: string,
  home?: string | null,
  away?: string | null,
) => {
  const raw = String(selection ?? '').trim();
  const key = raw.toLowerCase();

  if (key === 'homewin') return `Vittoria ${teamName('home', home, away)}`;
  if (key === 'awaywin') return `Vittoria ${teamName('away', home, away)}`;
  if (key === 'draw') return 'Pareggio';
  if (key === 'double_chance_1x') return `${teamName('home', home, away)} o pareggio`;
  if (key === 'double_chance_x2') return `${teamName('away', home, away)} o pareggio`;
  if (key === 'double_chance_12') return 'Una delle due squadre vince';
  if (key === 'dnb_home') return `${teamName('home', home, away)}; pareggio rimborsato`;
  if (key === 'dnb_away') return `${teamName('away', home, away)}; pareggio rimborsato`;
  if (key === 'btts') return 'Entrambe le squadre segnano';
  if (key === 'bttsno') return 'Almeno una squadra non segna';

  const exact = key.match(/^exact_(\d+)-(\d+)$/);
  if (exact) return `Risultato esatto ${exact[1]}–${exact[2]}`;

  const teamTotal = key.match(/^team_(home|away)_(over|under)_([0-9]+(?:[._][0-9]+)?)$/);
  if (teamTotal) {
    const team = teamName(teamTotal[1], home, away);
    const direction = teamTotal[2] === 'over' ? 'Più di' : 'Meno di';
    return `${team}: ${direction} ${formatLine(teamTotal[3])} gol`;
  }

  const goalLine = key.match(/^(over|under)(?:_)?(\d+(?:_\d+)?)$/);
  if (goalLine) {
    const compact = goalLine[2].includes('_') ? goalLine[2] : `${goalLine[2].slice(0, -1)}_${goalLine[2].slice(-1)}`;
    return `${goalLine[1] === 'over' ? 'Più di' : 'Meno di'} ${formatLine(compact)} gol`;
  }

  const statLine = key.match(/^(shots_total|shots_home|shots_away|sot_total|corners|yellow|cards_total|fouls)_(over|under)_([0-9]+(?:[._][0-9]+)?)$/);
  if (statLine) {
    const labels: Record<string, string> = {
      shots_total: 'Tiri totali', shots_home: `Tiri ${teamName('home', home, away)}`,
      shots_away: `Tiri ${teamName('away', home, away)}`, sot_total: 'Tiri in porta totali',
      corners: 'Calci d’angolo', yellow: 'Cartellini gialli', cards_total: 'Punti cartellino', fouls: 'Falli totali',
    };
    return `${labels[statLine[1]]}: ${statLine[2] === 'over' ? 'più di' : 'meno di'} ${formatLine(statLine[3])}`;
  }

  const handicap = key.match(/^(?:a|e)?hcp_(home|away)_([+-]?[0-9]+(?:[._][0-9]+)?)$/);
  if (handicap) return `${teamName(handicap[1], home, away)} con handicap ${formatLine(handicap[2])}`;

  const playerProp = raw.match(/^player_(.+)_(shots|sot|yellow|goals)_(over|under)_([0-9]+(?:_[0-9]+)?)$/i);
  if (playerProp) {
    const rawPlayer = playerProp[1];
    const player = /^(?:understat_player_|player_)?\d+$/i.test(rawPlayer)
      || /^understat_player_\d+$/i.test(rawPlayer)
      ? 'Giocatore'
      : rawPlayer.replace(/_/g, ' ');
    const labels: Record<string, string> = { shots: 'tiri', sot: 'tiri in porta', yellow: 'cartellini', goals: 'gol' };
    const direction = playerProp[3].toLowerCase() === 'over' ? 'più di' : 'meno di';
    return `${player}: ${direction} ${formatLine(playerProp[4])} ${labels[playerProp[2].toLowerCase()]}`;
  }

  const readable = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (readable && !/^[a-z0-9 .+-]+$/i.test(raw)) return readable;
  return opportunityMarketLabel(marketName);
};

export const opportunityOdds = (row: BetOpportunityArchiveRecord) => {
  const source = String(row.source ?? '').trim().toLowerCase();
  const bookmaker = String(row.bookmaker_name ?? '').trim();
  const synthetic = ['synthetic', 'fallback', 'model_completion'].some((token) => source.includes(token));
  const value = Number(row.display_odds);
  return bookmaker && !synthetic && Number.isFinite(value) && value > 1 ? value : null;
};

export const classificationBadge = (value: BetOpportunityArchiveRecord['classification'] | string) => {
  switch (String(value ?? '').trim().toUpperCase()) {
    case 'HIGH': return { label: 'High', tone: 'high' };
    case 'MEDIUM': return { label: 'Medium', tone: 'medium' };
    case 'LOW': return { label: 'Low', tone: 'low' };
    case 'SPECULATIVE': return { label: 'Speculativa', tone: 'speculative' };
    default: return { label: 'Da verificare', tone: 'low' };
  }
};

export const typeBadge = (value: BetOpportunityArchiveRecord['archive_type']) =>
  value === 'operative'
    ? { label: 'Operativa', tone: 'played' }
    : { label: 'Simulata', tone: 'unplayed' };

export const resultBadge = (result?: string | null) => {
  switch (String(result ?? 'pending').toLowerCase()) {
    case 'win': return { label: 'Vinta', tone: 'success' };
    case 'loss': return { label: 'Persa', tone: 'danger' };
    case 'void': return { label: 'Rimborsata', tone: 'neutral' };
    default: return { label: 'In attesa', tone: 'pending' };
  }
};

export const exclusionReasonLabel = (reason?: string | null) => {
  switch (String(reason ?? '').trim()) {
    case 'per_match_limit_reached': return 'Fuori dalle 3 giocate operative della partita.';
    case 'low_confidence_saved_only': return 'Registrata per raccogliere dati, senza usare il budget.';
    case 'speculative_saved_only': return 'Ipotesi speculativa registrata solo per analisi future.';
    default: return 'Questa simulazione non modifica il budget.';
  }
};

export const archiveErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  return 'Impossibile caricare l’archivio giocate.';
};
