import React from 'react';
import { render, screen } from '@testing-library/react';
import ProviderStatusSummary from './ProviderStatusSummary';
import { NormalizedProviderHealth } from '../../utils/systemObservability';

const providerHealth: NormalizedProviderHealth = {
  status: 'healthy',
  primaryProvider: 'odds_api',
  fallbackProvider: null,
  activeProvider: 'odds_api',
  oddsSource: 'odds_api',
  fallbackReason: null,
  providerHealth: {
    odds_api: { status: 'healthy', checkedAt: '2026-04-16T10:00:01.000Z', message: null },
  },
  fetchedAt: '2026-04-16T10:01:00.000Z',
  matchCount: 4,
  matchesWithBaseOdds: 3,
  matchesWithExtendedGroups: 1,
  marketCount: 18,
  durationMs: 12000,
  errorCategory: null,
  warnings: [],
  warningCount: 0,
  isMerged: false,
  freshnessMinutes: 3,
};

describe('ProviderStatusSummary', () => {
  test('renderizza badge provider primario e attivo', () => {
    render(<ProviderStatusSummary providerHealth={providerHealth} />);

    expect(screen.getByTestId('provider-status-summary-primary-provider').textContent).toContain('Odds API');
    expect(screen.getByTestId('provider-status-summary-active-provider').textContent).toContain('Odds API');
    expect(screen.getByTestId('provider-status-summary-provider-odds_api').textContent).toContain('Odds API: OK');
  });

  test('mostra warning provider quando presente', () => {
    render(<ProviderStatusSummary providerHealth={{
      ...providerHealth,
      fallbackReason: 'Provider quote non disponibile temporaneamente',
    }} />);

    expect(screen.getByTestId('provider-status-summary-fallback-warning').textContent).toContain('Provider quote non disponibile');
  });
});
