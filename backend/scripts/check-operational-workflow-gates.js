const { readFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const CALIBRATION_GATE = "github.event_name == 'workflow_dispatch' && inputs.authorize_database_writes == true && vars.OPERATIONAL_CALIBRATION_ENABLED == 'true'";
const COLLECTION_GATE = "vars.MODEL_A_PROSPECTIVE_COLLECTION_ENABLED == 'true' && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.authorize_collection == true))";
const MONITORING_STEP_GATE = "${{ always() && env.MODEL_A_PROSPECTIVE_MONITORING_ENABLED == 'true' }}";
const PUBLICATION_EVENTS = ['push', 'pull_request', 'pull_request_target'];
const SUPPORTED_EVENTS = [...PUBLICATION_EVENTS, 'workflow_dispatch', 'schedule', 'workflow_run'];

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

// Deliberately inspect the repository's block-style contracts, not arbitrary YAML.
// Unsupported syntax fails closed and needs review instead of a guessed interpretation.
function topLevelBlock(source, key) {
  requireCondition(!/\t/.test(source), 'Workflow tabs are not supported');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  requireCondition(start >= 0, `Missing supported ${key} block`);
  requireCondition(lines.filter((line) => line === `${key}:`).length === 1, `Duplicate ${key} block`);
  const end = lines.findIndex((line, index) => index > start && /^[^\s#]/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function eventsFor(source) {
  const block = topLevelBlock(source, 'on');
  const events = [...block.matchAll(/^ {2}([a-z_]+):(?:\s*#.*)?$/gm)].map((match) => match[1]);
  requireCondition(events.length > 0, 'Missing supported workflow events');
  requireCondition(events.every((event) => SUPPORTED_EVENTS.includes(event)), 'Workflow event needs explicit review');
  requireCondition(!/^ {2}(?![a-z_]+:(?:\s*#.*)?$)\S/m.test(block), 'Unsupported workflow event syntax');
  return events;
}

function requireOnlyJob(jobs, name) {
  const definitions = jobs.split('\n').filter((line) => /^ {2}[^\s#]/.test(line));
  requireCondition(definitions.length === 1 && definitions[0] === `  ${name}:`, `Only the gated ${name} job is supported`);
}

function validateCalibrationWorkflow(source) {
  requireCondition(JSON.stringify(eventsFor(source)) === '["workflow_dispatch"]', 'Calibration must be manual-only');
  const trigger = topLevelBlock(source, 'on');
  requireCondition(/^ {6}authorize_database_writes:\n {8}description: [^\n]+\n {8}type: boolean\n {8}required: true\n {8}default: false\s*$/m.test(trigger), 'Calibration authorization must be a required boolean defaulting to false');
  const jobs = topLevelBlock(source, 'jobs');
  requireOnlyJob(jobs, 'prepare');
  const conditions = [...jobs.matchAll(/^ {4}if: (.+)$/gm)].map((match) => match[1]);
  requireCondition(conditions.length === 1 && conditions[0] === CALIBRATION_GATE, 'Calibration job must require manual database authorization and the opt-in repository variable');
  requireCondition(!/^env:/m.test(source), 'Calibration database environment must remain behind the job gate');
  requireCondition(!/<<:|(?:^|\s)[&*][a-zA-Z_]/m.test(source), 'Workflow aliases need explicit review');
  requireCondition(/npm ci[\s\S]*npm run build[\s\S]*npm run calibration:warm/.test(jobs), 'Calibration must build matching sources before warming');
  return true;
}

// The expression above is fixed by validation; this exposes its truth table for
// offline checks without executing GitHub jobs or loading database credentials.
function calibrationRunAllowed(source, { eventName, authorizeDatabaseWrites, operationalCalibrationEnabled } = {}) {
  validateCalibrationWorkflow(source);
  return eventName === 'workflow_dispatch'
    && authorizeDatabaseWrites === true
    && operationalCalibrationEnabled === 'true';
}

function validateCollectionWorkflow(source) {
  requireCondition(JSON.stringify(eventsFor(source)) === '["schedule","workflow_dispatch"]', 'Prospective collection may only be scheduled or manual');
  const trigger = topLevelBlock(source, 'on');
  requireCondition(/^ {4}- cron: '\*\/30 \* \* \* \*'$/m.test(trigger), 'Collection must retain the documented finite 30-minute cadence');
  requireCondition(/^ {6}authorize_collection:\n {8}description: [^\n]+\n {8}type: boolean\n {8}required: true\n {8}default: false\s*$/m.test(trigger), 'Manual collection authorization must default to false');
  const jobs = topLevelBlock(source, 'jobs');
  requireOnlyJob(jobs, 'collect');
  const conditions = [...jobs.matchAll(/^ {4}if: (.+)$/gm)].map((match) => match[1]);
  requireCondition(conditions.length === 1 && conditions[0] === COLLECTION_GATE, 'Collection job must require repository opt-in and manual consent for dispatch');
  requireCondition(!/^env:/m.test(source) && !/<<:|(?:^|\s)[&*][a-zA-Z_]/m.test(source), 'Collection environment and aliases need explicit review');
  for (const key of ['PROTOCOL_ID', 'MANIFEST_SHA256', 'SEASONS', 'FROM', 'TO']) {
    const variable = `MODEL_A_COLLECTION_${key}`;
    requireCondition(jobs.includes(`${variable}: \${{ vars.${variable} }}`), `Collection requires explicit ${variable}`);
  }
  requireCondition(/^ {6}MODEL_A_PROSPECTIVE_STORAGE: database$/m.test(jobs), 'Runner collection requires the explicit database storage mode');
  requireCondition(/^ {6}MODEL_A_COLLECTION_INTERVAL_SECONDS: '0'$/m.test(jobs), 'Runner collection must be a finite single cycle');
  requireCondition(jobs.includes("MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED: ${{ vars.MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED || 'false' }}"), 'Optional result refresh must default to disabled');
  requireCondition(jobs.includes("MODEL_A_PROSPECTIVE_MONITORING_ENABLED: ${{ vars.MODEL_A_PROSPECTIVE_MONITORING_ENABLED || 'false' }}"), 'Optional monitoring must default to disabled');
  const monitoring = jobs.slice(jobs.indexOf('      - name: Check configured collection scope with read-only queries'));
  requireCondition(monitoring.startsWith('      - name: Check configured collection scope with read-only queries\n'), 'Missing post-collection monitoring step');
  requireCondition(jobs.indexOf('run: node scripts/model-a-prospective-collect.js') < jobs.indexOf(monitoring), 'Monitoring must follow collection');
  requireCondition(monitoring.split('\n').filter(line => line === `        if: ${MONITORING_STEP_GATE}`).length === 3, 'Monitoring, summary and artifact steps require the opt-in gate even after collection failure');
  requireCondition(/set -eo pipefail\n {10}mkdir -p artifacts\n {10}node scripts\/check-model-a-prospective\.js --configured-database \| tee artifacts\/model-a-prospective-monitor\.json/.test(monitoring), 'Monitoring must retain the read-only report and propagate its exit status');
  requireCondition(monitoring.includes('if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);') && monitoring.includes('uses: actions/upload-artifact@v7'), 'Monitoring must expose a GitHub summary and diagnostic artifacts');
  requireCondition(!/ODDS_API_KEY|API_FOOTBALL_KEY|calibration:warm|nightly-sync\.sh|hostless:integration|executeMultiple|scripts\/.*migrat/i.test(jobs), 'Collection must not migrate, warm calibration, deploy or receive quote provider keys');
  requireCondition(/run: node scripts\/model-a-prospective-collect\.js/.test(jobs), 'Missing finite collector entry point');
  return true;
}

function collectionRunAllowed(source, { eventName, authorizeCollection, collectionEnabled } = {}) {
  validateCollectionWorkflow(source);
  return collectionEnabled === 'true'
    && (eventName === 'schedule' || (eventName === 'workflow_dispatch' && authorizeCollection === true));
}

function validateCiWorkflow(source) {
  const events = eventsFor(source);
  requireCondition(PUBLICATION_EVENTS.slice(0, 2).every((event) => events.includes(event)), 'Ordinary CI must retain push and pull request checks');
  requireCondition((topLevelBlock(source, 'on').match(/^ {6}- main$/gm) || []).length === 2, 'Ordinary CI must retain the main branch triggers');
  const jobs = topLevelBlock(source, 'jobs');
  for (const name of ['backend', 'frontend']) {
    const match = jobs.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9_-]*:|$(?![\\s\\S]))`, 'm'));
    requireCondition(match, `Missing ordinary ${name} CI job`);
    requireCondition(!/^ {4}if:/m.test(match[1]), `Ordinary ${name} CI must not be gated off`);
    for (const script of ['lint', 'typecheck', 'build', 'test:ci']) {
      requireCondition(match[1].includes(`npm run ${script}`), `Missing ${name} CI ${script}`);
    }
  }
  return true;
}

function checkWorkflowSources(sources) {
  requireCondition(typeof sources['calibration-warm.yml'] === 'string', 'Missing calibration workflow');
  requireCondition(typeof sources['ci.yml'] === 'string', 'Missing ordinary CI workflow');
  requireCondition(typeof sources['model-a-prospective.yml'] === 'string', 'Missing prospective collection workflow');
  validateCalibrationWorkflow(sources['calibration-warm.yml']);
  validateCiWorkflow(sources['ci.yml']);
  validateCollectionWorkflow(sources['model-a-prospective.yml']);
  const report = [];
  for (const [file, source] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    const events = eventsFor(source);
    const publication = events.some((event) => PUBLICATION_EVENTS.includes(event));
    if (publication) {
      requireCondition(!/secrets\s*(?:\.|\[)/i.test(source), `${file}: publication workflows must not receive repository secrets`);
      requireCondition(!/\bTURSO_(?:DATABASE_URL|AUTH_TOKEN|WATCHDOG_READONLY_TOKEN)\b/.test(source), `${file}: publication workflows must not receive operational database configuration`);
      requireCondition(!/calibration:warm|nightly-sync\.sh|model-a-prospective-collect|check-model-a-prospective|hostless:integration|deploy[-_ ]?hook|\b(?:render|vercel|flyctl)\s+deploy\b/i.test(source), `${file}: publication cannot run operational or deployment commands`);
    }
    if (events.includes('workflow_run')) {
      const trigger = topLevelBlock(source, 'on');
      requireCondition(/workflows: \['Nightly Sync'\]/.test(trigger), `${file}: workflow_run source needs explicit review to exclude publication-triggered operations`);
    }
    report.push({ file, events, publication, repositorySecrets: /secrets\s*(?:\.|\[)/i.test(source) });
  }
  return report;
}

function checkWorkflows(directory = resolve(__dirname, '../../.github/workflows')) {
  const sources = Object.fromEntries(readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [file, readFileSync(join(directory, file), 'utf8')]));
  return checkWorkflowSources(sources);
}

if (require.main === module) {
  try {
    console.log(JSON.stringify({ success: true, scope: 'repository workflow source contracts; remote deploy settings are not inspected', workflows: checkWorkflows() }, null, 2));
  } catch (error) {
    console.error(`[workflow-gates] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { CALIBRATION_GATE, COLLECTION_GATE, MONITORING_STEP_GATE, calibrationRunAllowed, collectionRunAllowed, checkWorkflowSources, checkWorkflows, eventsFor, validateCalibrationWorkflow, validateCollectionWorkflow, validateCiWorkflow };
