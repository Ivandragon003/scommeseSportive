import { ComparisonBreakdown, EconomicMetrics, ResearchPortfolio } from './researchTypes';

const moneyFormat = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const numberFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 4 });

export const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const money = (cents: unknown): string => finiteNumber(cents) ? moneyFormat.format(cents / 100) : 'Non disponibile';
export const metric = (value: unknown): string => finiteNumber(value) ? numberFormat.format(value) : '—';
export const percent = (value: unknown): string => finiteNumber(value) ? `${new Intl.NumberFormat('it-IT', { maximumFractionDigits: 2 }).format(value * 100)}%` : '—';
export const count = (value: unknown): string => finiteNumber(value) && value >= 0 ? new Intl.NumberFormat('it-IT').format(value) : '—';

export const isTimestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) && Number.isFinite(Date.parse(value));

export const dateTime = (value: unknown): string => {
  if (!isTimestamp(value)) return 'Non disponibile';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(date)
    : 'Non disponibile';
};

export const marketLabel = (market: string): string => ({
  '1x2': 'Esito finale 1X2', goal_1x2: 'Esito finale 1X2', double_chance: 'Doppia chance',
  dnb: 'Rimborso sul pareggio', totals: 'Over/Under goal', team_totals: 'Goal singola squadra',
  btts: 'Goal/No Goal', european_handicap: 'Handicap europeo', asian_handicap: 'Handicap asiatico',
  shots: 'Tiri totali', shots_ot: 'Tiri in porta', shots_on_target: 'Tiri in porta', cards_total: 'Cartellini totali', yellow_cards: 'Cartellini',
}[market] || market);

export const stateLabel = (state: string): string => ({
  EXPERIMENTAL: 'Sperimentale', SHADOW: 'Shadow', ACTIVE: 'Attivo', SUSPENDED: 'Sospeso',
  CHAMPION: 'Champion', CANDIDATE: 'Candidato', VALIDATED: 'Validato', REJECTED: 'Non promosso',
  RETIRED: 'Archiviato', PENDING: 'Aperta', OPEN: 'Aperta', WON: 'Vinta', LOST: 'Persa',
  VOID: 'Rimborsata', HALF_WON: 'Mezza vincita', HALF_LOST: 'Mezza perdita', SETTLED: 'Liquidata',
  scheduled: 'Programmato', claimed: 'In esecuzione', completed: 'Completato', missed: 'Mancato',
  skipped: 'Saltato', failed: 'Errore', cancelled: 'Annullato',
  SCHEDULED: 'Programmato', CLAIMED: 'In esecuzione', COMPLETED: 'Completato', MISSED: 'Mancato',
  SKIPPED: 'Saltato', FAILED: 'Errore', CANCELLED: 'Annullato',
}[state] || state);

export const portfolioLabel = (portfolio: Pick<ResearchPortfolio, 'id' | 'family'>): string =>
  portfolio.id === 'main' ? 'Portafoglio principale' : `Portafoglio ${portfolio.family}`;

const DECISION_REASONS: Record<string, string> = {
  hybrid_model_unavailable_or_incompatible: 'Modello C assente o incompatibile.',
  validated_calibration_unavailable: 'Calibrazione validata non disponibile.',
  quotes_missing: 'Quote reali non disponibili.',
  stale_t15_quote: 'Quote troppo vecchie per la decisione T−15.',
  real_fresh_quote_required: 'Serve una quota reale aggiornata.',
  market_not_allowed: 'Mercato non abilitato per questa versione.',
  market_not_validated: 'Mercato non ancora validato.',
  model_not_registered: 'Versione del modello non registrata.',
  model_abstained: 'Il modello non ha selezionato una puntata.',
  model_not_validated: 'Controlli del modello non superati.',
  insufficient_validation_calibration: 'Campione di validazione insufficiente per stimare il valore prudenziale.',
  central_ev_below_threshold: 'Valore atteso sotto la soglia richiesta.',
  prudential_ev_below_threshold: 'Valore prudenziale sotto la soglia richiesta.',
  prudential_value_threshold_required: 'Soglie di valore centrale o prudenziale non superate.',
  insufficient_virtual_capital: 'Capitale virtuale disponibile insufficiente.',
  virtual_exposure_limit: 'Limite di esposizione del portafoglio raggiunto.',
  one_bet_per_portfolio_match: 'Partita già registrata in questo portafoglio.',
  main_requires_active_champion: 'Il portafoglio principale richiede un Champion e un mercato attivi.',
  quote_not_in_shared_snapshot: 'Quota assente dallo snapshot condiviso.',
};

export const decisionReason = (value?: string): string => {
  if (!value) return 'Nessun motivo aggiuntivo registrato.';
  if (value.trim().startsWith('{')) {
    try {
      const reasons = JSON.parse(value) as Record<string, unknown>;
      const labels = Object.entries(reasons).filter(([, amount]) => finiteNumber(amount) && amount > 0)
        .map(([key]) => DECISION_REASONS[key] || key.replace(/_/g, ' '));
      return labels.length ? labels.join(' ') : 'Nessuna opportunità ha superato tutti i controlli.';
    } catch { return 'Motivazione non leggibile; consultare il registro tecnico.'; }
  }
  return DECISION_REASONS[value] || value;
};

export interface EquityPoint { at: string; A?: number; C?: number }

export const comparativeEquity = (
  a: EconomicMetrics['equity'], c: EconomicMetrics['equity'],
): EquityPoint[] => {
  const points = new Map<string, EquityPoint>();
  const append = (rows: EconomicMetrics['equity'], family: 'A' | 'C') => (rows || []).forEach((row, index) => {
    const at = row.at || row.date || String(index + 1);
    const cents = row.equityCents;
    if (!finiteNumber(cents)) return;
    const point = points.get(at) || { at };
    point[family] = cents / 100;
    points.set(at, point);
  });
  append(a, 'A'); append(c, 'C');
  return Array.from(points.values()).sort((left, right) => left.at.localeCompare(right.at, undefined, { numeric: true }));
};

export const breakdownLabel = (row: ComparisonBreakdown): string =>
  row.label || row.league || row.competition || (row.market && marketLabel(row.market)) || row.season || 'Non specificato';

export const confidenceInterval = (value: unknown): string | null => {
  if (Array.isArray(value) && value.length === 2 && value.every(finiteNumber)) {
    return `[${metric(value[0])}; ${metric(value[1])}]`;
  }
  if (value && typeof value === 'object') {
    const interval = value as { lower?: number; upper?: number; low?: number; high?: number };
    const lower = interval.lower ?? interval.low;
    const upper = interval.upper ?? interval.high;
    if (finiteNumber(lower) && finiteNumber(upper)) return `[${metric(lower)}; ${metric(upper)}]`;
  }
  return null;
};
