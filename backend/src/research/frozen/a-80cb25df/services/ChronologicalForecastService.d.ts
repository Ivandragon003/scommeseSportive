import { MatchData } from '../models/core/DixonColesModel';
export declare const HISTORICAL_RESULT_DELAY_MS: number;
export interface HistoricalForecast {
    match: MatchData;
    probabilities: Record<string, number>;
    availableAt: number;
}
export interface ChronologicalForecastOptions {
    asOf: Date;
    maxForecastMatches?: number;
    minTrainingMatches?: number;
    refitIntervalMs?: number;
    createPredictor: (pastMatches: MatchData[], referenceDate: Date) => (target: MatchData, pastMatches: MatchData[]) => Record<string, number>;
}
export declare function buildChronologicalForecasts(matches: MatchData[], options: ChronologicalForecastOptions): HistoricalForecast[];
/** Keep HTTP/health requests responsive between historical fits/forecast batches. */
export declare function buildChronologicalForecastsAsync(matches: MatchData[], options: ChronologicalForecastOptions): Promise<HistoricalForecast[]>;
