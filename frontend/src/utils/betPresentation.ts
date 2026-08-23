export const toAmount = (value: unknown) => Number(value ?? 0);

export const formatBetDateTime = (value: unknown) => {
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('it-IT');
};

export const formatBetMarketName = (value: unknown) => {
  const label = String(value ?? '').trim();
  if (!label) return 'Mercato non disponibile';
  return label
    .replace(/Draw No Bet/gi, 'Pareggio non conta (DNB)')
    .replace(/Goal\/Goal - Si/gi, 'Entrambe segnano - Sì')
    .replace(/Goal\/Goal - No/gi, 'Entrambe segnano - No');
};

export const getBetSelectionLabel = (value: unknown) => {
  const label = String(value ?? '').trim();
  if (!label) return null;
  const isInternalCode = /^(?:dnb_|player_|homeWin$|awayWin$|draw$|btts(?:No)?$|(?:under|over|yellow|shots|cards)[A-Z0-9_])/i.test(label);
  return isInternalCode ? null : label;
};

export const isLegacyBet = (bet: any) => String(bet?.data_quality ?? 'pre_fix').trim().toLowerCase() !== 'post_fix';

export const getBetSourceLabel = (value: unknown) => {
  const source = String(value ?? 'unknown').trim().toLowerCase();
  if (source === 'manual') return 'Inserimento manuale';
  if (source === 'automation') return 'Registrata dall’app';
  return 'Origine non verificata';
};

export const getBetStatus = (value: unknown) => {
  const status = String(value ?? 'PENDING').toUpperCase();
  if (status === 'WON') return { label: 'VINTA', className: 'won' };
  if (status === 'LOST') return { label: 'PERSA', className: 'lost' };
  if (status === 'VOID') return { label: 'ANNULLATA', className: 'void' };
  return { label: 'IN ATTESA', className: 'pending' };
};
