import React from 'react';
import { render, screen } from '@testing-library/react';
import ProviderStatusSummary from './ProviderStatusSummary';
import { NormalizedProviderHealth } from '../../utils/systemObservability';

const providerHealth: NormalizedProviderHealth = {
  status: 'degraded',
  primaryProvider: 'eurobet',
  fallbackProvider: 'odds_api',
  activeProvider: 'odds_api',
  oddsSource: 'odds_api',
  fallbackReason: 'Provider primario eurobet non disponibile, fallback odds_api attivo',
  providerHealth: {
    eurobet: { status: 'unhealthy', checkedAt: '2026-04-16T10:00:00.000Z', message: 'meeting_json_failed' },
    odds_api: { status: 'healthy', checkedAt: '2026-04-16T10:00:01.000Z', message: null },
  },
  fetchedAt: '2026-04-16T10:01:00.000Z',
  matchCount: 4,
  matchesWithBaseOdds: 3,
  matchesWithExtendedGroups: 1,
  marketCount: 18,
  durationMs: 12000,
  errorCategory: 'meeting_json_failed',
  warnings: ['fallback attivo'],
  warningCount: 1,
  isMerged: false,
  freshnessMinutes: 3,
  lastSmokeRun: {
    origin: 'local_artifact',
    competition: 'Serie A',
    generatedAt: '2026-04-16T10:05:00.000Z',
    freshnessMinutes: 2,
    severity: 'degraded',
    success: true,
    errorCategory: 'meeting_json_failed',
    sourceUsed: 'meeting-json',
    matchesFound: 4,
    matchesWithBaseOdds: 3,
    matchesWithExtendedGroups: 1,
    durationMs: 19000,
    warnings: ['dom fallback'],
  },
};

describe('ProviderStatusSummary', () => {
  test('renderizza badge provider primario e attivo', () => {
    render(<ProviderStatusSummary providerHealth={providerHealth} />);

    expect(screen.getByTestId('provider-status-summary-primary-provider').textContent).toContain('Eurobet');
    expect(screen.getByTestId('provider-status-summary-active-provider').textContent).toContain('Provider secondario');
    expect(screen.getByTestId('provider-status-summary-provider-eurobet').textContent).toContain('Eurobet: Errore');
    expect(screen.getByTestId('provider-status-summary-provider-odds_api').textContent).toContain('Provider secondario: OK');
  });

  test('mostra warning fallback e smoke run', () => {
    render(<ProviderStatusSummary providerHealth={providerHealth} />);

    expect(screen.getByTestId('provider-status-summary-fallback-warning').textContent).toContain('fallback odds_api attivo');
    expect(screen.getByTestId('provider-status-summary-smoke-run').textContent).toContain('Smoke Eurobet');
    expect(screen.getByTestId('provider-status-summary-smoke-run').textContent).toContain('meeting_json_failed');
  });
});
