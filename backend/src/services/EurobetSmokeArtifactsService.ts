import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { EurobetSmokeReport } from './EurobetOddsService';

export type EurobetSmokeRunSummary = {
  origin: 'local_artifact';
  competition: string;
  generatedAt: string;
  freshnessMinutes: number;
  severity: EurobetSmokeReport['severity'];
  success: boolean;
  errorCategory: EurobetSmokeReport['errorCategory'];
  sourceUsed: EurobetSmokeReport['sourceUsed'];
  matchesFound: number;
  matchesWithBaseOdds: number;
  matchesWithExtendedGroups: number;
  durationMs: number;
  warnings: string[];
  reportPath: string;
  logPath: string;
};

export const EUROBET_SMOKE_ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts');
export const EUROBET_SMOKE_REPORT_FILENAME = 'eurobet-smoke-report.json';
export const EUROBET_SMOKE_LOG_FILENAME = 'eurobet-smoke.log';

export const getEurobetSmokeReportPath = (): string =>
  path.join(EUROBET_SMOKE_ARTIFACTS_DIR, EUROBET_SMOKE_REPORT_FILENAME);

export const getEurobetSmokeLogPath = (): string =>
  path.join(EUROBET_SMOKE_ARTIFACTS_DIR, EUROBET_SMOKE_LOG_FILENAME);

export const ensureEurobetSmokeArtifactsDir = (): void => {
  mkdirSync(EUROBET_SMOKE_ARTIFACTS_DIR, { recursive: true });
};

export const resolveEurobetSmokeArtifactPath = (input: string | undefined, fallbackName: string): string => {
  ensureEurobetSmokeArtifactsDir();
  const fileName = path.basename(String(input ?? '').trim() || fallbackName);
  return path.join(EUROBET_SMOKE_ARTIFACTS_DIR, fileName);
};

export const readLastEurobetSmokeRun = (): EurobetSmokeRunSummary | null => {
  const reportPath = getEurobetSmokeReportPath();
  const logPath = getEurobetSmokeLogPath();
  if (!existsSync(reportPath)) return null;

  try {
    const raw = readFileSync(reportPath, 'utf8');
    const parsed = JSON.parse(raw) as EurobetSmokeReport;
    const stat = statSync(reportPath);
    const generatedAt = stat.mtime.toISOString();
    const freshnessMinutes = Math.max(0, Math.round((Date.now() - stat.mtime.getTime()) / 60000));

    return {
      origin: 'local_artifact',
      competition: String(parsed.competition ?? ''),
      generatedAt,
      freshnessMinutes,
      severity: parsed.severity,
      success: Boolean(parsed.success),
      errorCategory: parsed.errorCategory ?? null,
      sourceUsed: parsed.sourceUsed ?? null,
      matchesFound: Number(parsed.matchesFound ?? 0),
      matchesWithBaseOdds: Number(parsed.matchesWithBaseOdds ?? 0),
      matchesWithExtendedGroups: Number(parsed.matchesWithExtendedGroups ?? 0),
      durationMs: Number(parsed.durationMs ?? 0),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
      reportPath,
      logPath,
    };
  } catch {
    return null;
  }
};
