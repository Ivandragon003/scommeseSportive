'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { ModelAProspectiveCollection, collectionScopeManifest } = require('../dist/research/ModelAProspectiveCollection');
const { ModelAResearchCalendarStore, calendarMappingHash } = require('../dist/research/ModelAResearchCalendarStore');
const { PredictionService } = require('../dist/services/PredictionService');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { drainModelAProspective } = require('../dist/research/ModelAProspectiveRecorder');
const { refreshModelAProspectiveResults, createModelAProspectiveResultRefreshSink } = require('../dist/research/ModelAProspectiveResultRefresh');
const { evaluateProspective } = require('../scripts/model-a-prospective-evaluate');

const leagues = [ ['Serie A','SA',2019], ['Premier League','PL',2021], ['La Liga','PD',2014], ['Bundesliga','BL1',2002], ['Ligue 1','FL1',2015] ];

test('calendar observations drive a real no-odds prospective prediction without mutating operational matches', async () => {
  const names = ['PLAYER_DATA_ENABLED','PLAYER_AVAILABILITY_ENABLED','MODEL_A_PROSPECTIVE_ENABLED','MODEL_A_PROSPECTIVE_STORAGE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { PLAYER_DATA_ENABLED:'false', PLAYER_AVAILABILITY_ENABLED:'false', MODEL_A_PROSPECTIVE_ENABLED:'true', MODEL_A_PROSPECTIVE_STORAGE:'database' });
  const client = createClient({ url:'file::memory:' });
  try {
    await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
    await client.executeMultiple('CREATE TABLE matches(match_id TEXT PRIMARY KEY,source TEXT,source_match_id INTEGER,home_team_id TEXT,away_team_id TEXT,competition TEXT,season TEXT,date TEXT,home_goals INTEGER,away_goals INTEGER,raw_json TEXT)');
    await client.executeMultiple('CREATE TABLE teams(team_id TEXT PRIMARY KEY,source_team_id INTEGER)');
    const now = Math.floor(Date.now() / 1000) * 1000, kickoff = new Date(now + 6 * 3600000).toISOString(), far = new Date(now + 60 * 3600000).toISOString();
    const old = new Date(now - 24 * 3600000).toISOString(), mapping = {}, payloads = {};
    let target;
    for (const [index, [name, code, competitionId]] of leagues.entries()) {
      const a = 100 + index * 2, b = a + 1, home = `understat_team_${a}`, away = `understat_team_${b}`;
      mapping[name] = { [a]:home, [b]:away };
      await client.execute({sql:'INSERT INTO teams VALUES (?,?),(?,?)',args:[home,a,away,b]});
      const fixtures = [];
      for (const [leg, [h, v]] of [[a,b],[b,a]].entries()) {
        const matchId = 1000 + index * 2 + leg, providerId = 2000 + index * 2 + leg;
        const hId = `understat_team_${h}`, aId = `understat_team_${v}`;
        await client.execute({ sql:'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?)', args:[`understat_${matchId}`,'understat',matchId,hId,aId,name,'2026/27',old,null,null,'{}'] });
        const date = index === 0 && leg === 0 ? kickoff : far;
        fixtures.push({ id:providerId, utcDate:date, status:'TIMED', lastUpdated:null, homeTeam:{id:h}, awayTeam:{id:v} });
        if (index === 0 && leg === 0) target = { matchId:`understat_${matchId}`, home, away, providerId };
      }
      payloads[code] = { competition:{id:competitionId}, season:{startDate:'2026-08-01'}, matches:fixtures };
    }
    const before = (await client.execute('SELECT * FROM matches ORDER BY match_id')).rows;
    let calls = 0;
    const calendar = new ModelAResearchCalendarStore(client, { mapping, apiKey:'synthetic-key', fetch:async ({ competition, season }) => {
      calls++; assert.equal(season, 2026); assert.ok(payloads[competition]); return {payload:payloads[competition], acquiredAt:new Date().toISOString()};
    } });
    const scope = { protocolId:'calendar-e2e', manifestSha256:'a'.repeat(64), seasons:['2026/27'], from:new Date(now - 3600000).toISOString(), to:new Date(now + 7 * 86400000).toISOString(),
      calendar:{source:'football-data.org', mappingSha256:calendarMappingHash(mapping), maxAgeSeconds:3600, expectedTeamCounts:Object.fromEntries(leagues.map(([name]) => [name,2]))} };
    scope.manifestSha256 = collectionScopeManifest(scope).sha256;
    const params = new DixonColesModel().getParams(); params.attackParams = {[target.home]:.4,[target.away]:-.4}; params.defenceParams = {[target.home]:0,[target.away]:0};
    const wrapper = { execute:(sql,args) => client.execute({sql,args}), get:async (sql,args) => (await client.execute({sql,args})).rows[0] ?? null };
    let contextKickoff;
    const db = { getLatestModelParams:async () => ({params}), getTeamsByIds:async ids => ids.map(team_id => ({team_id,name:team_id,competition:'Serie A'})),
      getMatchById:async id => (await client.execute({sql:'SELECT * FROM matches WHERE match_id=?',args:[id]})).rows[0], getTeamHistoricalCoverageBatch:async () => ({}),
      getTeamScheduleInsightsBatch:async (_ids, date) => { contextKickoff = date; return {}; }, getPromotedTeamHistoryBatch:async () => ({}),
      appendModelAProspectiveForecast: record => DatabaseService.prototype.appendModelAProspectiveForecast.call(wrapper, record) };
    const service = new PredictionService(db, {getMatchDetails:async () => { throw Error('unexpected provider request'); }});
    service.applyAdaptiveTuning = async () => null;
    service.getCalibrationProfile = async () => ({calibrationPoints:[{x:0,y:0},{x:1,y:1}],nObservations:0,byFamily:{},learnedBlendWeights:{}});
    const collector = new ModelAProspectiveCollection(client, service, scope, undefined, undefined, undefined, undefined, calendar);
    const run = await collector.run();
    assert.equal(calls,5); assert.equal(run.claimed,1);
    const ledger = (await client.execute({sql:'SELECT * FROM model_a_collection_ledger WHERE match_id=?',args:[target.matchId]})).rows[0];
    assert.equal(ledger.state,'stored',JSON.stringify(ledger));
    const [forecast] = (await client.execute('SELECT * FROM model_a_prospective_forecasts')).rows;
    const payload = JSON.parse(forecast.payload_json);
    assert.equal(forecast.kickoff_at,kickoff); assert.equal(contextKickoff,kickoff);
    assert.equal(payload.researchCalendar.matchId,target.matchId); assert.equal(Number(payload.researchCalendar.providerMatchId),target.providerId);
    assert.ok(payload.researchCalendar.attemptId); assert.equal(payload.researchCalendar.mappingSha256,scope.calendar.mappingSha256); assert.equal(payload.researchCalendar.publicationAt,null);
    assert.equal(payload.collection.claimId,ledger.claim_id); assert.deepEqual(payload.quotes,[]);
    assert.deepEqual((await client.execute('SELECT * FROM matches ORDER BY match_id')).rows,before);
    assert.equal((await client.execute('SELECT COUNT(*) AS n FROM model_a_calendar_attempts')).rows[0].n,5);
    assert.equal(await drainModelAProspective(5000),true);

    // Move only this isolated test clock forward: no future outcome is used by inference.
    const RealDate = Date;
    let observedNow = now + 9 * 3600000, goals = [2, 1];
    class AcceptanceClock extends RealDate {
      constructor(...args) { super(...(args.length ? args : [observedNow])); }
      static now() { return observedNow; }
    }
    global.Date = AcceptanceClock;
    try {
      const providerMatchId = Number(target.matchId.slice(10));
      const homeId = target.home.replace('understat_team_',''), awayId = target.away.replace('understat_team_','');
      const source = { scrapeSeason:async () => {
        const raw = { id:String(providerMatchId), datetime:kickoff.slice(0,19).replace('T',' '), isResult:true,
          h:{id:homeId}, a:{id:awayId}, goals:{h:String(goals[0]),a:String(goals[1])} };
        return [{matchId:target.matchId,sourceMatchId:providerMatchId,date:raw.datetime,homeTeamId:homeId,awayTeamId:awayId,
          competition:'Serie A',season:'2026/27',homeGoals:goals[0],awayGoals:goals[1],rawJson:JSON.stringify(raw)}];
      } };
      const env = {MODEL_A_PROSPECTIVE_ENABLED:'true',MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED:'true'};
      const firstRefresh = await refreshModelAProspectiveResults(createModelAProspectiveResultRefreshSink(client),{env,source});
      assert.equal(firstRefresh.recorded,1,JSON.stringify(firstRefresh));
      const evaluateOptions = {cutoff:new Date(observedNow + 1000).toISOString(),origin:'prospective_a',protocolId:scope.protocolId,manifestSha256:scope.manifestSha256};
      const technical = await evaluateProspective(client,{...evaluateOptions,mode:'technical'});
      const strict = await evaluateProspective(client,evaluateOptions);
      assert.equal(technical.denominators.scoredMatches,1);
      assert.equal(technical.stages.contextual.over.count,1);
      assert.equal(technical.scientificStatus.validationStatisticallyConcluded,false);
      assert.equal(strict.denominators.scoredMatches,0);
      const originalResult = (await client.execute('SELECT * FROM model_a_prospective_results')).rows[0];
      observedNow += 3600000; goals = [0, 0];
      const correction = await refreshModelAProspectiveResults(createModelAProspectiveResultRefreshSink(client),{env,source});
      assert.equal(correction.recorded,1,JSON.stringify(correction));
      const corrected = await evaluateProspective(client,{...evaluateOptions,cutoff:new Date(observedNow + 1000).toISOString(),mode:'technical'});
      assert.equal(corrected.denominators.scoredMatches,1);
      assert.equal(corrected.stages.contextual.over.deciles.find(bin=>bin.count).observedRate,0);
      assert.equal((await client.execute('SELECT COUNT(*) AS n FROM model_a_prospective_results')).rows[0].n,2);
      assert.deepEqual((await client.execute({sql:'SELECT * FROM model_a_prospective_results WHERE evidence_id=?',args:[originalResult.evidence_id]})).rows[0],originalResult);
      assert.deepEqual((await client.execute('SELECT * FROM model_a_prospective_forecasts')).rows[0],forecast);
      assert.deepEqual((await client.execute('SELECT * FROM matches ORDER BY match_id')).rows,before);
    } finally { global.Date = RealDate; }
  } finally {
    await drainModelAProspective(5000); client.close();
    for (const [name,value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
