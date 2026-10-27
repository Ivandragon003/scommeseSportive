import { finiteNumber, isTimestamp } from './researchPresentation';

export const oddsProviderLabel = (value: string): string => ({ odds_api: 'The Odds API' }[value] || value);

export const oddsStatusLabel = (value: string): string => ({
  OK: 'Recuperi riusciti registrati', DEGRADED: 'Errori registrati nel periodo',
  UNOBSERVED: 'Non osservato', REQUESTS_INFLIGHT: 'Richieste prenotate in corso',
  CONFIGURED_NOT_PROBED: 'Configurato, verifica non eseguita', NOT_CONFIGURED: 'Non configurato',
  UNAVAILABLE: 'Non disponibile', DISABLED: 'Disabilitato',
}[value] || value);

export const oddsEventLabel = (value: string): string => ({
  CACHE_HIT: 'Risposta da cache', FETCH_SUCCESS: 'Recupero riuscito', FETCH_FAILED: 'Recupero fallito',
  DENIED: 'Richiesta non ammessa', LEASE_EXPIRED: 'Prenotazione scaduta', LATE_RESPONSE: 'Risposta tardiva',
}[value] || value);

export const oddsReasonLabel = (value: string | null): string => value ? ({
  odds_cache_only: 'Consentita solo la cache: nessuna nuova richiesta inviata.',
  odds_reset_unconfirmed: 'Reset della quota non confermato dal gestore.',
  odds_credit_budget_exhausted: 'Budget prudenziale di crediti insufficiente.',
  odds_request_inflight_timeout: 'Attesa di una richiesta già in corso scaduta.',
  lease_expired_unknown: 'Esito di una richiesta precedente non verificabile.',
  odds_transport_failed: 'Recupero quote non riuscito.',
  odds_lease_lost: 'Risposta arrivata dopo la scadenza della prenotazione.',
}[value] || value) : 'Nessun motivo aggiuntivo registrato.';

export const oddsOperationLabel = (value: string): string => value === 'unattributed' ? 'Funzione non attribuita' : value;

export const utcDateTime = (value: unknown): string => isTimestamp(value)
  ? `${new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`
  : 'Non disponibile';

export const validCacheRate = (value: unknown): value is number => finiteNumber(value) && value >= 0 && value <= 1;

export const oddsLimitationLabel = (value: string): string => {
  if (value.startsWith('UTC calendar months are a local planning policy')) {
    return 'Il calendario mensile UTC è una convenzione locale di pianificazione. Il fuso del reset del provider non è confermato: il gestore richiede una nuova verifica della quota prima delle richieste che consumano crediti.';
  }
  if (value.startsWith('Unknown failures retain their estimated charge')) {
    return 'Gli errori senza costo misurabile mantengono l’addebito stimato, per evitare di sovrastimare il budget.';
  }
  if (value.startsWith('A fresh full allowance')) {
    return 'Una misura recente di quota intera può autorizzare la pianificazione del nuovo mese. Da sola non dimostra che sia avvenuto un reset del provider.';
  }
  if (value.startsWith('Usage is grouped by the complete market bundle')) {
    return 'Il consumo riguarda l’intero insieme di mercati di ogni richiesta. I crediti condivisi non vengono ripartiti artificialmente sui singoli mercati.';
  }
  if (value.startsWith('History is preserved; the overview reads the last 90 days')) {
    return 'Lo storico resta conservato. Questa vista considera gli ultimi 90 giorni e al massimo 100 gruppi.';
  }
  return value;
};
