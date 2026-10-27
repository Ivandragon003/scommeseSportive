// Synthetic transport only: this helper has no HTTP client or provider credentials.
const { createClient } = require('@libsql/client');
const { SmartOddsRequestStore } = require('../../dist/services/odds-provider/SmartOddsRequestStore');
const client = createClient({ url: process.env.FIXTURE_DATABASE_URL });
const store = new SmartOddsRequestStore(client, async () => {}, {
  clock: () => new Date(process.env.FIXTURE_NOW), monthlyLimit: 500, reserveCredits: 50,
});
process.on('message', async (message) => {
  if (message !== 'run') return;
  try {
    const result = await store.execute({ provider: 'odds_api', accountScope: 'test-shared', endpoint: '/fixture/odds',
      operation: 't15', markets: ['h2h'], regions: ['eu'], requestKey: 'synthetic-process-shared', expectedCredits: 1,
      priority: 'essential', cacheMaxAgeMs: 300000 }, async () => {
      process.send({ type: 'fetch' });
      if (process.env.FIXTURE_HOLD === 'true') await new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { data: { testOnly: true, source: 'synthetic-test-fixture', odds: 1.9 },
        headers: { 'x-requests-used': '1', 'x-requests-remaining': '499', 'x-requests-last': '1' } };
    });
    process.send({ type: 'result', result });
  } catch (error) { process.send({ type: 'error', code: error.code ?? 'fixture_failed' }); }
  finally { client.close(); process.disconnect(); }
});
process.send({ type: 'ready' });
