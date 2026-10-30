/* Manual preparation only: no claims, execution records, wallet initialization or settlement. */
const { createHash } = require('node:crypto');
const { EXPECTED_HOST } = require('./probe-research-ml-runtime');

const TOP5 = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
const FINANCIAL_QUERIES = {
  research_bets: 'SELECT id,decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,placed_at FROM research_bets ORDER BY id',
  research_ledger: 'SELECT id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at FROM research_ledger ORDER BY id',
  research_settlements: 'SELECT bet_id,multiplier,return_cents,settled_at FROM research_settlements ORDER BY bet_id',
  bets: 'SELECT bet_id,odds,stake,status,return_amount,profit,placed_at,settled_at FROM bets ORDER BY bet_id',
  budgets: 'SELECT user_id,total_budget,available_budget,total_bets,total_staked,total_won,total_lost,roi,win_rate,updated_at FROM budgets ORDER BY user_id',
  budget_sessions: 'SELECT session_id,initial_budget,status,started_at,ended_at FROM budget_sessions ORDER BY session_id',
  research_execution_jobs: 'SELECT id,match_id,policy_hash,run_id,status,updated_at FROM research_execution_jobs ORDER BY id',
  research_execution_inputs: 'SELECT id,job_id,origin_input_id,input_hash,decisions_hash,captured_at FROM research_execution_inputs ORDER BY id',
  research_execution_decisions: 'SELECT id,input_id,origin_decision_id,family,model_version,action,created_at FROM research_execution_decisions ORDER BY id',
};
const SAFE_REASONS = new Set(['recommended_virtual_preview', 'not_recommended', 'origin_records_missing',
  'app_no_recommendation', 'app_prediction_unavailable', 'invalid_app_recommendation_packet',
  'app_recommendation_quote_mismatch', 'invalid_app_recommendation_value', 'real_fresh_quotes_unavailable',
  'research_forecast_unavailable', 'challenger_no_recommendation', 'challenger_technical_validation_failed',
  'challenger_model_version_mismatch', 'challenger_pipeline_mismatch', 'challenger_configuration_mismatch',
  'challenger_configuration_unavailable', 'challenger_incoherent_probabilities',
  'non_binary_payout_not_supported_by_canonical_engine', 'stale_quote', 'future_quote',
  'real_quote_missing', 'invalid_decimal_odds', 'real_quote_required', 'quote_time_missing',
  'real_prematch_quote_required', 'unsupported_quote_settlement']);
const ordered = (value) => typeof value === 'bigint' ? value.toString() : Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const hash = (value) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const codeOf = (reason) => SAFE_REASONS.has(reason) ? reason : 'not_recommended';
const versionOf = (value) => typeof value === 'string' && /^(?:APP-A|C)-[a-f0-9]{8,64}$/.test(value) ? value : 'unavailable';
class PreviewFailure extends Error { constructor(code) { super(code); this.code = code; } }
const fail = (code) => { throw new PreviewFailure(code); };

async function financialSnapshot(db) {
  const portfolios = await db.research.listPortfolios();
  const compact = portfolios.map((row) => ({ id: row.id, family: row.family,
    availableCents: Number(row.availableCents), committedCents: Number(row.committedCents), equityCents: Number(row.equityCents) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const tables = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((row) => String(row.name)));
  const summary = { portfolios: { count: compact.length, sha256: hash(compact) } };
  for (const [table, sql] of Object.entries(FINANCIAL_QUERIES)) {
    if (!tables.has(table)) {
      if (['research_bets', 'research_ledger', 'research_settlements'].includes(table)) fail('preview_financial_schema_missing');
      summary[table] = { present: false, count: 0, sha256: hash([]) }; continue;
    }
    const rows = (await db.execute(sql)).rows;
    summary[table] = { present: true, count: rows.length, sha256: hash(rows) };
  }
  return { summary, portfolios: compact };
}

async function quotaSnapshot(db, env, now) {
  const args = ['odds_api', env.ODDS_API_ACCOUNT_SCOPE?.trim() || 'primary', now.toISOString().slice(0, 7)];
  const budget = (await db.execute(`SELECT measured_used,measured_remaining FROM smart_odds_budgets
    WHERE provider=? AND account_scope=? AND month=?`, args)).rows[0];
  const costs = (await db.execute(`SELECT COUNT(*) AS requests,COALESCE(SUM(s.charged_credits),0) AS charged,
    COALESCE(SUM(s.measured_cost),0) AS measured FROM smart_odds_requests r LEFT JOIN smart_odds_results s ON s.request_id=r.id
    WHERE r.provider=? AND r.account_scope=? AND r.month=?`, args)).rows[0];
  const number = (value) => value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  return { requests: number(costs?.requests), chargedCredits: number(costs?.charged), measuredCredits: number(costs?.measured),
    observedUsed: number(budget?.measured_used), observedRemaining: number(budget?.measured_remaining) };
}

async function previewRecommendations(options = {}) {
  const env = options.env ?? process.env, clock = options.clock ?? (() => new Date());
  let db, before, after, stage = 'preview_configuration_invalid';
  try {
    const url = new URL(env.TURSO_DATABASE_URL || '');
    if (url.hostname !== EXPECTED_HOST || !['libsql:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)
      || !String(env.TURSO_AUTH_TOKEN ?? '').trim() || !String(env.ODDS_API_KEY ?? '').trim()
      || env.RESEARCH_T15_SCHEDULER_ENABLED === 'true'
      || (env.RESEARCH_NIGHTLY_MINUTE !== undefined && env.RESEARCH_NIGHTLY_MINUTE !== '7')) fail(stage);
    const started = clock(); if (!Number.isFinite(started.getTime())) fail(stage);
    const nextBoundary = options.nextBoundary ?? require('../dist/research/ResearchNightly').nextNightlyBoundary;
    const windowEndAt = nextBoundary(started, 3, 7).toISOString();
    stage = 'preview_database_unavailable';
    const createDatabase = options.createDatabase ?? ((settings) => new (require('../dist/db/DatabaseService').DatabaseService)(settings));
    db = await createDatabase({ skipSchemaBootstrap: true });
    stage = 'preview_financial_read_failed'; before = await financialSnapshot(db);
    const equities = new Map(before.portfolios.map((row) => [row.id, row.equityCents]));
    if (!['shadow_A', 'shadow_C'].every((id) => Number.isSafeInteger(equities.get(id)) && equities.get(id) > 0)) fail('preview_existing_wallets_required');
    stage = 'preview_quota_read_failed'; const quotaBefore = await quotaSnapshot(db, env, started);
    const records = [], skipped = [];
    let inferredA = 0, inferredC = 0;
    try {
      stage = 'preview_origin_read_failed';
      const fixtures = (await db.getUpcomingMatches({ nowIso: started.toISOString(), untilIso: windowEndAt, limit: 160 }))
        .filter((row) => TOP5.includes(row.competition) && row.home_goals == null && row.away_goals == null
          && Number.isFinite(Date.parse(row.date)) && Date.parse(row.date) > started.getTime() && Date.parse(row.date) <= Date.parse(windowEndAt))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.match_id.localeCompare(b.match_id)).slice(0, 10);
      const jobs = fixtures.length ? await db.research.listJobs() : [];
      let runtime;
      for (const fixture of fixtures) {
        const origin = jobs.find((job) => job.matchId === fixture.match_id);
        const decisions = origin ? await db.research.listDecisions({ jobId: origin.id }) : [];
        const a = decisions.find((row) => row.family === 'A'), c = decisions.find((row) => row.family === 'C');
        if (!origin || !a?.id || !c?.id || !a.inputId || a.inputId !== c.inputId) {
          skipped.push({ matchId: fixture.match_id, reason: 'origin_records_missing' }); continue;
        }
        if (!runtime) {
          const createRuntime = options.createRuntime ?? ((database) => new (require('../dist/research/ResearchRecommendationRuntime').ResearchRecommendationRuntime)(database));
          runtime = createRuntime(db);
          runtime.beginCohort(String(env.GITHUB_RUN_ID || origin.runId || origin.id));
        }
        stage = 'preview_preparation_failed';
        // Real immutable origin identifiers provide lineage. This adapter is never claimed or committed.
        const item = await runtime.prepare({ ...origin, id: origin.id, matchId: fixture.match_id, kickoffAt: fixture.date,
          runId: String(env.GITHUB_RUN_ID || origin.runId || origin.id), leaseToken: origin.leaseToken ?? '',
          windowStartAt: started.toISOString(), windowEndAt, preview: true,
          originInputId: a.inputId, originDecisionIds: { A: a.id, C: c.id } });
        if (item.jobId !== origin.id || item.originInputId !== a.inputId) fail('preview_origin_identity_invalid');
        const forecasts = item.inputSnapshot?.forecasts;
        if (forecasts?.A?.model?.source === 'PredictionService'
          && [forecasts.A.model.codeHash, forecasts.A.model.configHash, forecasts.A.model.stateHash]
            .every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) inferredA++;
        if (forecasts?.C?.decision?.validated === true && forecasts.C.recommendation != null) inferredC++;
        for (const family of ['A', 'C']) {
          const decision = item.decisions.find((row) => row.family === family);
          if (!decision) fail('preview_decision_missing');
          const recommended = decision.action === 'BET' && decision.recommended === true && decision.validated === true
            && Number.isFinite(decision.ev) && decision.ev > 0 && Number.isFinite(decision.probability)
            && decision.probability > 0 && decision.probability < 1;
          if (decision.action === 'BET' && !recommended) fail('preview_recommendation_invalid');
          const percent = family === 'C' ? 1 : Number(decision.suggestedStakePercent ?? 0);
          if (recommended && (!Number.isFinite(percent) || percent <= 0 || percent > 5)) fail('preview_stake_invalid');
          const quote = decision.quote, observed = Date.parse(item.inputSnapshot.observedAt);
          const fresh = !!quote && Number.isFinite(observed) && [quote.capturedAt, quote.updatedAt].every((value) =>
            Number.isFinite(Date.parse(value)) && Date.parse(value) <= observed && observed - Date.parse(value) <= 300000);
          const real = !!quote && quote.source === 'odds_api' && quote.priceType === 'prematch'
            && Number.isFinite(quote.odds) && quote.odds > 1 && !!String(quote.bookmaker ?? '').trim();
          if (recommended && (!fresh || !real)) fail('preview_recommendation_quote_invalid');
          records.push({ matchId: fixture.match_id, family, recommended, stakePercent: percent,
            intendedCents: recommended ? Math.floor(equities.get(`shadow_${family}`) * Math.round(percent * 100) / 10000) : 0,
            confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(decision.confidence) ? decision.confidence : null,
            reason: codeOf(decision.reason ?? (recommended ? 'recommended_virtual_preview' : 'not_recommended')),
            sourceVersion: versionOf(decision.modelVersion), fresh, real, originVerified: true });
        }
      }
    } finally {
      const previousStage = stage;
      stage = 'preview_financial_verification_failed'; after = await financialSnapshot(db);
      if (hash(before.summary) !== hash(after.summary)) fail('preview_financial_state_changed');
      stage = previousStage;
    }
    stage = 'preview_quota_read_failed'; const quotaAfter = await quotaSnapshot(db, env, clock());
    return { ok: true, mode: 'recommendations-preview', startedAt: started.toISOString(), windowEndAt,
      checkedMatches: records.length / 2, skipped, records, inference: { A: inferredA, C: inferredC },
      financialBefore: before.summary, financialAfter: after.summary, financialUnchanged: true, executionRowsCreated: 0,
      quota: { before: quotaBefore, after: quotaAfter, scope: 'shared_account_deltas_not_exclusive_attribution' },
      registeredBets: 0, prospectiveCycleVerified: false };
  } catch (error) {
    throw error instanceof PreviewFailure ? error : new PreviewFailure(stage);
  } finally {
    if (db) { try { await db.close(); } catch { fail('preview_close_failed'); } }
  }
}

async function main(options = {}) {
  const log = options.log ?? console.log.bind(console), error = options.error ?? console.error.bind(console);
  const methods = ['log', 'info', 'warn', 'error'], previous = methods.map((name) => console[name]);
  try {
    // Ordinary service diagnostics are unnecessary here. Never forward raw driver/provider exceptions or packets.
    methods.forEach((name) => { console[name] = () => {}; });
    const report = await previewRecommendations(options);
    log(JSON.stringify(report)); return 0;
  } catch (failure) {
    error(JSON.stringify({ ok: false, mode: 'recommendations-preview',
      code: failure instanceof PreviewFailure ? failure.code : 'preview_failed', registeredBets: 0 })); return 1;
  } finally { methods.forEach((name, index) => { console[name] = previous[index]; }); }
}

if (require.main === module) main().then((code) => { process.exitCode = code; })
  .catch(() => { console.error('{"ok":false,"code":"preview_failed"}'); process.exitCode = 1; });
module.exports = { previewRecommendations, financialSnapshot, main, FINANCIAL_QUERIES };
