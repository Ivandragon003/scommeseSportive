const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getBacktestRouteTimeoutMs } = require('../dist/api/routes.js');

const withEnv = (key, value, fn) => {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;

  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
};

test('getBacktestRouteTimeoutMs usa default lungo e supporta override positivo', () => {
  withEnv('BACKTEST_ROUTE_TIMEOUT_MS', undefined, () => {
    assert.equal(getBacktestRouteTimeoutMs(), 10 * 60 * 1000);
  });

  withEnv('BACKTEST_ROUTE_TIMEOUT_MS', '900000', () => {
    assert.equal(getBacktestRouteTimeoutMs(), 900000);
  });
});

test('le route backtest impostano timeout request e response', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'routes.ts'), 'utf8');

  assert.match(source, /req\.setTimeout\(timeoutMs\)/);
  assert.match(source, /res\.setTimeout\(timeoutMs\)/);
  assert.match(source, /router\.post\('\/backtest'[\s\S]*?applyBacktestRouteTimeout\(req, res\)/);
  assert.match(source, /router\.post\('\/backtest\/walk-forward'[\s\S]*?applyBacktestRouteTimeout\(req, res\)/);
});
