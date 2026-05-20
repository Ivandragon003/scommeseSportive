export type PlayerPropMarketType = 'shots' | 'sot' | 'yellow';
export type PlayerPropSide = 'over' | 'under';

export interface PlayerPropSelection {
  playerId: string;
  marketType: PlayerPropMarketType;
  side: PlayerPropSide;
  line: number;
  lineKey: string;
}

export interface LegacyPlayerPropSelection {
  playerSlug: string;
  marketType: PlayerPropMarketType;
  side: PlayerPropSide;
  line: number;
  lineKey: string;
}

const MARKET_ALIASES: Record<string, PlayerPropMarketType> = {
  shots: 'shots',
  shot: 'shots',
  tiri: 'shots',
  sot: 'sot',
  shots_on_target: 'sot',
  shotsontarget: 'sot',
  tiri_in_porta: 'sot',
  yellow: 'yellow',
  yellow_cards: 'yellow',
  cartellini: 'yellow',
  gialli: 'yellow',
};

export function normalizePlayerNameForProp(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function lineToPlayerPropKey(line: number | string): string {
  const parsed = typeof line === 'number'
    ? line
    : Number(String(line ?? '').trim().replace(',', '.').replace('_', '.'));
  if (!Number.isFinite(parsed)) return String(line ?? '').trim().replace('.', '_');
  const fixed = Number(parsed.toFixed(2)).toString();
  return fixed.replace('.', '_');
}

export function playerPropKeyToLine(lineKey: string): number {
  const parsed = Number(String(lineKey ?? '').replace('_', '.').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function formatPlayerPropLine(line: number): string {
  if (!Number.isFinite(line)) return '';
  return Number(line.toFixed(2)).toString();
}

export function buildPlayerPropSelectionKey(
  playerId: string,
  marketType: PlayerPropMarketType,
  side: PlayerPropSide,
  line: number | string,
): string {
  const safePlayerId = String(playerId ?? '').trim().replace(/\s+/g, '_');
  return `player_${safePlayerId}_${marketType}_${side}_${lineToPlayerPropKey(line)}`;
}

export function parsePlayerPropSelectionKey(selection: string): PlayerPropSelection | null {
  const match = String(selection ?? '').match(/^player_(.+)_(shots|sot|yellow)_(over|under)_([0-9]+(?:_[0-9]+)?)$/i);
  if (!match) return null;
  const line = playerPropKeyToLine(match[4]);
  if (!Number.isFinite(line)) return null;
  return {
    playerId: match[1],
    marketType: match[2].toLowerCase() as PlayerPropMarketType,
    side: match[3].toLowerCase() as PlayerPropSide,
    line,
    lineKey: lineToPlayerPropKey(line),
  };
}

export function parseLegacyPlayerPropOddsKey(selection: string): LegacyPlayerPropSelection | null {
  const match = String(selection ?? '').match(/^player_(shots|shot|sot|shots_on_target|yellow|yellow_cards)_(.+)_(over|under)_([0-9]+(?:[._][0-9]+)?)$/i);
  if (!match) return null;
  const marketType = MARKET_ALIASES[match[1].toLowerCase()];
  const line = playerPropKeyToLine(match[4]);
  if (!marketType || !Number.isFinite(line)) return null;
  return {
    playerSlug: normalizePlayerNameForProp(match[2]),
    marketType,
    side: match[3].toLowerCase() as PlayerPropSide,
    line,
    lineKey: lineToPlayerPropKey(line),
  };
}

export function isPlayerPropSelection(selection: string): boolean {
  return parsePlayerPropSelectionKey(selection) !== null;
}
