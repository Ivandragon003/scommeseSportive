const MARKET_LABELS: Record<string, string> = {
  homeWin: 'Casa (1)',
  draw: 'Pareggio (X)',
  awayWin: 'Ospite (2)',
  btts: 'GG Si',
  bttsNo: 'GG No',
  over15: 'O1.5',
  over25: 'O2.5',
  over35: 'O3.5',
  over45: 'O4.5',
  under25: 'U2.5',
  under35: 'U3.5',
  'yellow_over_3.5': 'Gialli O3.5',
  'yellow_over_4.5': 'Gialli O4.5',
  'yellow_over_5.5': 'Gialli O5.5',
  'fouls_over_20.5': 'Falli O20.5',
  'fouls_over_23.5': 'Falli O23.5',
  'shots_total_over_23.5': 'Tiri O23.5',
  'shots_total_over_25.5': 'Tiri O25.5',
  'shots_total_over_27.5': 'Tiri O27.5',
  'shots_total_over_29.5': 'Tiri O29.5',
  'shots_total_under_22.5': 'Tiri U22.5',
  'shots_total_under_24.5': 'Tiri U24.5',
  'shots_total_under_26.5': 'Tiri U26.5',
  'shots_total_under_28.5': 'Tiri U28.5',
  'shots_home_over_10.5': 'Tiri Casa O10.5',
  'shots_home_over_12.5': 'Tiri Casa O12.5',
  'shots_home_over_14.5': 'Tiri Casa O14.5',
  'shots_away_over_10.5': 'Tiri Ospite O10.5',
  'shots_away_over_12.5': 'Tiri Ospite O12.5',
  'shots_away_over_14.5': 'Tiri Ospite O14.5',
  'sot_total_over_7.5': 'SOT O7.5',
  'sot_total_over_9.5': 'SOT O9.5',
  'sot_total_over_11.5': 'SOT O11.5',
  'sot_total_over_13.5': 'SOT O13.5',
};

const prettyLine = (raw: string): string => {
  const cleaned = String(raw ?? '').trim().replace(',', '.');
  if (/^-?\d+\.\d+$/.test(cleaned)) return cleaned;
  if (/^-?\d+$/.test(cleaned) && cleaned.length >= 2) return `${cleaned.slice(0, -1)}.${cleaned.slice(-1)}`;
  return cleaned;
};

const marketLabel = (key: string) => {
  if (MARKET_LABELS[key]) return MARKET_LABELS[key];
  const stats = key.match(/^(shots_total|shots_home|shots_away|sot_total|fouls|yellow|cards_total)_(over|under)_([0-9]+(?:\.[0-9]+)?)$/i);
  if (stats) {
    const domainLabel: Record<string, string> = {
      shots_total: 'Tiri Totali',
      shots_home: 'Tiri Casa',
      shots_away: 'Tiri Ospite',
      sot_total: 'Tiri in Porta Totali',
      fouls: 'Falli Totali',
      yellow: 'Gialli Totali',
      cards_total: 'Cartellini Pesati',
    };
    const side = stats[2].toLowerCase() === 'over' ? 'Over' : 'Under';
    return `${domainLabel[stats[1].toLowerCase()] ?? stats[1]} ${side} ${prettyLine(stats[3])}`;
  }
  return key.replace(/_/g, ' ');
};

export const fmtPct = (value: number) => `${(value * 100).toFixed(2)}%`;

export const fmtN = (value: number, digits = 2) => value.toFixed(digits);

export const marketTierLabel = (tier?: string): string =>
  tier === 'CORE'
    ? 'Mercato core'
    : tier === 'SECONDARY'
      ? 'Mercato secondario'
      : tier === 'SPECULATIVE'
        ? 'Mercato speculativo'
        : 'Tier n/d';

export const marketTierBadgeClass = (tier?: string): string =>
  tier === 'CORE'
    ? 'pr-badge-green'
    : tier === 'SECONDARY'
      ? 'pr-badge-blue'
      : tier === 'SPECULATIVE'
        ? 'pr-badge-gold'
        : 'pr-badge-gray';

export const formatCompactOuKey = (key: string): string => {
  const clean = String(key ?? '').toLowerCase().replace(/^over|^under/, '');
  if (/^\d+\.\d+$/.test(clean)) return clean;
  if (/^\.\d+$/.test(clean)) return `0${clean}`;
  if (/^\d$/.test(clean)) return `0.${clean}`;
  if (/^\d+$/.test(clean) && clean.length >= 2) return `${clean.slice(0, -1)}.${clean.slice(-1)}`;
  return clean;
};

export const fmtSelection = (selection: string): string => {
  if (!selection) return '-';
  const clean = String(selection ?? '');
  const camelOu = clean.match(/^(shots|shotsHome|shotsAway|shotsOT|yellow|fouls|cardsTotal)(Over|Under)(\d+)$/);
  if (camelOu) {
    const domainLabel: Record<string, string> = {
      shots: 'Tiri Totali',
      shotsHome: 'Tiri Casa',
      shotsAway: 'Tiri Ospite',
      shotsOT: 'Tiri in Porta',
      yellow: 'Gialli Totali',
      fouls: 'Falli Totali',
      cardsTotal: 'Cartellini',
    };
    const line = camelOu[3].length >= 3
      ? `${camelOu[3].slice(0, -1)}.${camelOu[3].slice(-1)}`
      : camelOu[3];
    return `${domainLabel[camelOu[1]] ?? camelOu[1]} ${camelOu[2]} ${line}`;
  }
  if (selection === 'homeWin') return '1 - Vittoria Casa';
  if (selection === 'draw') return 'X - Pareggio';
  if (selection === 'awayWin') return '2 - Vittoria Ospite';
  if (selection === 'double_chance_1x') return 'Double Chance 1X';
  if (selection === 'double_chance_x2') return 'Double Chance X2';
  if (selection === 'double_chance_12') return 'Double Chance 12';
  if (selection === 'dnb_home') return 'Draw No Bet Casa';
  if (selection === 'dnb_away') return 'Draw No Bet Ospite';
  if (selection.startsWith('hcp_home')) return `Handicap Casa ${selection.replace('hcp_home', '')}`;
  if (selection.startsWith('hcp_away')) return `Handicap Ospite ${selection.replace('hcp_away', '')}`;
  if (selection.startsWith('ahcp_away_')) {
    const raw = selection.replace('ahcp_away_', '');
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return `Asian Handicap Ospite ${numeric > 0 ? '+' : ''}${numeric}`;
    return `Asian Handicap Ospite ${raw}`;
  }
  if (selection.startsWith('ahcp_')) {
    const raw = selection.replace('ahcp_', '');
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return `Asian Handicap Casa ${numeric > 0 ? '+' : ''}${numeric}`;
    return `Asian Handicap ${raw}`;
  }

  const compactGoal = selection.match(/^(over|under)(\d+)$/i);
  if (compactGoal && compactGoal[2].length >= 2) {
    const lineNum = Number(`${compactGoal[2].slice(0, -1)}.${compactGoal[2].slice(-1)}`);
    if (Number.isFinite(lineNum) && lineNum > 7.5) return marketLabel(selection);
    const side = compactGoal[1].toLowerCase() === 'over' ? 'Over' : 'Under';
    const line = `${compactGoal[2].slice(0, -1)}.${compactGoal[2].slice(-1)}`;
    return `${side} ${line} Goal`;
  }

  const teamTotals = selection.match(/^team_(home|away)_(over|under)_([0-9]+(?:\.[0-9]+)?)$/i);
  if (teamTotals) {
    const team = teamTotals[1].toLowerCase() === 'home' ? 'Casa' : 'Ospite';
    const side = teamTotals[2].toLowerCase() === 'over' ? 'Over' : 'Under';
    return `Goal ${team} ${side} ${prettyLine(teamTotals[3])}`;
  }

  return marketLabel(selection);
};
