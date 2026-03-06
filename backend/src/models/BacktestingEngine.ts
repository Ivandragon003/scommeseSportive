/**
 * Backtesting Engine — v3
 *
 * MODIFICHE v3:
 *
 * 1. SELEZIONE BET: selectMediumAndAbove (HIGH + MEDIUM confidence)
 *    invece di solo HIGH. Questo porta il volume nel range target
 *    150-400 bet/stagione su una lega completa (38 giornate × N partite).
 *    L'utente può passare a selectHighConfidence per essere più conservativo.
 *
 * 2. RANGE ODDS SINTETICI: [1.40, 8.00] allineato con ValueBettingEngine v3.
 *    Il motore genererà quote anche per underdog (quota 4-8) quando
 *    la probabilità implicita è nel range corretto.
 *
 * 3. MARGINE SINTETICO: ridotto a 5% (era 6%). Bookmaker competitivi
 *    (Pinnacle, Betfair) hanno margini realistici del 3-5%.
 *
 * 4. JITTER RIDOTTO: ±6% (era ±8%). Meno rumore → simulazione più realistica
 *    del comportamento di un bookmaker efficiente.
 *
 * 5. marketBreakdown: aggiornato con MarketCategory di v3.
 *
 * 6. evaluateBet: gestisce tutti i mercati inclusi tiri, gialli, falli.
 *    Per i mercati statistici, se il dato reale non è disponibile in MatchData,
 *    la bet viene marcata come non valutabile (return false = considerata persa
 *    dal punto di vista della simulazione → penalizzazione conservativa).
 */

import { DixonColesModel, MatchData } from './DixonColesModel';
import { ValueBettingEngine, BetOpportunity, MarketCategory } from './ValueBettingEngine';

export interface BacktestResult {
  totalMatches: number;
  trainingMatches: number;
  testMatches: number;
  betsPlaced: number;
  betsWon: number;
  totalStaked: number;
  totalReturn: number;
  netProfit: number;
  roi: number;
  winRate: number;
  averageOdds: number;
  averageEV: number;
  brierScore: number;
  logLoss: number;
  calibration: CalibrationBucket[];
  equityCurve: EquityPoint[];
  monthlyStats: MonthlyStats[];
  sharpeRatio: number;
  maxDrawdown: number;
  recoveryFactor: number;
  profitFactor: number;
  marketBreakdown: Record<string, MarketStats>;
}

export interface MarketStats {
  bets: number;
  won: number;
  staked: number;
  returned: number;
  roi: number;
  winRate: number;
  avgOdds: number;
  avgEV: number;
}

export interface CalibrationBucket {
  predictedRange: string;
  predictedAvg: number;
  actualFrequency: number;
  count: number;
}

export interface EquityPoint {
  date: Date;
  matchNumber: number;
  bankroll: number;
  profit: number;
  cumulativeROI: number;
}

export interface MonthlyStats {
  year: number;
  month: number;
  bets: number;
  staked: number;
  returned: number;
  profit: number;
  roi: number;
}

interface TestBet {
  matchDate: Date;
  market: string;
  marketCategory: MarketCategory;
  selection: string;
  odds: number;
  stake: number;
  ourProb: number;
  ev: number;
  won: boolean;
  profit: number;
}

export class BacktestingEngine {
  private model:  DixonColesModel;
  private engine: ValueBettingEngine;
  private readonly INITIAL_BANKROLL = 1000;
  private readonly SYNTHETIC_MARGIN = 1.05;   // 5% margine bookmaker simulato
  private readonly SYNTHETIC_JITTER = 0.06;   // ±6% rumore deterministico
  // Quote sintetiche generate solo nel range dove il modello è affidabile
  private readonly SYN_MIN_ODDS = 1.40;
  private readonly SYN_MAX_ODDS = 8.00;

  constructor() {
    this.model  = new DixonColesModel();
    this.engine = new ValueBettingEngine();
  }

  runBacktest(
    matches: MatchData[],
    historicalOdds: Record<string, Record<string, number>>,
    trainRatio = 0.7,
    confidenceLevel: 'high_only' | 'medium_and_above' = 'medium_and_above'
  ): BacktestResult {
    const sorted   = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
    const splitIdx = Math.floor(sorted.length * trainRatio);
    const trainMatches = sorted.slice(0, splitIdx);
    const testMatches  = sorted.slice(splitIdx);
    const teams = [...new Set(sorted.flatMap(m => [m.homeTeamId, m.awayTeamId]))];

    console.log(`[Backtest] Training: ${trainMatches.length} partite | Test: ${testMatches.length}`);
    this.model.fitModel(trainMatches, teams);

    const bets: TestBet[] = [];
    let bankroll = this.INITIAL_BANKROLL;
    const equityCurve: EquityPoint[] = [
      { date: testMatches[0]?.date ?? new Date(), matchNumber: 0, bankroll, profit: 0, cumulativeROI: 0 }
    ];

    for (let i = 0; i < testMatches.length; i++) {
      const match = testMatches[i];
      if (match.homeGoals === undefined || match.awayGoals === undefined) continue;

      const probs = this.model.computeFullProbabilities(
        match.homeTeamId, match.awayTeamId, match.homeXG, match.awayXG
      );
      const probMap     = probs.flatProbabilities;
      const marketNames = this.buildMarketNames(probMap);
      const odds        = historicalOdds[match.matchId]
        ?? this.generateSyntheticOdds(match.matchId, probMap);

      const allOpportunities = this.engine.analyzeMarkets(probMap, odds, marketNames);
      const selected = confidenceLevel === 'high_only'
        ? this.engine.selectHighConfidence(allOpportunities)
        : this.engine.selectMediumAndAbove(allOpportunities);

      for (const opp of selected) {
        const stakeAmount = (bankroll * opp.suggestedStakePercent) / 100;
        if (stakeAmount > bankroll * 0.04 || stakeAmount < 0.50) continue;

        const won          = this.evaluateBet(opp.selection, match);
        const returnAmount = won ? stakeAmount * opp.bookmakerOdds : 0;
        const profit       = returnAmount - stakeAmount;

        bankroll += profit;
        bets.push({
          matchDate:       match.date,
          market:          opp.marketName,
          marketCategory:  opp.marketCategory,
          selection:       opp.selection,
          odds:            opp.bookmakerOdds,
          stake:           stakeAmount,
          ourProb:         opp.ourProbability / 100,
          ev:              opp.expectedValue  / 100,
          won,
          profit,
        });
      }

      equityCurve.push({
        date:          match.date,
        matchNumber:   i + 1,
        bankroll,
        profit:        bankroll - this.INITIAL_BANKROLL,
        cumulativeROI: ((bankroll - this.INITIAL_BANKROLL) / this.INITIAL_BANKROLL) * 100,
      });
    }

    const result = this.computeMetrics(bets, equityCurve, trainMatches.length, testMatches.length);
    console.log(`[Backtest] Bet piazzate: ${result.betsPlaced} | ROI: ${result.roi.toFixed(2)}%`);
    return result;
  }

  // ==================== QUOTE SINTETICHE ====================

  private deterministicNoise(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) / 4294967295 - 0.5) * 2;
  }

  /**
   * Genera quote sintetiche per tutti i mercati con probabilità plausibile.
   * Applica margine 5% + jitter deterministico ±6%.
   * Genera solo se la quota fair è nel range [SYN_MIN_ODDS, SYN_MAX_ODDS].
   */
  private generateSyntheticOdds(
    matchId: string,
    probMap: Record<string, number>
  ): Record<string, number> {
    const odds: Record<string, number> = {};
    for (const [market, prob] of Object.entries(probMap)) {
      if (!prob || prob <= 0.02 || prob >= 0.98) continue;
      const fairOdds = 1 / prob;
      if (fairOdds < this.SYN_MIN_ODDS || fairOdds > this.SYN_MAX_ODDS) continue;
      const withMargin = fairOdds * this.SYNTHETIC_MARGIN;
      const noise      = this.deterministicNoise(`${matchId}:${market}`);
      const noisy      = withMargin * (1 + noise * this.SYNTHETIC_JITTER);
      odds[market]     = parseFloat(Math.max(1.05, Math.min(20, noisy)).toFixed(3));
    }
    return odds;
  }

  // ==================== NOMI MERCATI ====================

  private buildMarketNames(probMap: Record<string, number>): Record<string, string> {
    const names: Record<string, string> = {
      homeWin: 'Esito - 1', draw: 'Esito - X', awayWin: 'Esito - 2',
      btts: 'Goal Goal', bttsNo: 'No Goal',
      over05:'Over 0.5', under05:'Under 0.5', over15:'Over 1.5', under15:'Under 1.5',
      over25:'Over 2.5', under25:'Under 2.5', over35:'Over 3.5', under35:'Under 3.5',
      over45:'Over 4.5', under45:'Under 4.5',
    };

    for (const key of Object.keys(probMap)) {
      if (names[key]) continue;
      if      (key.startsWith('shotsOver')    && !key.includes('Home') && !key.includes('Away'))
        names[key] = `Tiri Tot Over ${this.lineFromKey(key, 'shotsOver')}`;
      else if (key.startsWith('shotsUnder')   && !key.includes('Home') && !key.includes('Away'))
        names[key] = `Tiri Tot Under ${this.lineFromKey(key, 'shotsUnder')}`;
      else if (key.startsWith('shotsHomeOver'))
        names[key] = `Tiri Casa Over ${this.lineFromKey(key, 'shotsHomeOver')}`;
      else if (key.startsWith('shotsHomeUnder'))
        names[key] = `Tiri Casa Under ${this.lineFromKey(key, 'shotsHomeUnder')}`;
      else if (key.startsWith('shotsAwayOver'))
        names[key] = `Tiri Osp Over ${this.lineFromKey(key, 'shotsAwayOver')}`;
      else if (key.startsWith('shotsAwayUnder'))
        names[key] = `Tiri Osp Under ${this.lineFromKey(key, 'shotsAwayUnder')}`;
      else if (key.startsWith('shotsOTOver'))
        names[key] = `SOT Over ${this.lineFromKey(key, 'shotsOTOver')}`;
      else if (key.startsWith('shotsOTUnder'))
        names[key] = `SOT Under ${this.lineFromKey(key, 'shotsOTUnder')}`;
      else if (key.startsWith('yellowOver'))
        names[key] = `Gialli Over ${this.lineFromKey(key, 'yellowOver')}`;
      else if (key.startsWith('yellowUnder'))
        names[key] = `Gialli Under ${this.lineFromKey(key, 'yellowUnder')}`;
      else if (key.startsWith('foulsOver'))
        names[key] = `Falli Over ${this.lineFromKey(key, 'foulsOver')}`;
      else if (key.startsWith('foulsUnder'))
        names[key] = `Falli Under ${this.lineFromKey(key, 'foulsUnder')}`;
      else if (key.startsWith('exact_'))
        names[key] = `Risultato Esatto ${key.replace('exact_', '')}`;
      else if (key.startsWith('hcp_'))
        names[key] = `Handicap ${key.replace('hcp_', '')}`;
      else
        names[key] = key;
    }
    return names;
  }

  /** "shotsOver155" → "15.5" */
  private lineFromKey(key: string, prefix: string): string {
    const raw = key.slice(prefix.length);
    if (raw.length <= 1) return raw;
    return raw.slice(0, -1) + '.' + raw.slice(-1);
  }

  // ==================== VALUTAZIONE BET ====================

  private evaluateBet(selection: string, match: MatchData): boolean {
    const h = match.homeGoals!;
    const a = match.awayGoals!;
    const total = h + a;

    // --- Goal ---
    const goalMap: Record<string, boolean> = {
      homeWin: h > a, draw: h === a, awayWin: a > h,
      btts: h > 0 && a > 0, bttsNo: h === 0 || a === 0,
      over05: total > 0.5, under05: total <= 0.5,
      over15: total > 1.5, under15: total <= 1.5,
      over25: total > 2.5, under25: total <= 2.5,
      over35: total > 3.5, under35: total <= 3.5,
      over45: total > 4.5, under45: total <= 4.5,
    };
    if (selection in goalMap) return goalMap[selection];

    // --- Exact score ---
    if (selection.startsWith('exact_')) {
      const [gh, ga] = selection.replace('exact_', '').split('-').map(Number);
      return h === gh && a === ga;
    }

    // --- Handicap europeo ---
    if (selection.startsWith('hcp_')) {
      const raw = selection.replace('hcp_', '');
      const isHome = raw.startsWith('home');
      const lineStr = raw.replace(/^(home|away)/, '').replace('+', '');
      const line = parseFloat(lineStr);
      if (!isFinite(line)) return false;
      const diff = isHome ? (h - a + line) : (a - h + line);
      return diff > 0;
    }

    // Metodo riutilizzabile per Over/Under su valore numerico
    const evalOU = (val: number | undefined, key: string, overPrefix: string, underPrefix: string): boolean | null => {
      if (val === undefined) return null;
      if (selection.startsWith(overPrefix)) {
        const line = parseFloat(this.lineFromKey(selection, overPrefix));
        return val > line;
      }
      if (selection.startsWith(underPrefix)) {
        const line = parseFloat(this.lineFromKey(selection, underPrefix));
        return val <= line;
      }
      return null;
    };

    // --- Tiri totali ---
    const totalShots = match.homeTotalShots !== undefined && match.awayTotalShots !== undefined
      ? match.homeTotalShots + match.awayTotalShots : undefined;
    let res = evalOU(totalShots, selection, 'shotsOver', 'shotsUnder');
    if (res !== null && !selection.includes('Home') && !selection.includes('Away') && !selection.includes('OT')) return res;

    // --- Tiri casa ---
    res = evalOU(match.homeTotalShots, selection, 'shotsHomeOver', 'shotsHomeUnder');
    if (res !== null) return res;

    // --- Tiri ospite ---
    res = evalOU(match.awayTotalShots, selection, 'shotsAwayOver', 'shotsAwayUnder');
    if (res !== null) return res;

    // --- Tiri in porta totali ---
    const totalSOT = match.homeShotsOnTarget !== undefined && match.awayShotsOnTarget !== undefined
      ? match.homeShotsOnTarget + match.awayShotsOnTarget : undefined;
    res = evalOU(totalSOT, selection, 'shotsOTOver', 'shotsOTUnder');
    if (res !== null) return res;

    // --- Cartellini gialli totali ---
    const totalYellow = match.homeYellowCards !== undefined && match.awayYellowCards !== undefined
      ? match.homeYellowCards + match.awayYellowCards : undefined;
    res = evalOU(totalYellow, selection, 'yellowOver', 'yellowUnder');
    if (res !== null) return res;

    // --- Falli totali ---
    const totalFouls = match.homeFouls !== undefined && match.awayFouls !== undefined
      ? match.homeFouls + match.awayFouls : undefined;
    res = evalOU(totalFouls, selection, 'foulsOver', 'foulsUnder');
    if (res !== null) return res;

    // Dato non disponibile → conservativamente considerata persa
    return false;
  }

  // ==================== METRICHE ====================

  private computeMetrics(
    bets: TestBet[], equity: EquityPoint[],
    trainCount: number, testCount: number
  ): BacktestResult {
    if (bets.length === 0) return this.emptyResult(trainCount, testCount);

    const won         = bets.filter(b => b.won);
    const totalStaked = bets.reduce((s,b) => s+b.stake, 0);
    const totalReturn = bets.reduce((s,b) => s+(b.won?b.stake*b.odds:0), 0);
    const netProfit   = totalReturn - totalStaked;

    // Market breakdown per categoria
    const breakdown: Record<string, { bets:number; won:number; staked:number; returned:number; oddsSum:number; evSum:number }> = {};
    for (const bet of bets) {
      const cat = bet.marketCategory;
      if (!breakdown[cat]) breakdown[cat] = { bets:0, won:0, staked:0, returned:0, oddsSum:0, evSum:0 };
      breakdown[cat].bets++;
      if (bet.won) breakdown[cat].won++;
      breakdown[cat].staked   += bet.stake;
      breakdown[cat].returned += bet.won ? bet.stake * bet.odds : 0;
      breakdown[cat].oddsSum  += bet.odds;
      breakdown[cat].evSum    += bet.ev;
    }
    const marketBreakdown: Record<string, MarketStats> = {};
    for (const [cat, d] of Object.entries(breakdown)) {
      marketBreakdown[cat] = {
        bets:     d.bets,
        won:      d.won,
        staked:   d.staked,
        returned: d.returned,
        roi:      d.staked > 0 ? ((d.returned - d.staked) / d.staked) * 100 : 0,
        winRate:  d.bets   > 0 ? (d.won / d.bets) * 100 : 0,
        avgOdds:  d.bets   > 0 ? d.oddsSum / d.bets : 0,
        avgEV:    d.bets   > 0 ? (d.evSum   / d.bets) * 100 : 0,
      };
    }

    // Sharpe ratio (daily P&L)
    const dailyR: number[] = [];
    for (let i = 1; i < equity.length; i++) {
      if (equity[i-1].bankroll > 0)
        dailyR.push((equity[i].bankroll - equity[i-1].bankroll) / equity[i-1].bankroll);
    }
    const avgR  = dailyR.reduce((s,r)=>s+r,0)/(dailyR.length||1);
    const stdR  = Math.sqrt(dailyR.reduce((s,r)=>s+(r-avgR)**2,0)/(dailyR.length||1));
    const sharpe = stdR > 0 ? (avgR/stdR)*Math.sqrt(252) : 0;

    // Max drawdown
    let peak = this.INITIAL_BANKROLL, maxDD = 0;
    for (const pt of equity) {
      if (pt.bankroll > peak) peak = pt.bankroll;
      const dd = (peak - pt.bankroll) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    const logLoss = -bets.reduce((s,b) => {
      const p = b.ourProb, y = b.won ? 1 : 0;
      return s + y*Math.log(Math.max(1e-10,p)) + (1-y)*Math.log(Math.max(1e-10,1-p));
    }, 0) / bets.length;

    const brierScore   = bets.reduce((s,b) => s+(b.ourProb-(b.won?1:0))**2, 0) / bets.length;
    const grossWin     = bets.filter(b=>b.profit>0) .reduce((s,b)=>s+b.profit, 0);
    const grossLoss    = Math.abs(bets.filter(b=>b.profit<=0).reduce((s,b)=>s+b.profit, 0));
    const profitFactor = grossLoss>0 ? grossWin/grossLoss : grossWin>0 ? Infinity : 0;

    return {
      totalMatches:    trainCount + testCount,
      trainingMatches: trainCount,
      testMatches:     testCount,
      betsPlaced:      bets.length,
      betsWon:         won.length,
      totalStaked, totalReturn, netProfit,
      roi:          totalStaked>0 ? (netProfit/totalStaked)*100 : 0,
      winRate:      bets.length>0  ? (won.length/bets.length)*100 : 0,
      averageOdds:  bets.reduce((s,b)=>s+b.odds,0)/bets.length,
      averageEV:    bets.reduce((s,b)=>s+b.ev,  0)/bets.length*100,
      brierScore, logLoss,
      calibration:  this.computeCalibration(bets),
      equityCurve:  equity,
      monthlyStats: this.computeMonthlyStats(bets),
      sharpeRatio:  sharpe,
      maxDrawdown:  maxDD*100,
      recoveryFactor: maxDD>0 ? netProfit/(maxDD*this.INITIAL_BANKROLL) : 0,
      profitFactor, marketBreakdown,
    };
  }

  private computeCalibration(bets: TestBet[]): CalibrationBucket[] {
    const buckets = [
      {min:0,max:0.1,label:'0-10%'},{min:0.1,max:0.2,label:'10-20%'},
      {min:0.2,max:0.3,label:'20-30%'},{min:0.3,max:0.4,label:'30-40%'},
      {min:0.4,max:0.5,label:'40-50%'},{min:0.5,max:0.6,label:'50-60%'},
      {min:0.6,max:0.7,label:'60-70%'},{min:0.7,max:0.8,label:'70-80%'},
      {min:0.8,max:1.0,label:'80-100%'},
    ];
    return buckets.map(b => {
      const inB = bets.filter(bet => bet.ourProb>=b.min && bet.ourProb<b.max);
      return {
        predictedRange:  b.label,
        predictedAvg:    inB.length>0 ? inB.reduce((s,bet)=>s+bet.ourProb,0)/inB.length : (b.min+b.max)/2,
        actualFrequency: inB.length>0 ? inB.filter(bet=>bet.won).length/inB.length : 0,
        count:           inB.length,
      };
    });
  }

  private computeMonthlyStats(bets: TestBet[]): MonthlyStats[] {
    const byMonth: Record<string, TestBet[]> = {};
    for (const bet of bets) {
      const key = `${bet.matchDate.getFullYear()}-${bet.matchDate.getMonth()}`;
      (byMonth[key] ??= []).push(bet);
    }
    return Object.entries(byMonth).map(([key, mb]) => {
      const [year, month] = key.split('-').map(Number);
      const staked   = mb.reduce((s,b)=>s+b.stake, 0);
      const returned = mb.reduce((s,b)=>s+(b.won?b.stake*b.odds:0), 0);
      return { year, month:month+1, bets:mb.length, staked, returned,
               profit:returned-staked, roi:staked>0?((returned-staked)/staked)*100:0 };
    }).sort((a,b)=>a.year!==b.year?a.year-b.year:a.month-b.month);
  }

  private emptyResult(trainCount: number, testCount: number): BacktestResult {
    return {
      totalMatches:trainCount+testCount, trainingMatches:trainCount, testMatches:testCount,
      betsPlaced:0, betsWon:0, totalStaked:0, totalReturn:0, netProfit:0,
      roi:0, winRate:0, averageOdds:0, averageEV:0, brierScore:0, logLoss:0,
      calibration:[], equityCurve:[], monthlyStats:[], marketBreakdown:{},
      sharpeRatio:0, maxDrawdown:0, recoveryFactor:0, profitFactor:0,
    };
  }
}