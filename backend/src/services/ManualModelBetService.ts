import { randomUUID } from 'node:crypto';
import type { DatabaseService } from '../db/DatabaseService';
import type { PredictionService } from './PredictionService';
import { ChallengerPreviewService } from '../research/ChallengerPreviewService';
import { appRecommendationQuote, appQuoteSettlementSupported } from '../research/AppRecommendationQuotes';
import { recommendationQuoteReason } from '../research/ResearchRecommendationPolicy';
import { buildCoherentBookmakerOddsBundle } from './BookmakerOddsSelectionService';
import { researchHash, researchJson } from '../research/ResearchStore';
import { paperSelectionKey } from '../research/PaperBetSelections';

export class ManualModelActionError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}

/** Explicit, authenticated user actions; model and quote inputs are always resolved server-side. */
export class ManualModelBetService {
  constructor(private readonly db: DatabaseService, private readonly prediction: Pick<PredictionService, 'predict'>,
    private readonly preview: Pick<ChallengerPreviewService, 'preview'> = new ChallengerPreviewService(db),
    private readonly clock = () => new Date()) {}

  private async candidate(input: any, archive = false): Promise<any> {
    if (!input || !['A', 'C'].includes(input.family) || typeof input.matchId !== 'string' || !input.matchId.trim()
      || typeof input.selection !== 'string' || !input.selection.trim()) {
      throw new ManualModelActionError('Modello, partita e selezione sono obbligatori.', 400);
    }
    const match = await this.db.getMatchById(input.matchId);
    if (!match || match.home_goals != null || match.away_goals != null || !Number.isFinite(Date.parse(match.date))
      || Date.parse(match.date) <= this.clock().getTime()) throw new ManualModelActionError('La partita non è più giocabile.');
    let selected: any, quote: any, modelVersion: string, classification: string;
    if (input.family === 'C') {
      const result = await this.preview.preview(input.matchId);
      if (result.status !== 'RECOMMENDED' || !result.recommendationPacket?.selected || !result.quote) {
        throw new ManualModelActionError('Nessun consiglio C verificabile con quota reale recente salvata.');
      }
      selected = result.recommendationPacket.selected; quote = result.quote;
      modelVersion = result.modelVersion || ''; classification = String(selected.marketTier === 'SPECULATIVE' ? 'SPECULATIVE' : selected.confidence || 'MEDIUM').toUpperCase();
    } else {
      const snapshot = await this.db.getLatestRealOddsSnapshotForMatch(input.matchId);
      if (!snapshot || snapshot.source !== 'odds_api' || snapshot.usedSyntheticOdds === true) throw new ManualModelActionError('Quota bookmaker reale salvata non disponibile.');
      const capturedAt = snapshot.captured_at;
      if (!Number.isFinite(Date.parse(capturedAt)) || !archive && this.clock().getTime() - Date.parse(capturedAt) > 300_000
        || Date.parse(capturedAt) > this.clock().getTime()) throw new ManualModelActionError('La quota salvata è scaduta.');
      const bundle = buildCoherentBookmakerOddsBundle(Object.keys(snapshot.allBookmakerOdds || {}).length ? snapshot.allBookmakerOdds
        : snapshot.selectedBookmakerName ? { [snapshot.selectedBookmakerName]: snapshot.liveSelectedOdds || snapshot.selectedOdds || {} } : {});
      const odds = bundle.odds;
      const prediction = await this.prediction.predict({ matchId: input.matchId, homeTeamId: match.home_team_id,
        awayTeamId: match.away_team_id, competition: match.competition, season: match.season,
        bookmakerOdds: odds, bookmakerBySelection: bundle.bookmakerBySelection, oddsSource: 'odds_api' });
      const candidates = [prediction.canonicalRecommendation?.selected,
        ...(prediction.valueOpportunities || []), ...((prediction as any).speculativeOpportunities || [])].filter(Boolean);
      selected = candidates.find((row: any) => row.selection === input.selection);
      if (!selected) throw new ManualModelActionError('La selezione non appartiene alle opportunità correnti del modello A.');
      const price = Number(odds[input.selection]), bookmaker = bundle.bookmakerBySelection[input.selection];
      if (!Number.isFinite(price) || price <= 1 || Number(selected.bookmakerOdds) !== price || !bookmaker) {
        throw new ManualModelActionError('Quota e consiglio del modello A non coincidono.');
      }
      quote = appRecommendationQuote(input.selection, { odds: price, source: 'odds_api', bookmaker,
        capturedAt, updatedAt: capturedAt, priceType: 'prematch' });
      if (!quote || !appQuoteSettlementSupported(quote)) throw new ManualModelActionError('Mercato non liquidabile.');
      modelVersion = prediction.canonicalRecommendation?.model.version || '';
      classification = String([selected.marketTier, selected.bestBetStatus, selected.bestBetDecision?.status].includes('SPECULATIVE')
        ? 'SPECULATIVE' : selected.confidence || '').toUpperCase();
    }
    if (!modelVersion || selected.selection !== input.selection || quote.selection !== input.selection
      || (!archive && recommendationQuoteReason(quote, this.clock(), input.family))
      || quote.source !== 'odds_api' || quote.usedSyntheticOdds === true || !quote.bookmaker
      || !Number.isFinite(Date.parse(quote.capturedAt)) || Date.parse(quote.capturedAt) > this.clock().getTime()) throw new ManualModelActionError('Il consiglio o la quota salvata non sono più validi.');
    if (!Number.isFinite(input.bookmakerOdds) || input.bookmakerOdds !== quote.odds
      || typeof input.bookmakerName !== 'string' || input.bookmakerName.trim() !== quote.bookmaker) {
      throw new ManualModelActionError('La quota o il bookmaker sono cambiati. Riapri il consiglio prima di confermare.');
    }
    return { family: input.family, portfolioId: `shadow_${input.family}`, matchId: input.matchId, modelVersion,
      market: quote.market, selection: input.selection, quote, kickoffAt: match.date,
      homeTeamName: match.home_team_name, awayTeamName: match.away_team_name,
      matchLabel: `${match.home_team_name || ''} – ${match.away_team_name || ''}`, competition: match.competition,
      classification, confidence: classification, probability: selected.ourProbability,
      decisionMode: 'MANUAL', origin: 'MANUAL', observedAt: this.clock().toISOString() };
  }

  async place(input: any): Promise<any> {
    if (!Number.isSafeInteger(input?.stakeCents) || input.stakeCents <= 0) throw new ManualModelActionError('Importo non valido.', 400);
    const candidate = await this.candidate(input);
    return this.db.research.runResearchTransaction(async (tx) => {
      const query = async (sql: string, args: any[] = []) => (await tx.execute({ sql, args })).rows[0] as any;
      const now = this.clock();
      if (recommendationQuoteReason(candidate.quote, now, candidate.family)) throw new ManualModelActionError('La quota è scaduta prima della conferma.');
      const fixture = await query('SELECT date,home_goals,away_goals FROM matches WHERE match_id=?', [candidate.matchId]);
      if (!fixture || fixture.date !== candidate.kickoffAt || fixture.home_goals != null || fixture.away_goals != null
        || Date.parse(fixture.date) <= now.getTime()) throw new ManualModelActionError('La partita è cambiata o è già iniziata.');
      const existing = await query('SELECT id,selection,odds,stake_cents FROM manual_model_bets WHERE portfolio_id=? AND match_id=?', [candidate.portfolioId, candidate.matchId]);
      if (existing) {
        if (existing.selection !== input.selection || Number(existing.odds) !== input.bookmakerOdds || Number(existing.stake_cents) !== input.stakeCents) {
          throw new ManualModelActionError('Esiste già una giocata diversa per questo modello e questa partita.');
        }
        return { betId: existing.id, family: candidate.family, alreadyRegistered: true };
      }
      if (await query('SELECT id FROM research_bets WHERE portfolio_id=? AND match_id=?', [candidate.portfolioId, candidate.matchId])) {
        throw new ManualModelActionError('Il modello ha già una giocata registrata per questa partita.');
      }
      const fundedCancellationSchema = await query("SELECT name FROM sqlite_master WHERE type='table' AND name='funded_model_bet_cancellations'");
      if (await query("SELECT name FROM sqlite_master WHERE type='table' AND name='funded_model_bets'")
        && await query(`SELECT id FROM funded_model_bets WHERE family=? AND match_id=? AND selection_key=?${fundedCancellationSchema
          ? ' AND NOT EXISTS (SELECT 1 FROM funded_model_bet_cancellations c WHERE c.bet_id=funded_model_bets.id)' : ''}`,
          [candidate.family, candidate.matchId, paperSelectionKey(candidate.quote)])) {
        throw new ManualModelActionError('Questa selezione è già stata registrata per il modello.');
      }
      if (await query("SELECT name FROM sqlite_master WHERE type='table' AND name='dynamic_model_bets'")
        && await query('SELECT id FROM dynamic_model_bets WHERE family=? AND match_id=? AND selection_key=?',
          [candidate.family, candidate.matchId, paperSelectionKey(candidate.quote)])) {
        throw new ManualModelActionError('Questa selezione è già stata registrata per il modello.');
      }
      const portfolio = await query(`SELECT p.id,COALESCE(SUM(l.available_delta_cents),0) AS available,
        COALESCE(SUM(l.committed_delta_cents),0) AS committed,
        COALESCE(SUM(l.available_delta_cents+l.committed_delta_cents),0) AS equity
        FROM research_portfolios p LEFT JOIN research_ledger l ON l.portfolio_id=p.id WHERE p.id=? GROUP BY p.id`, [candidate.portfolioId]);
      if (!portfolio || input.stakeCents > Number(portfolio.available)) throw new ManualModelActionError('Saldo del modello insufficiente.');
      const id = `manual:${randomUUID()}`, placedAt = now.toISOString();
      const evidence = { ...candidate, stakeCents: input.stakeCents, stakeMode: 'MANUAL_USER_AMOUNT' };
      await tx.execute({ sql: `INSERT INTO manual_model_bets(id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, args: [id, candidate.portfolioId, candidate.matchId, candidate.family, candidate.modelVersion,
        candidate.market, candidate.selection, candidate.quote.odds, input.stakeCents, researchJson(evidence), placedAt] });
      // The immutable identifier links this debit to manual evidence without forging a research decision FK.
      await tx.execute({ sql: `INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
        VALUES (?,?,NULL,'STAKE',?,?,?)`, args: [`stake:${id}`, candidate.portfolioId, -input.stakeCents, input.stakeCents, placedAt] });
      return { betId: id, family: candidate.family, stakeCents: input.stakeCents, alreadyRegistered: false };
    }, () => {
      if (Date.parse(candidate.kickoffAt) <= this.clock().getTime()
        || recommendationQuoteReason(candidate.quote, this.clock(), candidate.family)) {
        throw new ManualModelActionError('La partita è iniziata o la quota è scaduta prima della conferma.');
      }
    });
  }

  async listArchives(): Promise<any[]> {
    return this.db.research.runResearchTransaction(async (tx) => {
      const result = await tx.execute('SELECT id,match_id,family,selection,classification,snapshot_json,created_at FROM manual_model_archives ORDER BY created_at DESC LIMIT 1000');
      return result.rows.map((row) => ({ id: row.id, matchId: row.match_id, family: row.family, selection: row.selection,
        classification: row.classification, snapshot: JSON.parse(String(row.snapshot_json)), createdAt: row.created_at }));
    });
  }

  async evidence(id: string): Promise<any> {
    if (!id.startsWith('manual:') || id.length > 100) throw new ManualModelActionError('Giocata manuale non valida.', 400);
    return this.db.research.runResearchTransaction(async (tx) => {
      const row = (await tx.execute({ sql: 'SELECT * FROM manual_model_bets WHERE id=?', args: [id] })).rows[0];
      if (!row) throw new ManualModelActionError('Giocata manuale non trovata.', 404);
      const snapshot = JSON.parse(String(row.snapshot_json));
      return { matchId: row.match_id, decisions: [{ id: row.id, betId: row.id, matchId: row.match_id,
        family: row.family, modelVersion: row.model_version, action: 'BET', selection: row.selection,
        confidence: snapshot.confidence, origin: 'MANUAL', decisionMode: 'MANUAL',
        recommendationPacket: { selected: { selection: row.selection, bookmakerOdds: row.odds,
          bookmakerName: snapshot.quote.bookmaker }, model: { version: row.model_version } } }] };
    });
  }

  async archive(input: any): Promise<any> {
    if (!['LOW', 'SPECULATIVE'].includes(input?.classification)) throw new ManualModelActionError('Classificazione archivio non valida.', 400);
    const candidate = await this.candidate(input, true);
    if (candidate.family === 'A' && candidate.classification !== input.classification) throw new ManualModelActionError('La classificazione non coincide con il modello.');
    // C exposes only its selected recommendation: a LOW label cannot be invented by the browser.
    if (candidate.family === 'C' && candidate.classification !== input.classification) throw new ManualModelActionError('Questo consiglio C non è classificato LOW o SPECULATIVE.');
    return this.db.research.runResearchTransaction(async (tx) => {
      const fixture = (await tx.execute({ sql: 'SELECT date,home_goals,away_goals FROM matches WHERE match_id=?', args: [candidate.matchId] })).rows[0];
      if (!fixture || fixture.date !== candidate.kickoffAt || fixture.home_goals != null || fixture.away_goals != null
        || Date.parse(String(fixture.date)) <= this.clock().getTime()) throw new ManualModelActionError('La partita è già iniziata.');
      const id = `manual-archive:${researchHash({ family: candidate.family, matchId: candidate.matchId, selection: candidate.selection })}`;
      await tx.execute({ sql: `INSERT OR IGNORE INTO manual_model_archives(id,match_id,family,selection,classification,snapshot_json,created_at)
        VALUES (?,?,?,?,?,?,?)`, args: [id, candidate.matchId, candidate.family, candidate.selection, input.classification,
        researchJson({ ...candidate, decisionMode: 'MANUAL_ARCHIVE', executionEligible: false, quoteAgeSeconds: Math.max(0, Math.floor((this.clock().getTime() - Date.parse(candidate.quote.capturedAt)) / 1000)) }), this.clock().toISOString()] });
      return { decisionId: id, family: candidate.family, archiveType: 'manual_model' };
    });
  }
}
