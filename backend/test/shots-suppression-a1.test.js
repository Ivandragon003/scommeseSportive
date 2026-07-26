'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SpecializedModels } = require('../dist/models/markets/SpecializedModels');

const m = new SpecializedModels();
const base = {
  homeTeamAvgShots: 13, awayTeamAvgShots: 11,
  homeTeamAvgShotsOT: 4.6, awayTeamAvgShotsOT: 4.0,
  homeTeamShotsSuppression: 1.0,
  homeAdvantageShots: 1.08,
  homeTeamSampleSize: 20, awayTeamSampleSize: 20,
};

// A1: shotsSuppression >1 = difesa debole. I tiri di casa devono CRESCERE
// contro una difesa ospite debole (prima calavano: segno invertito).
test('A1: difesa ospite debole -> piu tiri di casa', () => {
  const vsWeak = m.computeShotsDistribution({ ...base, awayTeamShotsSuppression: 1.3 });
  const vsStrong = m.computeShotsDistribution({ ...base, awayTeamShotsSuppression: 0.7 });
  assert.ok(
    vsWeak.home.expectedTotalShots > vsStrong.home.expectedTotalShots,
    `tiri casa vs difesa debole (${vsWeak.home.expectedTotalShots}) deve superare vs difesa forte (${vsStrong.home.expectedTotalShots})`,
  );
});

// Simmetria con l'ospite: difesa casa debole -> piu tiri ospite (gia' corretto).
test('A1: simmetria - difesa casa debole -> piu tiri ospite', () => {
  const vsWeak = m.computeShotsDistribution({ ...base, homeTeamShotsSuppression: 1.3, awayTeamShotsSuppression: 1.0 });
  const vsStrong = m.computeShotsDistribution({ ...base, homeTeamShotsSuppression: 0.7, awayTeamShotsSuppression: 1.0 });
  assert.ok(vsWeak.away.expectedTotalShots > vsStrong.away.expectedTotalShots);
});
