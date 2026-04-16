import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EurobetOddsService,
  EurobetSmokeReport,
} from '../src/services/EurobetOddsService';

type SmokeCliOptions = {
  competition: string;
  fixtures: Array<{ homeTeam: string; awayTeam: string; commenceTime?: string | null }>;
  includeExtendedGroups: boolean;
  verbose: boolean;
  reportFile: string;
  logFile: string;
};

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

function loadRootEnv(): void {
  const envPath = path.resolve(process.cwd(), '..', '.env');
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function parseFixtureSpec(spec: string): { homeTeam: string; awayTeam: string; commenceTime?: string | null } {
  const [homeTeamRaw, awayTeamRaw, commenceTimeRaw] = spec.split('|');
  const homeTeam = String(homeTeamRaw ?? '').trim();
  const awayTeam = String(awayTeamRaw ?? '').trim();
  const commenceTime = String(commenceTimeRaw ?? '').trim();

  if (!homeTeam || !awayTeam) {
    throw new Error(`Fixture non valida: "${spec}". Usa il formato homeTeam|awayTeam|commenceTime`);
  }

  return {
    homeTeam,
    awayTeam,
    commenceTime: commenceTime || null,
  };
}

function parseFixtureBlock(raw: string): Array<{ homeTeam: string; awayTeam: string; commenceTime?: string | null }> {
  return raw
    .split(/\r?\n|;/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseFixtureSpec);
}

function parseArgs(argv: string[]): SmokeCliOptions {
  const options: SmokeCliOptions = {
    competition: '',
    fixtures: [],
    includeExtendedGroups: false,
    verbose: false,
    reportFile: path.resolve(process.cwd(), 'artifacts', 'eurobet-smoke-report.json'),
    logFile: path.resolve(process.cwd(), 'artifacts', 'eurobet-smoke.log'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case '--competition':
        options.competition = String(argv[index + 1] ?? '').trim();
        index += 1;
        break;
      case '--fixture':
        options.fixtures.push(parseFixtureSpec(String(argv[index + 1] ?? '')));
        index += 1;
        break;
      case '--fixtures':
        options.fixtures.push(...parseFixtureBlock(String(argv[index + 1] ?? '')));
        index += 1;
        break;
      case '--includeExtendedGroups':
      case '--include-extended-groups':
        options.includeExtendedGroups = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--report-file':
        options.reportFile = path.resolve(process.cwd(), String(argv[index + 1] ?? '').trim());
        index += 1;
        break;
      case '--log-file':
        options.logFile = path.resolve(process.cwd(), String(argv[index + 1] ?? '').trim());
        index += 1;
        break;
      default:
        throw new Error(`Argomento non supportato: ${token}`);
    }
  }

  if (!options.competition) {
    throw new Error('Parametro obbligatorio mancante: --competition "Serie A"');
  }

  return options;
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

function createConsoleCapture(logFile: string, verbose: boolean): () => void {
  ensureParentDir(logFile);
  writeFileSync(logFile, '', 'utf8');

  const original: Record<ConsoleMethod, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const patch = (method: ConsoleMethod): void => {
    console[method] = (...args: unknown[]) => {
      const line = `[${new Date().toISOString()}] [${method.toUpperCase()}] ${formatLogArgs(args)}${'\n'}`;
      appendFileSync(logFile, line, 'utf8');
      if (verbose) {
        original[method](...args);
      }
    };
  };

  patch('log');
  patch('info');
  patch('warn');
  patch('error');

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  };
}

function writeReport(reportFile: string, report: EurobetSmokeReport): void {
  ensureParentDir(reportFile);
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  loadRootEnv();
  const options = parseArgs(process.argv.slice(2));
  const restoreConsole = createConsoleCapture(options.logFile, options.verbose);
  const service = new EurobetOddsService();
  let report: EurobetSmokeReport | null = null;

  try {
    report = await service.runSmokeReport(options.competition, {
      fixtures: options.fixtures,
      includeExtendedGroups: options.includeExtendedGroups,
    });

    writeReport(options.reportFile, report);
    appendFileSync(
      options.logFile,
      `[${new Date().toISOString()}] [SUMMARY] ${JSON.stringify({
        competition: report.competition,
        sourceUsed: report.sourceUsed,
        severity: report.severity,
        errorCategory: report.errorCategory,
        matchesFound: report.matchesFound,
        matchesWithBaseOdds: report.matchesWithBaseOdds,
        matchesWithExtendedGroups: report.matchesWithExtendedGroups,
        durationMs: report.durationMs,
      })}\n`,
      'utf8'
    );
  } finally {
    restoreConsole();
    await service.close().catch(() => undefined);
  }

  if (!report) {
    throw new Error('Smoke Eurobet non ha prodotto alcun report');
  }

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.errorCategory ? 1 : 0;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Eurobet smoke] ${message}`);
  process.exitCode = 1;
});
