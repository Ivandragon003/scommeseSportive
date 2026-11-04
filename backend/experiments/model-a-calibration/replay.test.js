const test = require('node:test');
const assert = require('node:assert/strict');
const { chronologicalCalibration } = require('./replay');

test('calibration uses only earlier outcomes available two hours before prediction', () => {
  const base = Date.parse('2023-01-01T00:00:00Z');
  const rows = Array.from({ length: 122 }, (_, i) => ({
    id: String(i).padStart(3, '0'), competition: 'A', date: new Date(base + i * 86400000).toISOString(),
    contextual: 0.45, ensemble: 0.5, outcome: i % 2,
  }));
  rows[120].date = new Date(Date.parse(rows[119].date) + 3600000).toISOString();
  const seen = [];
  const engine = {
    fitIsotonicCalibration(p, y) { seen.push({ p, y }); return { calibrationPoints: [1, 2, 3] }; },
    calibrate(p) { return p + 0.01; },
  };
  const result = chronologicalCalibration(rows.reverse(), engine);
  assert.equal(result.find(r => r.id === '120').calibrated, null);
  assert.equal(result.find(r => r.id === '121').calibrationTraining, 121);
  assert.equal(result.find(r => r.id === '121').calibrated, 0.46);
  assert.equal(seen[0].y.length, 121);
});

test('curves are isolated by league and skip invalid short curves', () => {
  const rows = Array.from({ length: 121 }, (_, i) => ({ id: String(i), competition: 'A',
    date: new Date(Date.UTC(2022, 0, 1 + i)).toISOString(), contextual: 0.4, outcome: i % 2 }));
  rows.push({ ...rows[0], id: 'other', competition: 'B', date: '2024-01-01T00:00:00Z' });
  const result = chronologicalCalibration(rows, { fitIsotonicCalibration: () => ({ calibrationPoints: [1, 2] }) });
  assert.ok(result.every(r => r.calibrated === null));
  assert.equal(result.find(r => r.id === 'other').calibrationTraining, 0);
});
