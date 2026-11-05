export declare const predictionConfig: {
    model: {
        homeAdvantageScale: number;
        contextWeights: {
            form: number;
            motivation: number;
            absences: number;
            discipline: number;
        };
    };
    markets: {
        minSampleSizePerTeam: number;
        minCombinedSampleSize: number;
    };
    playerGoals: {
        xgShrink: number;
    };
};
/**
 * Media gialli/match per lega (empirica, 4 stagioni su DB, 2026-07). Usata SOLO
 * dal modello cartellino GIOCATORE (B6): prima usava le costanti hardcoded
 * leagueAvgTeamYellows=1.9 / leagueAvgRefereeYellow=3.8, che sovrastimavano il
 * moltiplicatore-disciplina in La Liga (reale 4.58/match, non 3.8) e lo
 * sottostimavano in Ligue 1. NON usata dal modello squadra (il parametro
 * per-lega li' e' documentato NO-GO). Aggiornare rigirando la query per-lega.
 */
export declare const LEAGUE_AVG_YELLOW_PER_MATCH: Record<string, number>;
export declare const DEFAULT_LEAGUE_AVG_YELLOW_PER_MATCH = 3.9;
export declare function resolveLeagueAvgYellowPerMatch(competition?: string | null): number;
