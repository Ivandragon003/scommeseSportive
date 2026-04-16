import { EurobetOddsMatch, EurobetOddsService } from '../EurobetOddsService';
import { OddsProviderAdapter, OddsProviderFetchResult, OddsProviderHealth, OddsProviderRequest } from './OddsProvider';

export class EurobetOddsProvider implements OddsProviderAdapter<EurobetOddsMatch> {
  private readonly service: EurobetOddsService;

  constructor(service?: EurobetOddsService) {
    this.service = service ?? new EurobetOddsService();
  }

  getProviderName(): string {
    return 'eurobet';
  }

  async getCompetitionOdds(request: OddsProviderRequest): Promise<OddsProviderFetchResult<EurobetOddsMatch>> {
    const matches = await this.service.getOdds(request.competition, {
      includeExtendedGroups: request.includeExtendedGroups,
    });

    return {
      matches,
      fetchedAt: new Date().toISOString(),
      fallbackReason: null,
      warnings: [],
    };
  }

  async getOddsForFixtures(request: OddsProviderRequest): Promise<OddsProviderFetchResult<EurobetOddsMatch>> {
    const fixtures = request.fixtures ?? [];
    const matches = await this.service.getOddsForFixtures(request.competition, fixtures, {
      includeExtendedGroups: request.includeExtendedGroups,
    });

    return {
      matches,
      fetchedAt: new Date().toISOString(),
      fallbackReason: null,
      warnings: [],
    };
  }

  async healthCheck(request: OddsProviderRequest): Promise<OddsProviderHealth> {
    const report = await this.service.runSmokeReport(request.competition, {
      fixtures: request.fixtures,
      includeExtendedGroups: false,
    });

    return {
      provider: this.getProviderName(),
      status: report.errorCategory
        ? 'unhealthy'
        : report.severity === 'degraded'
          ? 'degraded'
          : 'healthy',
      checkedAt: new Date().toISOString(),
      message: report.errorCategory ?? (report.warnings[0] ?? 'Eurobet operativo'),
      details: {
        sourceUsed: report.sourceUsed,
        matchesFound: report.matchesFound,
        durationMs: report.durationMs,
      },
    };
  }

  extractBestOdds(match: EurobetOddsMatch, preferredBookmaker = 'eurobet'): Record<string, number> {
    return this.service.extractBestOdds(match, preferredBookmaker);
  }

  compareBookmakers(match: EurobetOddsMatch): Record<string, Record<string, number>> {
    return this.service.compareBookmakers(match);
  }

  calculateMargin(match: EurobetOddsMatch, bookmakerKey: string): number | null {
    return this.service.calculateMargin(match, bookmakerKey);
  }

  getRuntimeMetadata(): Record<string, unknown> {
    return {};
  }

  async close(): Promise<void> {
    await this.service.close();
  }
}
