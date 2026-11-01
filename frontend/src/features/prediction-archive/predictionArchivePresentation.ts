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
  return Number.isFinite(parsed) ? String(parsed) : value;
};

const goalLineValue = (raw: string) => {
  if (/[._]/.test(raw) || raw.length === 1) return Number(raw.replace('_', '.'));
  return Number(raw) / (/\d(?:25|75)$/.test(raw) ? 100 : 10);
};

interface SelectionQuote {
  selection?: string;
  market?: string;
  side?: string;
  line?: number;
}

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
  quote?: SelectionQuote | null,
) => {
  const raw = String(selection ?? '').trim();
  const selectionCode = raw.toLowerCase();

  if (selectionCode === 'homewin') return `1 — ${teamName('home', home, away)} vincente`;
  if (selectionCode === 'awaywin') return `2 — ${teamName('away', home, away)} vincente`;
  if (selectionCode === 'draw') return 'X — Pareggio';
  if (selectionCode === 'double_chance_1x') return `1X — ${teamName('home', home, away)} o pareggio`;
  if (selectionCode === 'double_chance_x2') return `X2 — ${teamName('away', home, away)} o pareggio`;
  if (selectionCode === 'double_chance_12') return '12 — Una delle due squadre vince';
  if (selectionCode === 'dnb_home') return `DNB 1 — ${teamName('home', home, away)}; pareggio rimborsato`;
  if (selectionCode === 'dnb_away') return `DNB 2 — ${teamName('away', home, away)}; pareggio rimborsato`;
  if (selectionCode === 'btts') return 'Goal (GG) — Entrambe le squadre segnano';
  if (selectionCode === 'bttsno') return 'No Goal (NG) — Almeno una squadra non segna';

  const exact = selectionCode.match(/^exact_(\d+)-(\d+)$/);
  if (exact) return `Risultato esatto ${exact[1]}–${exact[2]}`;

  const teamTotal = selectionCode.match(/^team_(home|away)_(over|under)_([0-9]+(?:[._][0-9]+)?)$/);
  if (teamTotal) {
    const team = teamName(teamTotal[1], home, away);
    const direction = teamTotal[2] === 'over' ? 'Over' : 'Under';
    return `${team}: ${direction} ${formatLine(String(goalLineValue(teamTotal[3])))} gol`;
  }

  const goalLine = selectionCode.match(/^(over|under)(?:_)?(\d+(?:[._]\d+)?)$/);
  if (goalLine) {
    return `${goalLine[1] === 'over' ? 'Over' : 'Under'} ${formatLine(String(goalLineValue(goalLine[2])))} gol`;
  }

  const compactStat = selectionCode.match(/^(shots|shotshome|shotsaway|shotsot|yellow|cardstotal)(over|under)(\d+)$/);
  const statDomains: Record<string, string> = {
    shots: 'shots_total', shotshome: 'shots_home', shotsaway: 'shots_away',
    shotsot: 'sot_total', yellow: 'yellow', cardstotal: 'cards_total',
  };
  const statKey = compactStat
    ? `${statDomains[compactStat[1]]}_${compactStat[2]}_${Number(compactStat[3]) / 10}` : selectionCode;
  const statLine = statKey.match(/^(shots_total|shots_home|shots_away|sot_total|corners|yellow|cards_total|fouls)_(over|under)_([0-9]+(?:[._][0-9]+)?)$/);
  if (statLine) {
    const labels: Record<string, string> = {
      shots_total: 'Tiri totali', shots_home: `Tiri ${teamName('home', home, away)}`,
      shots_away: `Tiri ${teamName('away', home, away)}`, sot_total: 'Tiri in porta totali',
      corners: 'Calci d’angolo', yellow: 'Cartellini gialli', cards_total: 'Punti cartellino', fouls: 'Falli totali',
    };
    return `${labels[statLine[1]]}: ${statLine[2] === 'over' ? 'Over' : 'Under'} ${formatLine(statLine[3])}`;
  }

  if (/^(?:a|e)?hcp_/.test(selectionCode)) {
    const asian = selectionCode.startsWith('ahcp_');
    const label = asian ? 'Handicap asiatico' : 'Handicap europeo';
    const expectedSide = selectionCode.startsWith('ahcp_away_') ? 'away' : asian ? 'home'
      : selectionCode.match(/^(?:e)?hcp_(home|away|draw)/)?.[1];
    const expectedMarket = asian ? 'asian_handicap' : 'european_handicap';
    // A and C use different Asian alias conventions; only the recorded price defines the adjustment.
    if (!expectedSide || !quote || quote.market !== expectedMarket || quote.side !== expectedSide
      || (quote.selection !== undefined && quote.selection !== raw)
      || typeof quote.line !== 'number' || !Number.isFinite(quote.line)) {
      return `${label} — dettaglio non disponibile`;
    }
    const sign = quote.side === 'home' ? '1' : quote.side === 'away' ? '2' : 'X';
    // European lines adjust the home score; Asian lines adjust the selected team's score.
    const adjustment = !asian && quote.side === 'away' ? -quote.line : quote.line;
    const line = `${adjustment > 0 ? '+' : ''}${formatLine(String(adjustment))}`;
    return quote.side === 'draw' ? `${label} X (${line} casa) — Pareggio`
      : `${label} ${sign} — ${teamName(quote.side!, home, away)} (${line})`;
  }

  const playerProp = raw.match(/^player_(.+)_(shots|sot|yellow|goals)_(over|under)_([0-9]+(?:_[0-9]+)?)$/i);
  if (playerProp) {
    const rawPlayer = playerProp[1];
    const player = /^(?:understat_player_|player_)?\d+$/i.test(rawPlayer)
      || /^understat_player_\d+$/i.test(rawPlayer)
      ? 'Giocatore'
      : rawPlayer.replace(/_/g, ' ');
    const labels: Record<string, string> = { shots: 'tiri', sot: 'tiri in porta', yellow: 'cartellini', goals: 'gol' };
    const direction = playerProp[3].toLowerCase() === 'over' ? 'Over' : 'Under';
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
    case 'manual_saved_only': return 'Salvata manualmente senza piazzare la giocata.';
    default: return 'Questa simulazione non modifica il budget.';
  }
};

export const archiveErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  return 'Impossibile caricare l’archivio giocate.';
};
