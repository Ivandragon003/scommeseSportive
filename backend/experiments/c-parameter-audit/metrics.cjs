'use strict';
const assert = require('node:assert/strict');

function losses(row, family, stage) {
  const p = row.forecasts[family][stage];
  const values = [p.homeWin, p.draw, p.awayWin];
  assert(values.every(v => Number.isFinite(v) && v > 0 && v < 1));
  assert(Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 1e-10);
  const y = row.homeGoals > row.awayGoals ? 0 : row.homeGoals < row.awayGoals ? 2 : 1;
  const chosen = values.indexOf(Math.max(...values));
  const total = Number(row.homeGoals + row.awayGoals > 2.5);
  return { logLoss: -Math.log(values[y]),
    brier: values.reduce((s, v, i) => s + (v - Number(i === y)) ** 2, 0),
    over25LogLoss: -Math.log(total ? p.over25 : 1 - p.over25),
    over25Brier: (p.over25 - total) ** 2,
    confidence: values[chosen], correct: Number(chosen === y) };
}

function metrics(rows, family, stage) {
  assert(rows.length > 0);
  const totals = { logLoss: 0, brier: 0, over25LogLoss: 0, over25Brier: 0 };
  const bins = Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, observed: 0 }));
  for (const row of rows) {
    const value = losses(row, family, stage);
    for (const key of Object.keys(totals)) totals[key] += value[key];
    const bin = bins[Math.min(9, Math.floor(value.confidence * 10))];
    bin.n++; bin.predicted += value.confidence; bin.observed += value.correct;
  }
  return { n: rows.length, ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / rows.length])),
    eceTopLabel10Bins: bins.reduce((s, b) => s + Math.abs(b.predicted - b.observed), 0) / rows.length };
}

// Resample whole UTC weeks; the same match always contributes both models.
function pairedIntervals(rows, stage, { replications, seed }) {
  const weeks = new Map();
  for (const row of rows) {
    const key = Math.floor(Date.parse(row.kickoffAt) / (7 * 86400000));
    const group = weeks.get(key) || { n: 0, logLoss: 0, brier: 0 };
    const current = losses(row, 'incumbent', stage), candidate = losses(row, 'candidate', stage);
    group.n++;
    for (const metric of ['logLoss', 'brier']) group[metric] += candidate[metric] - current[metric];
    weeks.set(key, group);
  }
  const blocks = [...weeks.values()];
  if (blocks.length < 2) return { blocks: blocks.length, intervals: null };
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const draws = { logLoss: [], brier: [] };
  for (let i = 0; i < replications; i++) {
    let n = 0, logLoss = 0, brier = 0;
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[Math.floor(random() * blocks.length)];
      n += block.n; logLoss += block.logLoss; brier += block.brier;
    }
    draws.logLoss.push(logLoss / n); draws.brier.push(brier / n);
  }
  const quantile = (x, q) => {
    const at = (x.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
    return x[lo] + (x[hi] - x[lo]) * (at - lo);
  };
  return { blocks: blocks.length, replications, seed, independentEvidence: false,
    intervals: Object.fromEntries(Object.entries(draws).map(([key, values]) => {
      values.sort((a, b) => a - b);
      return [key, { lower: quantile(values, .025), upper: quantile(values, .975) }];
    })) };
}

function compare(rows, bootstrap) {
  return Object.fromEntries(['raw', 'calibrated', 'decision'].map(stage => {
    const incumbent = metrics(rows, 'incumbent', stage), candidate = metrics(rows, 'candidate', stage);
    return [stage, { incumbent, candidate,
      deltaCandidateMinusIncumbent: Object.fromEntries(Object.keys(incumbent).filter(k => k !== 'n')
        .map(k => [k, candidate[k] - incumbent[k]])),
      pairedWeekly95PercentInterval: pairedIntervals(rows, stage, bootstrap) }];
  }));
}

module.exports = { losses, metrics, pairedIntervals, compare };
