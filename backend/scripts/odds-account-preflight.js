// Read-only account preparation. No provider transport, service/store construction or schema bootstrap.
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { fileURLToPath } = require('node:url');

const QUERIES = {
  current: `SELECT measured_used, measured_remaining, header_charged_anchor, header_observed_at, reset_confirmed
    FROM smart_odds_budgets WHERE provider=? AND account_scope=? AND month=?`,
  prior: `SELECT month, measured_used, measured_remaining, reset_confirmed FROM smart_odds_budgets
    WHERE provider=? AND account_scope=? AND month<? ORDER BY month DESC LIMIT 1`,
  usage: `SELECT COUNT(*) AS requests,
    COALESCE(SUM(CASE WHEN s.request_id IS NOT NULL THEN s.charged_credits ELSE 0 END),0) AS charged,
    COALESCE(SUM(CASE WHEN s.request_id IS NULL THEN r.expected_credits ELSE 0 END),0) AS reserved,
    COALESCE(SUM(CASE WHEN s.request_id IS NOT NULL AND s.measured_cost IS NULL THEN s.charged_credits ELSE 0 END),0) AS unknown_charged,
    COALESCE(SUM(r.expected_credits),0) AS planned,
    COALESCE(SUM(s.measured_cost),0) AS measured,
    MAX(s.finished_at) AS last_result
    FROM smart_odds_requests r LEFT JOIN smart_odds_results s ON s.request_id=r.id
    WHERE r.provider=? AND r.account_scope=? AND r.month=?`,
  carryover: `SELECT COALESCE(SUM(CASE WHEN s.request_id IS NULL THEN r.expected_credits ELSE s.charged_credits END),0) AS credits
    FROM smart_odds_requests r LEFT JOIN smart_odds_results s ON s.request_id=r.id
    WHERE r.provider=? AND r.account_scope=? AND r.month<? AND (s.request_id IS NULL OR s.finished_at>=?)`,
};
const targetFingerprint = (url) => createHash('sha256').update(String(url).trim()).digest('hex');
const number = (value) => value !== null && value !== undefined && String(value).trim() !== ''
  && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function validateTarget(env, suppliedSha256) {
  const url = String(env.TURSO_DATABASE_URL ?? '').trim();
  if (!url || !suppliedSha256 || suppliedSha256 !== targetFingerprint(url)) throw new Error('odds_account_target_mismatch');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('odds_account_target_invalid'); }
  if (!['libsql:', 'https:', 'file:'].includes(parsed.protocol)) throw new Error('odds_account_target_invalid');
  if (parsed.protocol === 'file:') {
    let file;
    try { file = fileURLToPath(parsed); } catch { throw new Error('odds_account_local_target_invalid'); }
    if (!existsSync(file)) throw new Error('odds_account_local_target_missing');
  }
  return url;
}

async function selectOnly(client, statement) {
  const sql = typeof statement === 'string' ? statement : statement.sql;
  if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error('odds_account_select_only');
  return client.execute(statement);
}

async function readAccountSnapshot(client, env, now) {
  const scope = String(env.ODDS_API_ACCOUNT_SCOPE ?? '').trim() || 'primary';
  const month = now.toISOString().slice(0, 7);
  const args = ['odds_api', scope, month];
  const current = (await selectOnly(client, { sql: QUERIES.current, args })).rows[0] ?? null;
  const prior = (await selectOnly(client, { sql: QUERIES.prior, args })).rows[0] ?? null;
  const usage = (await selectOnly(client, { sql: QUERIES.usage, args })).rows[0] ?? {};
  const carryover = (await selectOnly(client, { sql: QUERIES.carryover, args: [...args, `${month}-01T00:00:00.000Z`] })).rows[0] ?? {};
  const observedAt = typeof current?.header_observed_at === 'string' ? current.header_observed_at : null;
  const headerMs = observedAt ? Date.parse(observedAt) : NaN;
  const validHeaderTime = Number.isFinite(headerMs) && headerMs <= now.getTime();
  const keyConfigured = Boolean(String(env.ODDS_API_KEY ?? '').trim());
  const resetConfirmed = current ? Number(current.reset_confirmed) === 1 : null;
  const observedUsed = number(current?.measured_used);
  const observedRemaining = number(current?.measured_remaining);
  const hasHeader = validHeaderTime && (observedUsed !== null || observedRemaining !== null);
  const reasons = [];
  if (!keyConfigured) reasons.push('odds_key_missing');
  if (!current) reasons.push('configured_scope_current_month_missing');
  if (current && !resetConfirmed) reasons.push('reset_unconfirmed');
  if (!hasHeader) reasons.push('usable_header_observation_missing');
  if (number(usage.unknown_charged) > 0) reasons.push('unknown_charges_present');
  // Reset gate mirrors admission, but no request cost, allowance or live balance is inferred here.
  const resetGate = current ? resetConfirmed ? 'confirmed_in_stored_state' : 'paid_network_blocked_until_reset_confirmation'
    : prior ? 'would_inherit_prior_month_with_reset_unconfirmed' : 'no_prior_budget_reset_gate_not_evaluated';
  return {
    configuredScope: scope, month, keyConfigured, accountIdentity: 'UNCONFIRMED',
    status: !current ? 'CURRENT_MONTH_MISSING' : !resetConfirmed ? 'RESET_UNCONFIRMED'
      : !hasHeader ? 'HEADER_UNAVAILABLE' : 'HISTORICAL_OBSERVATION_ONLY',
    reasons, currentMonthRecordPresent: Boolean(current), resetConfirmed, resetGate,
    observation: {
      kind: 'STORED_HEADER_OBSERVATION_ONLY', observedAt,
      headerAgeSeconds: validHeaderTime ? (now.getTime() - headerMs) / 1000 : null,
      headerTimestampValid: validHeaderTime,
      observedUsed, observedRemaining,
    },
    ledger: {
      requests: number(usage.requests), chargedCredits: number(usage.charged), reservedCredits: number(usage.reserved),
      unknownChargedCredits: number(usage.unknown_charged), measuredCredits: number(usage.measured),
      plannedCredits: number(usage.planned), carryoverCredits: number(carryover.credits),
      lastResultAt: typeof usage.last_result === 'string' ? usage.last_result : null,
    },
    priorMonthRecord: prior ? { month: String(prior.month) } : null,
    paidNetworkAuthorized: false, liveBalanceVerified: false, cycleBudgetSufficiencyVerified: false,
  };
}

async function oddsAccountPreflight(options = {}, dependencies = {}) {
  const env = options.env ?? process.env;
  const url = validateTarget(env, options.targetSha256);
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('odds_account_cutoff_invalid');
  // Client creation happens only after the explicit target check. No application class is loaded.
  const createClient = dependencies.createClient ?? require('@libsql/client').createClient;
  const client = createClient({ url, authToken: env.TURSO_AUTH_TOKEN });
  try {
    const account = await readAccountSnapshot(client, env, now);
    return {
      mode: 'read-only-plan', asOf: now.toISOString(), targetSha256: options.targetSha256,
      ...account, databaseReads: 4, databaseWrites: 0, providerRequests: 0,
      nextCheck: { script: 'backend/scripts/probe-odds-quota.js', invoked: false,
        requiresSeparateInvocation: true,
        purpose: 'Inspect the configured key response and quota headers through the separate documented zero-credit probe.' },
      limitations: [
        'Configured scope is a local ledger namespace, not proof of which provider account owns the configured key.',
        'Used and remaining are historical observations; this plan does not calculate or certify a live spendable balance.',
        'A missing month alone does not prove exhausted credit; prior-month inheritance can require a reset confirmation before paid network requests.',
        'Cache-only reads are distinct from paid network admission. Planned credits are not billed credits.',
      ],
    };
  } catch {
    throw new Error('odds_account_read_failed');
  } finally { client.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => ['--execute', '--probe', '--authorize-paid-calls'].includes(arg))) throw new Error('odds_account_plan_only');
  const index = args.indexOf('--target-sha256');
  const result = await oddsAccountPreflight({ targetSha256: index < 0 ? undefined : args[index + 1] });
  console.log(JSON.stringify(result));
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ mode: 'read-only-plan', ok: false,
    code: /^odds_account_[a-z_]+$/.test(error.message) ? error.message : 'odds_account_failed',
    databaseWrites: 0, providerRequests: 0 }));
  process.exitCode = 1;
});

module.exports = { QUERIES, targetFingerprint, validateTarget, selectOnly, readAccountSnapshot, oddsAccountPreflight };
