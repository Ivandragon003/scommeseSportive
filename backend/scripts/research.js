/* Reproducible local/cloud research CLI. No provider requests or betting writes. */
const { createClient } = require('@libsql/client');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

function argumentsOf(argv) {
  const out = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('Expected --option value');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const load = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
function save(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
  return target;
}
function client() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL required; export only performs SELECT');
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}
async function main() {
  const args = argumentsOf(process.argv.slice(2));
  if (args.command === 'export') {
    if (!args.out) throw new Error('--out required');
    const db = client();
    try {
      // A standalone read connection avoids application bootstrap/migrations on production.
      const result = await db.execute(`SELECT match_id,home_team_id,away_team_id,date,competition,season,
        home_goals,away_goals,home_xg,away_xg,home_shots,away_shots,home_shots_on_target,away_shots_on_target,
        home_yellow_cards,away_yellow_cards,home_red_cards,away_red_cards,home_fouls,away_fouls
        FROM matches WHERE competition IN ('Serie A','Premier League','La Liga','Bundesliga','Ligue 1')
        ORDER BY date,match_id`);
      const names = { homeXg: 'homeXG', awayXg: 'awayXG', homeShots: 'homeTotalShots', awayShots: 'awayTotalShots' };
      const matches = result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
        const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        return [names[camel] || camel, typeof value === 'bigint' ? Number(value) : value];
      })));
      save(args.out, matches);
      console.log(JSON.stringify({ action: 'read_only_export', matches: matches.length,
        completed: matches.filter((row) => row.homeGoals != null && row.awayGoals != null).length,
        byLeague: Object.fromEntries([...new Set(matches.map((row) => row.competition))].map((league) =>
          [league, matches.filter((row) => row.competition === league).length])) }));
    } finally { db.close(); }
    return;
  }
  if (args.command === 'dataset') {
    if (!args.input || !args.out || !args.asof) throw new Error('--input, --out, --asof required');
    const { buildTrainingDataset } = require('../dist/research/ForecastCore');
    const dataset = buildTrainingDataset(load(args.input), args.asof);
    save(args.out, dataset);
    console.log(JSON.stringify({ rows: dataset.rows.length, exclusions: dataset.exclusions,
      baselineVersion: dataset.baselineManifest.version, asOf: dataset.asOf }));
    return;
  }
  if (args.command === 'train') {
    if (!args.input || !args.out) throw new Error('--input, --out required');
    const result = spawnSync(args.python || process.env.RESEARCH_PYTHON || 'python', [resolve(__dirname, '../ml/train.py'),
      '--input', resolve(args.input), '--output', resolve(args.out), '--folds', args.folds || '3',
      '--iterations', args.iterations || '120', '--depth', args.depth || '5'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`CatBoost training failed (${result.status})`);
    return;
  }
  if (args.command === 'evaluate') {
    if (!args.input || !args.out) throw new Error('--input evaluation-rows.json and --out required');
    const { evaluateResearchBenchmark } = require('../dist/research/ResearchEvaluation');
    const report = evaluateResearchBenchmark(load(args.input));
    save(args.out, report);
    console.log(JSON.stringify({ conclusion: report.conclusion, samples: report.A?.n, exclusions: report.exclusions }));
    return;
  }
  if (args.command === 'validate-market' || args.command === 'register-market') {
    if (!args.input || !args.out) throw new Error('--input market-observations.json and --out report.json required');
    const { evaluateMarketValidation } = require('../dist/research/MarketValidationEngine');
    const input = load(args.input);
    let db;
    try {
      if (args.command === 'register-market') {
        const { DatabaseService } = require('../dist/db/DatabaseService');
        db = new DatabaseService();
        // Approval comes from the persistent registry, never an input-file boolean.
        delete input.registryApproval;
        const champion = await db.research.getChampion(input.plan.family);
        if (champion?.version === input.plan.modelVersion) {
          const benchmarks = await db.research.listBenchmarks({ family: input.plan.family, limit: 10000 });
          const event = (await db.research.listModelEvents(input.plan.family)).find((row) =>
            row.version === champion.version && row.benchmarkId === champion.benchmarkId);
          const benchmark = benchmarks.find((row) => row.id === champion.benchmarkId);
          if (event && benchmark) input.registryApproval = { model: champion, benchmark, event };
        }
        input.previousState = (await db.research.listMarkets({ family: input.plan.family,
          modelVersion: input.plan.modelVersion })).find((row) => row.market === input.plan.market)?.state;
      }
      const report = evaluateMarketValidation(input);
      save(args.out, report);
      if (db) {
        const benchmark = await db.research.saveBenchmark({ family: input.plan.family,
          modelVersion: input.plan.modelVersion, report });
        await db.research.setMarketState({ family: input.plan.family, modelVersion: input.plan.modelVersion,
          market: input.plan.market, state: report.state, evidence: { benchmarkId: benchmark.id,
            modelBenchmarkId: report.modelBenchmarkId }, reason: report.reasons.map((item) => item.code).join(', ') });
      }
      console.log(JSON.stringify({ state: report.state, reasons: report.reasons, registryWrites: !!db }));
    } finally { if (db) await db.close(); }
    return;
  }
  throw new Error('Commands: export, dataset, train, evaluate, validate-market, register-market. All commands require explicit --input/--out paths except export. See docs/research-platform.md.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
