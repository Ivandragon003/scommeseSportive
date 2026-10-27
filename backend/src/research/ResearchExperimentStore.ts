import type { Client } from '@libsql/client';
import { researchHash, researchJson } from './ResearchStore';

export type ResearchExperiment = {
  id: string; runId: string; kind: string; phase: 'development' | 'diagnostic_audit';
  datasetHash: string; originalReportHash: string; report: Record<string, any>;
};
const validHash = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

/** A separate registry lane prevents masked/diagnostic models entering runtime selection. */
export class ResearchExperimentStore {
  private guards: Promise<void> | undefined;
  constructor(private readonly client: Client, private readonly ready: () => Promise<void> = async () => {}) {}

  private async ensureGuards(): Promise<void> {
    if (!this.guards) this.guards = (async () => {
      for (const operation of ['UPDATE', 'DELETE']) await this.client.execute(`CREATE TRIGGER IF NOT EXISTS
        research_experiments_no_${operation.toLowerCase()} BEFORE ${operation} ON research_experiments
        BEGIN SELECT RAISE(ABORT,'research experiments are immutable'); END`);
    })().catch((error) => { this.guards = undefined; throw error; });
    return this.guards;
  }

  async saveBatch(inputs: ResearchExperiment[]): Promise<{ inserted: number; existing: number }> {
    await this.ready();
    await this.ensureGuards();
    const tx = await this.client.transaction('write');
    let inserted = 0, existing = 0;
    try {
      for (const input of inputs) {
        if (!input.id?.trim() || input.id.length > 200 || !input.runId?.trim() || !input.kind?.trim()
          || !['development', 'diagnostic_audit'].includes(input.phase)
          || !validHash(input.datasetHash) || !validHash(input.originalReportHash)
          || !input.report || typeof input.report !== 'object') throw new Error('Invalid research experiment provenance');
        const report = { ...input.report, phase: input.phase, runtimeCompatible: false, eligibleForPromotion: false };
        const identity = { ...input, report };
        const hash = researchHash(identity);
        const previous = (await tx.execute({ sql: 'SELECT report_hash FROM research_experiments WHERE id=?', args: [input.id] })).rows[0];
        if (previous) {
          if (previous.report_hash !== hash) throw new Error('Research experiment identity is immutable');
          existing++; continue;
        }
        await tx.execute({ sql: `INSERT INTO research_experiments
          (id,run_id,kind,phase,dataset_hash,original_report_hash,report_json,report_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [input.id, input.runId, input.kind, input.phase, input.datasetHash, input.originalReportHash,
          researchJson(report), hash, new Date().toISOString()] });
        inserted++;
      }
      await tx.commit();
      return { inserted, existing };
    } catch (error) { await tx.rollback().catch(() => undefined); throw error; }
    finally { tx.close(); }
  }

  async list(limit = 1000): Promise<any[]> {
    await this.ready();
    const count = Math.max(1, Math.min(2000, Math.trunc(limit) || 1000));
    const result = await this.client.execute({ sql: 'SELECT * FROM research_experiments ORDER BY created_at DESC,rowid DESC LIMIT ?', args: [count] });
    return result.rows.map((row) => {
      const report = JSON.parse(String(row.report_json));
      return { id: row.id, runId: row.run_id, kind: row.kind, phase: row.phase, featureGroup: report.featureGroup,
        datasetHash: row.dataset_hash, originalReportHash: row.original_report_hash, reportHash: row.report_hash,
        createdAt: row.created_at, family: 'C', runtimeCompatible: false, eligibleForPromotion: false, report };
    });
  }
}
