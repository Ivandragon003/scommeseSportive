export type PlayerCardRole = 'forward' | 'winger' | 'attacking_midfielder' | 'midfielder' | 'fullback' | 'centreback' | 'goalkeeper' | 'unknown';
export interface PlayerYellowCardsInput {
    playerId: string;
    playerName: string;
    role: PlayerCardRole;
    playerYellowCards: number;
    playerMinutes: number;
    expectedMinutes: number;
    playerFoulsCommittedPer90?: number;
    teamExpectedYellows: number;
    leagueAvgTeamYellows: number;
    refereeYellowAvg: number;
    leagueAvgRefereeYellow: number;
    refereeCoverage?: number;
    teamYellowInfluenceWeight?: number;
    minMinutesForStableCards?: number;
}
export interface PlayerYellowCardsPrediction {
    playerId: string;
    playerName: string;
    role: PlayerCardRole;
    expectedPlayerYellows: number;
    probabilityYellowOver0_5: number;
    fullDistribution: Record<number, number>;
    confidence: number;
    sampleSize: number;
    modelUsed: 'ZIP';
}
export declare class PlayerCardsModel {
    predictPlayerYellowCards(input: PlayerYellowCardsInput): PlayerYellowCardsPrediction;
}
