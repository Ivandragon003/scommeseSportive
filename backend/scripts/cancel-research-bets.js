/* Explicit, fingerprinted withdrawal of named wrong v1 virtual bets. No provider calls. */
const { createClient } = require('@libsql/client');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { ResearchBetCancellation } = require('../dist/research/ResearchBetCancellation');

function argumentsOf(argv) {
  const envIndex = argv.indexOf('--env-file');
  let envFile;
  if (envIndex >= 0) {
    if (!argv[envIndex + 1]) throw new Error('Expected --env-file PATH');
    envFile = argv[envIndex + 1]; argv = [...argv.slice(0, envIndex), ...argv.slice(envIndex + 2)];
  }
  const command = argv[0] ?? 'plan';
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || !argv[index + 1] || Object.hasOwn(options, argv[index])) throw new Error('Expected unique --option value');
    options[argv[index]] = argv[index + 1];
  }
  const allowed = command === 'plan' ? ['--ids', '--policy-hash', '--run-id', '--reason', '--authorized-by', '--authorized-at', '--out'] : ['--plan'];
  if (!['plan', 'apply'].includes(command) || Object.keys(options).some((key) => !allowed.includes(key))
    || allowed.some((key) => !options[key])) throw new Error('Use plan --ids ID,ID --policy-hash HASH --run-id RUN --reason REASON --authorized-by ACTOR --authorized-at ISO --out FILE; or apply --plan FILE');
  return { command, options, envFile };
}

function loadEnvironment(path, env = process.env) {
  const bytes = readFileSync(resolve(path));
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'].includes(match[1])) continue;
    const raw = match[2], quoted = raw.length >= 2 && ['"', "'"].includes(raw[0]) && raw.at(-1) === raw[0];
    env[match[1]] = quoted ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, '');
  }
}

async function main(argv = process.argv.slice(2)) {
  const { command, options, envFile } = argumentsOf(argv);
  if (envFile) loadEnvironment(envFile);
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error('Configured Turso URL and token required');
  const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    const service = new ResearchBetCancellation(client);
    if (command === 'plan') {
      const plan = await service.plan({ betIds: options['--ids'].split(','), policyHash: options['--policy-hash'],
        runId: options['--run-id'], reason: options['--reason'], authorizedBy: options['--authorized-by'], authorizedAt: options['--authorized-at'] });
      writeFileSync(resolve(options['--out']), JSON.stringify(plan, null, 2), { flag: 'wx' });
      return { action: 'dry_run', planHash: plan.planHash, bets: plan.bets, mutation: false };
    }
    const plan = JSON.parse(readFileSync(resolve(options['--plan']), 'utf8'));
    return { action: 'authorized_withdrawal', ...await service.apply(plan) };
  } finally { client.close(); }
}
if (require.main === module) main().then((result) => console.log(JSON.stringify(result)))
  .catch((error) => { console.error(error?.message?.startsWith('Cancellation') || error?.message?.startsWith('Invalid')
    ? error.message : 'research_bet_cancellation_failed'); process.exitCode = 1; });
module.exports = { main, argumentsOf, loadEnvironment };
