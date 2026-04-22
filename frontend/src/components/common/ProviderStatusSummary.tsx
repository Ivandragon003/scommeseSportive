import React from 'react';
import { NormalizedProviderHealth } from '../../utils/systemObservability';

type ProviderStatusSummaryProps = {
  providerHealth: NormalizedProviderHealth;
  showSmoke?: boolean;
  testId?: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  eurobet: 'Eurobet',
  odds_api: 'Provider secondario',
};

const STATUS_LABELS: Record<string, string> = {
  healthy: 'OK',
  degraded: 'Parziale',
  unhealthy: 'Errore',
  disabled: 'Disabilitato',
  unknown: 'Sconosciuto',
};

const STATUS_BADGES: Record<string, string> = {
  healthy: 'fp-badge-green',
  degraded: 'fp-badge-gold',
  unhealthy: 'fp-badge-red',
  disabled: 'fp-badge-gray',
  unknown: 'fp-badge-gray',
};

const formatProviderName = (provider: string | null | undefined): string => {
  if (!provider) return 'n/d';
  return PROVIDER_LABELS[provider] ?? provider;
};

const formatOddsSource = (source: string | null | undefined): string => {
  if (!source) return 'n/d';
  if (source === 'eurobet+odds_api') return 'Eurobet + provider secondario';
  if (source === 'eurobet') return 'Eurobet';
  if (source === 'odds_api') return 'Provider secondario';
  if (source === 'unavailable') return 'Non disponibile';
  return source;
};

const formatDateTime = (value?: string | null): string => {
  if (!value) return 'n/d';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('it-IT');
};

const formatDuration = (value?: number | null): string => {
  if (value === null || value === undefined || value <= 0) return 'n/d';
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
};

const ProviderStatusSummary: React.FC<ProviderStatusSummaryProps> = ({
  providerHealth,
  showSmoke = true,
  testId = 'provider-status-summary',
}) => (
  <div data-testid={testId} style={{ display: 'grid', gap: 12 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <span className={`fp-badge ${STATUS_BADGES[providerHealth.status] ?? 'fp-badge-gray'}`}>
        {STATUS_LABELS[providerHealth.status] ?? providerHealth.status}
      </span>
      <span className="fp-badge fp-badge-gray" data-testid={`${testId}-primary-provider`}>
        Primario: {formatProviderName(providerHealth.primaryProvider)}
      </span>
      <span className="fp-badge fp-badge-blue" data-testid={`${testId}-active-provider`}>
        Attivo: {formatProviderName(providerHealth.activeProvider)}
      </span>
      {providerHealth.isMerged && (
        <span className="fp-badge fp-badge-gold">Merge mercati</span>
      )}
    </div>

    {Object.keys(providerHealth.providerHealth).length > 0 && (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(providerHealth.providerHealth).map(([provider, details]) => (
          <span
            key={provider}
            className={`fp-badge ${STATUS_BADGES[details.status] ?? 'fp-badge-gray'}`}
            data-testid={`${testId}-provider-${provider}`}
          >
            {formatProviderName(provider)}: {STATUS_LABELS[details.status] ?? details.status}
          </span>
        ))}
      </div>
    )}

    <div style={{ display: 'grid', gap: 8 }}>
      {[
        ['Sorgente quote', formatOddsSource(providerHealth.oddsSource)],
        ['Ultimo fetch', formatDateTime(providerHealth.fetchedAt)],
        ['Freshness', providerHealth.freshnessMinutes === null ? 'n/d' : `${providerHealth.freshnessMinutes}m`],
        ['Match con quota base', String(providerHealth.matchesWithBaseOdds)],
        ['Match con gruppi estesi', String(providerHealth.matchesWithExtendedGroups)],
      ].map(([label, value]) => (
        <div
          key={label}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            paddingBottom: 8,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ color: 'var(--text-2)' }}>{label}</span>
          <strong style={{ textAlign: 'right' }}>{value}</strong>
        </div>
      ))}
    </div>

    {providerHealth.fallbackReason && (
      <div className="fp-alert fp-alert-warning" data-testid={`${testId}-fallback-warning`}>
        Fallback attivo: {providerHealth.fallbackReason}
      </div>
    )}

    {showSmoke && providerHealth.lastSmokeRun && (
      <div className="fp-alert fp-alert-info" data-testid={`${testId}-smoke-run`}>
        Smoke Eurobet: <strong>{providerHealth.lastSmokeRun.severity}</strong>
        {' | '}ultima esecuzione {formatDateTime(providerHealth.lastSmokeRun.generatedAt)}
        {' | '}durata {formatDuration(providerHealth.lastSmokeRun.durationMs)}
        {providerHealth.lastSmokeRun.errorCategory ? ` | errore ${providerHealth.lastSmokeRun.errorCategory}` : ''}
      </div>
    )}
  </div>
);

export default ProviderStatusSummary;
