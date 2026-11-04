import type { Client } from '@libsql/client';
import type { ModelAProspectiveReceipt } from './ModelAProspectiveRecorder';
import { createHash, randomUUID } from 'node:crypto';

const COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
const HOUR = 3600000;
export type CollectionScope = { protocolId: string; manifestSha256: string; seasons: string[]; from: string; to: string };
type Predictor = { predict: (request: any, options: any) => Promise<unknown> };
type Fixture = { match_id: string; home_team_id: string; away_team_id: string; competition: string; season: string; date: string; home_goals: unknown; away_goals: unknown; provider_status: string | null };

function utc(value: string): number {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) return NaN;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value);
}
export function validateCollectionScope(scope: CollectionScope): CollectionScope {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(scope.protocolId ?? '') || !/^[a-f0-9]{64}$/.test(scope.manifestSha256 ?? '') || !Array.isArray(scope.seasons)
    || !scope.seasons.length || scope.seasons.some(s => typeof s !== 'string' || !s.trim() || s !== s.trim())) throw new Error('collection_scope_invalid');
  const from = utc(scope.from), to = utc(scope.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('collection_interval_invalid');
  return { protocolId: scope.protocolId, manifestSha256: scope.manifestSha256, seasons: [...new Set(scope.seasons)].sort(), from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
export function collectionScopeManifest(scope: Omit<CollectionScope, 'manifestSha256'>): { snapshot: object; sha256: string } {
  const validated = validateCollectionScope({ ...scope, manifestSha256: '0'.repeat(64) });
  const snapshot = { protocolId: validated.protocolId, seasons: validated.seasons, from: validated.from, to: validated.to, competitions: COMPETITIONS, origin: 'prospective_a', window: 'T-24h..T-60min inclusive' };
  return { snapshot, sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}
function cancellation(f: Fixture): boolean {
  return /^(cancelled|canceled|postponed|suspended|abandoned)$/i.test(String(f.provider_status ?? ''));
}
const VALID_KICKOFF = `(julianday(date) IS NOT NULL AND (UPPER(SUBSTR(date,-1))='Z' OR SUBSTR(date,-6) GLOB '[+-][0-9][0-9]:[0-9][0-9]'))`;
const PROVIDER_STATUS = `CASE WHEN json_valid(raw_json) THEN COALESCE(json_extract(raw_json,'$.status'),json_extract(raw_json,'$.matchStatus'),json_extract(raw_json,'$.match.status'),json_extract(raw_json,'$.match.matchStatus')) ELSE NULL END AS provider_status`;
function inWindow(now: number, kickoff: number): boolean { return now >= kickoff - 24 * HOUR && now <= kickoff - HOUR; }

/** One durable claim per protocol, fixture and kickoff. Claims never regenerate a forecast. */
export class ModelAProspectiveCollection {
  private scope: CollectionScope;
  constructor(private client: Client, private predictor: Predictor, scope: CollectionScope, private clock: () => Date = () => new Date(), private shouldStop: () => boolean = () => false) {
    this.scope = validateCollectionScope(scope);
    if (collectionScopeManifest(this.scope).sha256 !== this.scope.manifestSha256) throw new Error('collection_manifest_hash_mismatch');
  }
  private async execute(sql: string, args: any[] = []) { return this.client.execute({ sql, args }); }
  private now() { const n = this.clock(); if (!Number.isFinite(n.getTime())) throw new Error('collection_clock_invalid'); return n; }
  private async prepare() {
    const json = JSON.stringify({ snapshot: collectionScopeManifest(this.scope).snapshot, sha256: this.scope.manifestSha256 });
    await this.execute('INSERT OR IGNORE INTO model_a_collection_protocols(protocol_id,scope_json,created_at) VALUES(?,?,?)', [this.scope.protocolId, json, this.now().toISOString()]);
    const row = (await this.execute('SELECT scope_json FROM model_a_collection_protocols WHERE protocol_id=?', [this.scope.protocolId])).rows[0];
    if (!row || row.scope_json !== json) throw new Error('collection_protocol_scope_mismatch');
  }
  private async setState(f: Fixture, kickoff: string, state: string, reason: string, id: string | null = null) {
    await this.execute(`UPDATE model_a_collection_ledger SET state=?,reason=?,forecast_id=COALESCE(?,forecast_id),updated_at=? WHERE protocol_id=? AND match_id=? AND kickoff_at=?`,
      [state, reason, id, this.now().toISOString(), this.scope.protocolId, f.match_id, kickoff]);
  }
  private async confirmed(f: Fixture, kickoff: string, claim: string, claimId: string, id?: string | null): Promise<string | null> {
    const rows = (await this.execute('SELECT id,forecast_at,kickoff_at,payload_json FROM model_a_prospective_forecasts WHERE match_id=? AND kickoff_at=?', [f.match_id, kickoff])).rows;
    const valid = rows.filter(row => {
      try {
        const payload = JSON.parse(String(row.payload_json)); const at = utc(String(row.forecast_at));
        return (!id || row.id === id) && payload.origin === 'prospective_a' && payload.competition === f.competition && payload.season === f.season
          && payload.collection?.protocolId === this.scope.protocolId && payload.collection?.manifestSha256 === this.scope.manifestSha256 && payload.collection?.claimId === claimId
          && at >= utc(claim) && inWindow(at, utc(kickoff));
      } catch { return false; }
    });
    return valid.length === 1 ? String(valid[0].id) : null;
  }
  async run(): Promise<{ examined: number; claimed: number; invalidKickoffCount: number }> {
    await this.prepare();
    const id = randomUUID();
    await this.execute(`INSERT INTO model_a_collection_runs(run_id,protocol_id,started_at,status) VALUES(?,?,?,'started')`, [id, this.scope.protocolId, this.now().toISOString()]);
    try {
      const result = await this.collect();
      await this.execute(`UPDATE model_a_collection_runs SET status=?,completed_at=?,examined=?,claimed=?,invalid_kickoff_count=? WHERE run_id=?`, [this.shouldStop() ? 'interrupted' : 'success', this.now().toISOString(), result.examined, result.claimed, result.invalidKickoffCount, id]);
      return result;
    } catch (error) {
      await this.execute(`UPDATE model_a_collection_runs SET status='failed',completed_at=?,error_code='collection_failed' WHERE run_id=?`, [this.now().toISOString(), id]);
      throw error;
    }
  }
  private async collect(): Promise<{ examined: number; claimed: number; invalidKickoffCount: number }> {
    const filter = `competition IN (${COMPETITIONS.map(() => '?').join(',')}) AND season IN (${this.scope.seasons.map(() => '?').join(',')})`;
    const args = [...COMPETITIONS, ...this.scope.seasons];
    const invalid = (await this.execute(`SELECT COUNT(*) AS n FROM matches WHERE ${filter} AND NOT COALESCE(${VALID_KICKOFF},0)`, args)).rows[0];
    let invalidKickoffCount = Number(invalid?.n ?? 0);
    await this.execute(`UPDATE model_a_collection_ledger SET reason='fixture_missing_from_calendar',updated_at=? WHERE protocol_id=? AND reason<>'fixture_missing_from_calendar' AND NOT EXISTS (SELECT 1 FROM matches WHERE matches.match_id=model_a_collection_ledger.match_id)`, [this.now().toISOString(), this.scope.protocolId]);
    await this.execute(`UPDATE model_a_collection_ledger SET reason='kickoff_changed',updated_at=? WHERE protocol_id=? AND reason<>'kickoff_changed' AND EXISTS (SELECT 1 FROM matches WHERE matches.match_id=model_a_collection_ledger.match_id AND julianday(matches.date) IS NOT NULL AND julianday(matches.date)<>julianday(model_a_collection_ledger.kickoff_at))`, [this.now().toISOString(), this.scope.protocolId]);
    let examined = 0, claimed = 0;
    const scanTime = this.now().toISOString();
    let cursorPriority = -1, cursorDay = -1, cursorId = '';
    while (!this.shouldStop()) {
    const rows = (await this.execute(`SELECT * FROM (SELECT match_id,home_team_id,away_team_id,competition,season,date,home_goals,away_goals,${PROVIDER_STATUS},julianday(date) AS sort_day, CASE WHEN julianday(date)>=julianday(?,'+1 hour') AND julianday(date)<=julianday(?,'+24 hours') THEN 0 ELSE 1 END AS sort_priority FROM matches WHERE ${filter} AND ${VALID_KICKOFF} AND julianday(date)>=julianday(?) AND julianday(date)<julianday(?)) WHERE sort_priority>? OR (sort_priority=? AND (sort_day>? OR (sort_day=? AND match_id>?))) ORDER BY sort_priority,sort_day,match_id LIMIT 100`, [scanTime, scanTime, ...args, this.scope.from, this.scope.to, cursorPriority, cursorPriority, cursorDay, cursorDay, cursorId])).rows as unknown as (Fixture & { sort_day: number; sort_priority: number })[];
    if (!rows.length) break;
    for (const f of rows) {
      if (this.shouldStop()) break;
      const t = utc(String(f.date));
      if (!Number.isFinite(t)) { invalidKickoffCount++; continue; }
      if (t < utc(this.scope.from) || t >= utc(this.scope.to)) continue;
      examined++;
      const kickoff = new Date(t).toISOString(), now = this.now().getTime(), at = new Date(now).toISOString();
      await this.execute(`UPDATE model_a_collection_ledger SET reason='kickoff_changed',updated_at=? WHERE protocol_id=? AND match_id=? AND kickoff_at<>? AND reason<>'kickoff_changed'`, [at, this.scope.protocolId, f.match_id, kickoff]);
      const reason = cancellation(f) ? 'cancelled_or_postponed' : f.home_goals != null || f.away_goals != null ? 'result_present' : !f.home_team_id || !f.away_team_id ? 'identity_missing' : now < t - 24 * HOUR ? 'not_due' : now > t - HOUR ? 'window_expired' : 'eligible';
      await this.execute(`INSERT OR IGNORE INTO model_a_collection_ledger(protocol_id,match_id,kickoff_at,competition,season,state,reason,updated_at) VALUES(?,?,?,?,?,'observed',?,?)`, [this.scope.protocolId, f.match_id, kickoff, f.competition, f.season, reason, at]);
      const record = (await this.execute('SELECT state,claim_at,claim_id,forecast_id FROM model_a_collection_ledger WHERE protocol_id=? AND match_id=? AND kickoff_at=?', [this.scope.protocolId, f.match_id, kickoff])).rows[0];
      if (record.state !== 'observed') {
        if (record.claim_at && record.claim_id && record.state !== 'stored') {
          const id = await this.confirmed(f, kickoff, String(record.claim_at), String(record.claim_id), record.forecast_id ? String(record.forecast_id) : null);
          if (id) await this.setState(f, kickoff, 'stored', 'forecast_confirmed', id);
        }
        continue;
      }
      if (reason !== 'eligible') {
        await this.execute(`UPDATE model_a_collection_ledger SET state=?,reason=?,updated_at=? WHERE protocol_id=? AND match_id=? AND kickoff_at=? AND state='observed' AND (reason<>? OR state<>?)`, [reason === 'window_expired' ? 'expired' : 'observed', reason, at, this.scope.protocolId, f.match_id, kickoff, reason, reason === 'window_expired' ? 'expired' : 'observed']);
        continue;
      }
      if (this.shouldStop()) break;
      const claimId = randomUUID();
      const result = await this.execute(`UPDATE model_a_collection_ledger SET state='claimed',reason='prediction_started',claim_at=?,claim_id=?,updated_at=? WHERE protocol_id=? AND match_id=? AND kickoff_at=? AND state='observed'`, [at, claimId, at, this.scope.protocolId, f.match_id, kickoff]);
      if (result.rowsAffected !== 1) continue;
      claimed++;
      try {
        const current = (await this.execute(`SELECT date,home_team_id,away_team_id,competition,season,home_goals,away_goals,${PROVIDER_STATUS} FROM matches WHERE match_id=?`, [f.match_id])).rows[0];
        if (this.shouldStop()) { await this.setState(f, kickoff, 'skipped', 'stopped_before_prediction'); break; }
        if (!current || utc(String(current.date)) !== t || current.home_team_id !== f.home_team_id || current.away_team_id !== f.away_team_id || current.competition !== f.competition || current.season !== f.season || current.home_goals != null || current.away_goals != null || cancellation(current as unknown as Fixture) || !inWindow(this.now().getTime(), t)) {
          await this.setState(f, kickoff, 'skipped', 'fixture_changed_or_window_closed'); continue;
        }
        let receipt: ModelAProspectiveReceipt | undefined;
        await this.predictor.predict({ matchId: f.match_id, homeTeamId: f.home_team_id, awayTeamId: f.away_team_id, competition: f.competition, season: f.season },
          { prospectiveOrigin: 'prospective_a', prospectiveCollection: { protocolId: this.scope.protocolId, manifestSha256: this.scope.manifestSha256, claimId }, recordAudit: false, onProspectiveRecord: (value: ModelAProspectiveReceipt) => { receipt = value; } });
        if (!receipt) { await this.setState(f, kickoff, 'unconfirmed', 'recorder_receipt_missing'); continue; }
        await this.setState(f, kickoff, 'unconfirmed', `recorder_${receipt.status}`, receipt.id ?? null);
        const completion = await receipt.completion;
        const id = await this.confirmed(f, kickoff, at, claimId, completion.id ?? receipt.id);
        if (id && completion.status === 'stored') await this.setState(f, kickoff, 'stored', 'forecast_confirmed', id);
        else await this.setState(f, kickoff, 'unconfirmed', completion.status === 'stored' ? 'forecast_missing_or_outside_window' : 'delivery_unconfirmed', receipt.id ?? null);
      } catch { await this.setState(f, kickoff, 'unconfirmed', 'prediction_or_storage_error'); }
    }
    const last = rows[rows.length - 1]; cursorPriority = Number(last.sort_priority); cursorDay = Number(last.sort_day); cursorId = String(last.match_id);
    }
    return { examined, claimed, invalidKickoffCount };
  }
}
