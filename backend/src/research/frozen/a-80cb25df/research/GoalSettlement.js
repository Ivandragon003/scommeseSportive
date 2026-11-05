"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeScoreMatrix = normalizeScoreMatrix;
exports.settleGoalQuote = settleGoalQuote;
exports.evaluateGoalQuote = evaluateGoalQuote;
exports.scoreMatrixMarkets = scoreMatrixMarkets;
/** Normalize a square joint distribution without mutating the caller's data. */
function normalizeScoreMatrix(matrix) {
    if (!Array.isArray(matrix) || matrix.length === 0
        || Array.from(matrix).some((row) => !Array.isArray(row) || row.length !== matrix.length
            || Array.from(row).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
        throw new Error('Score matrix must be square with finite nonnegative cells.');
    }
    const total = matrix.reduce((sum, row) => sum + row.reduce((subtotal, value) => subtotal + value, 0), 0);
    if (!Number.isFinite(total) || total <= 0)
        throw new Error('Score matrix must have positive finite mass.');
    return matrix.map((row) => row.map((value) => value / total));
}
const unresolved = () => ({ status: 'UNRESOLVED', returnMultiplier: null });
const isQuarterLine = (line) => typeof line === 'number'
    && Number.isFinite(line) && Math.abs(line * 4 - Math.round(line * 4)) < 1e-8;
function validQuote(quote) {
    if (!quote || typeof quote !== 'object' || !Number.isFinite(quote.odds) || quote.odds <= 1
        || typeof quote.selection !== 'string' || !quote.selection.trim()
        || typeof quote.bookmaker !== 'string' || !quote.bookmaker.trim()
        || typeof quote.source !== 'string' || !quote.source.trim()
        || /synthetic|model|estimated|^unknown$/i.test(quote.source.trim())
        || typeof quote.capturedAt !== 'string' || !Number.isFinite(Date.parse(quote.capturedAt)))
        return false;
    if (quote.timestampEvidence !== 'observed_snapshot'
        && (typeof quote.updatedAt !== 'string' || !Number.isFinite(Date.parse(quote.updatedAt))))
        return false;
    if (quote.updatedAt !== undefined && !Number.isFinite(Date.parse(quote.updatedAt)))
        return false;
    switch (quote.market) {
        case '1x2': return ['home', 'draw', 'away'].includes(quote.side);
        case 'double_chance': return ['1x', 'x2', '12'].includes(quote.side);
        case 'dnb': return ['home', 'away'].includes(quote.side);
        case 'btts': return ['yes', 'no'].includes(quote.side);
        case 'totals': return ['over', 'under'].includes(quote.side) && isQuarterLine(quote.line) && quote.line >= 0;
        case 'team_totals': return ['over', 'under'].includes(quote.side) && ['home', 'away'].includes(quote.team)
            && isQuarterLine(quote.line) && quote.line >= 0;
        case 'european_handicap': return ['home', 'draw', 'away'].includes(quote.side)
            && typeof quote.line === 'number' && Number.isSafeInteger(quote.line);
        case 'asian_handicap': return ['home', 'away'].includes(quote.side) && isQuarterLine(quote.line);
        default: return false;
    }
}
function binarySettlement(won, odds) {
    return { status: won ? 'WON' : 'LOST', returnMultiplier: won ? odds : 0 };
}
function lineSettlement(margin, odds) {
    if (margin === 0)
        return { status: 'VOID', returnMultiplier: 1 };
    return binarySettlement(margin > 0, odds);
}
/** Quarter lines split the stake equally across the adjacent half-goal lines. */
function splitLineSettlement(line, odds, marginAt) {
    const doubled = line * 2;
    if (Math.abs(doubled - Math.round(doubled)) < 1e-8)
        return lineSettlement(marginAt(line), odds);
    const lower = lineSettlement(marginAt(Math.floor(doubled) / 2), odds);
    const upper = lineSettlement(marginAt(Math.ceil(doubled) / 2), odds);
    if (lower.status === upper.status)
        return lower;
    const status = lower.status === 'WON' || upper.status === 'WON' ? 'HALF_WON' : 'HALF_LOST';
    return { status, returnMultiplier: (lower.returnMultiplier + upper.returnMultiplier) / 2 };
}
function settleValidQuote(quote, homeGoals, awayGoals) {
    const difference = homeGoals - awayGoals;
    switch (quote.market) {
        case '1x2': return binarySettlement(quote.side === 'home' ? difference > 0
            : quote.side === 'away' ? difference < 0 : difference === 0, quote.odds);
        case 'double_chance': return binarySettlement(quote.side === '1x' ? difference >= 0
            : quote.side === 'x2' ? difference <= 0 : difference !== 0, quote.odds);
        case 'dnb': return lineSettlement(quote.side === 'home' ? difference : -difference, quote.odds);
        case 'btts': return binarySettlement((homeGoals > 0 && awayGoals > 0) === (quote.side === 'yes'), quote.odds);
        case 'totals':
        case 'team_totals': {
            const actual = quote.market === 'totals' ? homeGoals + awayGoals : quote.team === 'home' ? homeGoals : awayGoals;
            return splitLineSettlement(quote.line, quote.odds, (line) => quote.side === 'over' ? actual - line : line - actual);
        }
        // European lines always describe the adjustment to the home team. Draw is a third winning selection.
        case 'european_handicap': {
            const adjusted = difference + quote.line;
            return binarySettlement(quote.side === 'home' ? adjusted > 0
                : quote.side === 'away' ? adjusted < 0 : adjusted === 0, quote.odds);
        }
        // Asian lines are expressed from the selected team's perspective, including away selections.
        case 'asian_handicap': return splitLineSettlement(quote.line, quote.odds, (line) => (quote.side === 'home' ? difference : -difference) + line);
    }
}
function settleGoalQuote(quote, homeGoals, awayGoals) {
    if (!validQuote(quote) || !Number.isSafeInteger(homeGoals) || !Number.isSafeInteger(awayGoals)
        || homeGoals < 0 || awayGoals < 0)
        return unresolved();
    return settleValidQuote(quote, homeGoals, awayGoals);
}
/** Probability is conditional on the stake shares that win or lose; all-push distributions use 0.5. */
function evaluateGoalQuote(matrix, quote) {
    if (!validQuote(quote))
        throw new Error('Invalid real bookmaker goal quote.');
    const normalized = normalizeScoreMatrix(matrix);
    const result = { probability: 0, win: 0, loss: 0, push: 0, halfWin: 0, halfLoss: 0, expectedValue: 0 };
    let expectedReturn = 0;
    for (let home = 0; home < normalized.length; home++) {
        for (let away = 0; away < normalized.length; away++) {
            const mass = normalized[home][away];
            const outcome = settleValidQuote(quote, home, away);
            if (outcome.status === 'WON')
                result.win += mass;
            if (outcome.status === 'LOST')
                result.loss += mass;
            if (outcome.status === 'VOID')
                result.push += mass;
            if (outcome.status === 'HALF_WON')
                result.halfWin += mass;
            if (outcome.status === 'HALF_LOST')
                result.halfLoss += mass;
            expectedReturn += mass * outcome.returnMultiplier;
        }
    }
    const winShares = result.win + result.halfWin / 2;
    const lossShares = result.loss + result.halfLoss / 2;
    result.probability = winShares + lossShares > 0 ? winShares / (winShares + lossShares) : 0.5;
    result.expectedValue = expectedReturn - 1;
    return result;
}
/** Flat probability keys match the goal catalog; neither quote selection nor post-match data are consulted. */
function scoreMatrixMarkets(matrix) {
    const normalized = normalizeScoreMatrix(matrix);
    let homeWin = 0, draw = 0, awayWin = 0, btts = 0;
    for (let home = 0; home < normalized.length; home++)
        for (let away = 0; away < normalized.length; away++) {
            const mass = normalized[home][away];
            if (home > away)
                homeWin += mass;
            else if (home < away)
                awayWin += mass;
            else
                draw += mass;
            if (home > 0 && away > 0)
                btts += mass;
        }
    const nonDraw = homeWin + awayWin;
    const markets = {
        homeWin, draw, awayWin, btts, bttsNo: 1 - btts,
        double_chance_1x: homeWin + draw, double_chance_x2: draw + awayWin, double_chance_12: nonDraw,
        dnb_home: nonDraw > 0 ? homeWin / nonDraw : 0.5, dnb_away: nonDraw > 0 ? awayWin / nonDraw : 0.5,
    };
    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
        let totalOver = 0, homeOver = 0, awayOver = 0;
        for (let home = 0; home < normalized.length; home++)
            for (let away = 0; away < normalized.length; away++) {
                const mass = normalized[home][away];
                if (home + away > line)
                    totalOver += mass;
                if (home > line)
                    homeOver += mass;
                if (away > line)
                    awayOver += mass;
            }
        const key = String(line).replace('.', '');
        markets[`over${key}`] = totalOver;
        markets[`under${key}`] = 1 - totalOver;
        markets[`team_home_over_${line}`] = homeOver;
        markets[`team_home_under_${line}`] = 1 - homeOver;
        markets[`team_away_over_${line}`] = awayOver;
        markets[`team_away_under_${line}`] = 1 - awayOver;
    }
    return markets;
}
