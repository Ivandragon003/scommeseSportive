// Temporary pause: restore alongside PLAYER_AVAILABILITY_ENABLED in the backend.
export const PLAYER_DATA_ENABLED =
  String(process.env.REACT_APP_PLAYER_DATA_ENABLED ?? 'false').trim().toLowerCase() === 'true';

export const PLAYER_AVAILABILITY_ENABLED =
  PLAYER_DATA_ENABLED && String(process.env.REACT_APP_PLAYER_AVAILABILITY_ENABLED ?? 'false').trim().toLowerCase() === 'true';
