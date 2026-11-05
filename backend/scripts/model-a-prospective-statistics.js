'use strict';

const STAGES = ['ensembleRaw', 'contextual', 'calibrated', 'marketBlended', 'decision'];
const LEAGUES = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
const EPSILON = 1e-15;
const REPLICAS = 2000;
const validProbability = p => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;

function loss(probability, outcome) {
  if (!validProbability(probability) || (outcome !== 0 && outcome !== 1)) throw new Error('invalid_score_input');
  const p = Math.max(EPSILON, Math.min(1 - EPSILON, probability));
  return { brier: (probability - outcome) ** 2, logLoss: -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p)) };
}

function summarize(observations) {
  const bins = Array.from({ length: 10 }, (_, index) => ({ lower: index / 10, upper: (index + 1) / 10, count: 0, meanPrediction: null, observedRate: null }));
  let brier = 0, logLoss = 0;
  for (const { probability, outcome } of observations) {
    const score = loss(probability, outcome), bin = bins[Math.min(9, Math.floor(probability * 10))];
    brier += score.brier; logLoss += score.logLoss;
    bin.meanPrediction = (bin.meanPrediction ?? 0) + probability;
    bin.observedRate = (bin.observedRate ?? 0) + outcome; bin.count++;
  }
  for (const bin of bins) if (bin.count) { bin.meanPrediction /= bin.count; bin.observedRate /= bin.count; }
  return { count: observations.length, brier: observations.length ? brier / observations.length : null,
    logLoss: observations.length ? logLoss / observations.length : null, deciles: bins };
}

// Monday 00:00 UTC defines a week; the full date avoids year-boundary ambiguity.
function utcWeek(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let x = Math.imul(state ^ state >>> 15, state | 1);
    x ^= x + Math.imul(x ^ x >>> 7, x | 61);
    return ((x ^ x >>> 14) >>> 0) / 4294967296;
  };
}
function percentile(sorted, p) {
  const index = (sorted.length - 1) * p, lower = Math.floor(index), weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[Math.ceil(index)] * weight;
}

/** Each observation carries paired losses on the same match, never two cohorts. */
function blockBootstrap(observations, seed) {
  const grouped = new Map();
  for (const row of observations) {
    const key = `${row.league}|${row.week}`;
    if (!grouped.has(key)) grouped.set(key, { count: 0, brier: 0, logLoss: 0 });
    const block = grouped.get(key); block.count++; block.brier += row.brier; block.logLoss += row.logLoss;
  }
  const blocks = [...grouped.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
  const count = observations.length;
  const mean = key => count ? observations.reduce((sum, row) => sum + row[key], 0) / count : null;
  const result = { count, blocks: blocks.length, deltaBrier: mean('brier'), deltaLogLoss: mean('logLoss'),
    brierCI95: null, logLossCI95: null, replicas: REPLICAS, seed,
    intervalStatus: blocks.length < 2 ? 'insufficient_independent_blocks' : 'descriptive_block_percentile' };
  // One block cannot identify between-block uncertainty; do not report a zero-width CI.
  if (blocks.length < 2) return result;
  const random = randomGenerator(seed), brier = [], logLoss = [];
  for (let replica = 0; replica < REPLICAS; replica++) {
    let n = 0, b = 0, l = 0;
    for (let draw = 0; draw < blocks.length; draw++) {
      const block = blocks[Math.floor(random() * blocks.length)];
      n += block.count; b += block.brier; l += block.logLoss;
    }
    brier.push(b / n); logLoss.push(l / n);
  }
  brier.sort((a, b) => a - b); logLoss.sort((a, b) => a - b);
  result.brierCI95 = [percentile(brier, .025), percentile(brier, .975)];
  result.logLossCI95 = [percentile(logLoss, .025), percentile(logLoss, .975)];
  return result;
}

module.exports = { STAGES, LEAGUES, EPSILON, REPLICAS, validProbability, loss, summarize, utcWeek, blockBootstrap };
