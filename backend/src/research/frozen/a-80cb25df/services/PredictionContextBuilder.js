"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PredictionContextBuilder = void 0;
const MathUtils_1 = require("../models/utils/MathUtils");
const predictionConfig_1 = require("../config/predictionConfig");
class PredictionContextBuilder {
    toFiniteNumber(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    normalizeFormIndex(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed))
            return 0.5;
        return (0, MathUtils_1.clamp)(parsed, 0, 1);
    }
    parseJson(value) {
        if (typeof value !== 'string' || value.trim().length === 0)
            return null;
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : null;
        }
        catch {
            return null;
        }
    }
    toPlayerData(player) {
        return {
            playerId: String(player?.player_id ?? player?.playerId ?? ''),
            playerName: String(player?.name ?? player?.playerName ?? 'Unknown'),
            teamId: String(player?.team_id ?? player?.teamId ?? ''),
            avgShotsPerGame: Number(player?.avg_shots_per_game ?? player?.avgShotsPerGame ?? 0),
            avgShotsOnTargetPerGame: Number(player?.avg_shots_on_target_per_game ?? player?.avgShotsOnTargetPerGame ?? 0),
            gamesPlayed: Math.max(0, Number(player?.games_played ?? player?.gamesPlayed ?? 0)),
            shotShareOfTeam: Math.max(0, Number(player?.shot_share_of_team ?? player?.shotShareOfTeam ?? 0)),
            isStarter: player?.isStarter !== false,
            positionCode: String(player?.position_code ?? player?.positionCode ?? 'MF'),
        };
    }
    readVenueStats(teamRow, venue) {
        const json = this.parseJson(teamRow?.team_stats_json);
        const venueNode = json?.computed?.[venue] ?? json?.[venue] ?? {};
        return {
            sampleSize: this.toFiniteNumber(venueNode?.sampleSize ?? venueNode?.games ?? venueNode?.matches),
            avgPossession: this.toFiniteNumber(venueNode?.avgPossession ?? venueNode?.possession),
            avgCornersConceded: this.toFiniteNumber(venueNode?.avgCornersConceded ?? venueNode?.cornersConceded),
            varShots: this.toFiniteNumber(venueNode?.varShots),
            varShotsOT: this.toFiniteNumber(venueNode?.varShotsOT ?? venueNode?.varShotsOnTarget),
            varYellowCards: this.toFiniteNumber(venueNode?.varYellowCards ?? venueNode?.varYellow),
            varFouls: this.toFiniteNumber(venueNode?.varFouls),
        };
    }
    buildTeamStats(teamRow, venue) {
        const venueStats = this.readVenueStats(teamRow, venue);
        const json = this.parseJson(teamRow?.team_stats_json);
        const foulsDrawnPerMatch = this.toFiniteNumber(json?.computed?.rates?.foulsDrawnPerMatch);
        return {
            avgShots: Number((venue === 'home'
                ? teamRow?.avg_home_shots ?? 12.1
                : teamRow?.avg_away_shots ?? 10.4)),
            avgShotsOT: Number((venue === 'home'
                ? teamRow?.avg_home_shots_ot ?? 4.8
                : teamRow?.avg_away_shots_ot ?? 3.9)),
            avgYellowCards: Number(teamRow?.avg_yellow_cards ?? 1.9),
            avgRedCards: Number(teamRow?.avg_red_cards ?? 0.11),
            avgFouls: Number(teamRow?.avg_fouls ?? 11.2),
            shotsSuppression: Number(teamRow?.shots_suppression ?? 1.0),
            avgHomeCorners: this.toFiniteNumber(teamRow?.avg_home_corners ?? 5.5),
            avgAwayCorners: this.toFiniteNumber(teamRow?.avg_away_corners ?? 4.5),
            avgCornersConceded: venueStats.avgCornersConceded,
            avgFoulsDrawn: foulsDrawnPerMatch,
            avgPossession: venueStats.avgPossession,
            varShots: venueStats.varShots,
            varShotsOT: venueStats.varShotsOT,
            varYellowCards: venueStats.varYellowCards,
            varFouls: venueStats.varFouls,
            sampleSize: venueStats.sampleSize,
        };
    }
    buildContextAdjustments(request, competitiveness) {
        const formDelta = (0, MathUtils_1.clamp)(Number(request.homeFormIndex ?? 0.5) - Number(request.awayFormIndex ?? 0.5), -1, 1);
        const motivationDelta = (0, MathUtils_1.clamp)(Number(request.homeObjectiveIndex ?? 0.5) - Number(request.awayObjectiveIndex ?? 0.5), -1, 1);
        const restDelta = (0, MathUtils_1.clamp)((Number(request.homeRestDays ?? 6) - Number(request.awayRestDays ?? 6)) / 10, -1, 1);
        const scheduleLoadDelta = (0, MathUtils_1.clamp)((Number(request.awayRecentMatchesCount ?? 0) - Number(request.homeRecentMatchesCount ?? 0)) / 4, -1, 1);
        const homeAbsenceLoad = Number(request.homeSuspensions ?? 0) + Number(request.homeKeyAbsences ?? 0) * 1.35;
        const awayAbsenceLoad = Number(request.awaySuspensions ?? 0) + Number(request.awayKeyAbsences ?? 0) * 1.35;
        /**
         * absencesDelta scalato per profondità rosa.
         *
         * VECCHIO: divisore fisso /6 — perdere 2 titolari su 16 pesava
         * uguale che perderli su 26. Distorsione strutturale reale.
         *
         * NUOVO: il divisore è proporzionale alla dimensione della rosa.
         * Formula: absenceDivisor = rosterDepth × ABSENCE_IMPACT_RATE
         *   dove ABSENCE_IMPACT_RATE = 0.28 calibrato su Serie A:
         *   una rosa da 22 → divisore ≈ 6.16 (vicino al vecchio /6)
         *   una rosa da 16 → divisore ≈ 4.5  (impatto maggiore)
         *   una rosa da 28 → divisore ≈ 7.8  (impatto minore)
         *
         * Questo cattura la realtà: il Napoli con 26 giocatori sente
         * meno le assenze dell'Empoli con 17 disponibili.
         */
        const ABSENCE_IMPACT_RATE = 0.28;
        const DEFAULT_ROSTER_DEPTH = 22;
        const homeDepth = Math.max(13, Number(request.homeRosterDepth ?? DEFAULT_ROSTER_DEPTH));
        const awayDepth = Math.max(13, Number(request.awayRosterDepth ?? DEFAULT_ROSTER_DEPTH));
        const homeAbsenceDivisor = homeDepth * ABSENCE_IMPACT_RATE;
        const awayAbsenceDivisor = awayDepth * ABSENCE_IMPACT_RATE;
        // Delta normalizzato: positivo = home ha meno assenze (vantaggio home)
        const absencesDelta = (0, MathUtils_1.clamp)(awayAbsenceLoad / awayAbsenceDivisor - homeAbsenceLoad / homeAbsenceDivisor, -1, 1);
        const disciplineDelta = (0, MathUtils_1.clamp)(Number(request.awayRecentRedCards ?? 0) - Number(request.homeRecentRedCards ?? 0), -1, 1);
        const atRiskTotal = (0, MathUtils_1.clamp)((Number(request.homeDiffidati ?? 0) + Number(request.awayDiffidati ?? 0)) / 10, 0, 1);
        /**
         * goalBias con termine di interazione non lineare forma × assenze.
         *
         * VECCHIO: somma lineare — forma e assenze contribuiscono
         * indipendentemente al bias. Ma l'effetto reale è diverso:
         * una squadra in forma eccellente (formIndex 0.9) che perde
         * un titolare chiave soffre meno di una in forma mediocre (0.4)
         * che perde lo stesso giocatore. La forma attenua l'impatto
         * delle assenze e viceversa.
         *
         * NUOVO: aggiungo un termine di interazione moltiplicativo
         *   interactionTerm = formDelta × absencesDelta × INTERACTION_WEIGHT
         *
         * Interpretazione:
         * - formDelta > 0 e absencesDelta > 0 (home meglio in forma
         *   E meno assenze): l'interazione AMPLIFICA il vantaggio home
         * - formDelta > 0 ma absencesDelta < 0 (home in forma ma con
         *   più assenze): l'interazione ATTENUA il vantaggio forma
         *
         * INTERACTION_WEIGHT = 0.04: piccolo ma non trascurabile.
         * Evita di dominare i termini principali.
         */
        const INTERACTION_WEIGHT = 0.04;
        const formAbsenceInteraction = formDelta * absencesDelta * INTERACTION_WEIGHT;
        const goalBias = formDelta * predictionConfig_1.predictionConfig.model.contextWeights.form +
            motivationDelta * predictionConfig_1.predictionConfig.model.contextWeights.motivation +
            restDelta * 0.05 +
            scheduleLoadDelta * 0.04 +
            absencesDelta * predictionConfig_1.predictionConfig.model.contextWeights.absences +
            disciplineDelta * predictionConfig_1.predictionConfig.model.contextWeights.discipline +
            formAbsenceInteraction; // termine di interazione non lineare
        const shotBias = formDelta * predictionConfig_1.predictionConfig.model.contextWeights.form * 0.75 +
            motivationDelta * predictionConfig_1.predictionConfig.model.contextWeights.motivation * 0.67 +
            restDelta * 0.04 +
            scheduleLoadDelta * 0.03 +
            absencesDelta * predictionConfig_1.predictionConfig.model.contextWeights.absences * 0.8 +
            formAbsenceInteraction * 0.6; // attenuato per i tiri (effetto minore)
        // FIX ASIMMETRIA: i moltiplicatori home/away non sono semplicemente 1±bias.
        // Se entrambe le squadre sono in buona forma, il moltiplicatore assoluto
        // dovrebbe essere alto per entrambe. Usiamo un livello base (formLevel)
        // che eleva entrambe le squadre proporzionalmente al loro valore assoluto.
        //
        // homeGoalMultiplier = base_home × (1 + biasComponent)
        // awayGoalMultiplier = base_away × (1 − biasComponent)
        //
        // dove base_home/away riflette la forma assoluta della squadra:
        //   base_home = 1 + (homeFormIndex − 0.5) × 0.08
        //   base_away = 1 + (awayFormIndex − 0.5) × 0.08
        //
        // Questo evita che una forma alta di entrambe si "cancelli" nel delta.
        const homeFormAbs = (0, MathUtils_1.clamp)((Number(request.homeFormIndex ?? 0.5) - 0.5) * 0.08, -0.04, 0.04);
        const awayFormAbs = (0, MathUtils_1.clamp)((Number(request.awayFormIndex ?? 0.5) - 0.5) * 0.08, -0.04, 0.04);
        // Bias differenziale puro (esclude la forma assoluta già catturata sopra)
        const pureGoalBias = goalBias - formDelta * predictionConfig_1.predictionConfig.model.contextWeights.form * 0.5;
        const pureShotBias = shotBias - formDelta * predictionConfig_1.predictionConfig.model.contextWeights.form * 0.75 * 0.5;
        return {
            homeGoalMultiplier: (0, MathUtils_1.clamp)(1 + homeFormAbs + pureGoalBias, 0.72, 1.35),
            awayGoalMultiplier: (0, MathUtils_1.clamp)(1 + awayFormAbs - pureGoalBias, 0.72, 1.35),
            homeShotMultiplier: (0, MathUtils_1.clamp)(1 + homeFormAbs * 0.8 + pureShotBias, 0.75, 1.30),
            awayShotMultiplier: (0, MathUtils_1.clamp)(1 + awayFormAbs * 0.8 - pureShotBias, 0.75, 1.30),
            yellowCardMultiplier: (0, MathUtils_1.clamp)(1 + competitiveness * 0.08 + atRiskTotal * 0.04 + Math.abs(disciplineDelta) * 0.05 + Math.abs(scheduleLoadDelta) * 0.03, 0.9, 1.35),
            foulMultiplier: (0, MathUtils_1.clamp)(1 + competitiveness * 0.05 + atRiskTotal * 0.03 + Math.abs(disciplineDelta) * 0.04 + Math.abs(scheduleLoadDelta) * 0.025, 0.92, 1.25),
            homePossessionShift: (0, MathUtils_1.clamp)(formDelta * 0.03 + motivationDelta * 0.015 + absencesDelta * 0.02, -0.08, 0.08),
        };
    }
    build(params) {
        const { request, homeTeam, awayTeam, referee, homePlayers, awayPlayers } = params;
        const normalizedRequest = {
            ...request,
            homeFormIndex: this.normalizeFormIndex(request.homeFormIndex),
            awayFormIndex: this.normalizeFormIndex(request.awayFormIndex),
        };
        const competitiveness = normalizedRequest.competitiveness !== undefined
            ? (0, MathUtils_1.clamp)(Number(normalizedRequest.competitiveness), 0, 1)
            : (0, MathUtils_1.clamp)(0.30 +
                (normalizedRequest.isDerby ? 0.35 : 0) +
                (normalizedRequest.isHighStakes ? 0.20 : 0), 0, 1);
        const homeTeamStats = homeTeam ? this.buildTeamStats(homeTeam, 'home') : undefined;
        const awayTeamStats = awayTeam ? this.buildTeamStats(awayTeam, 'away') : undefined;
        const contextAdjustments = this.buildContextAdjustments(normalizedRequest, competitiveness);
        const refereeStats = referee
            ? {
                avgYellow: Number(referee?.avg_yellow_cards_per_game ?? 3.8),
                avgRed: Number(referee?.avg_red_cards_per_game ?? 0.22),
                avgFouls: Number(referee?.avg_fouls_per_game ?? 22.4),
                sampleSize: this.toFiniteNumber(referee?.total_games),
            }
            : undefined;
        const sampleBase = Math.min(Number(homeTeamStats?.sampleSize ?? 0), Number(awayTeamStats?.sampleSize ?? 0));
        const hasBothXg = Number.isFinite(Number(homeTeam?.avg_home_xg)) &&
            Number.isFinite(Number(awayTeam?.avg_away_xg));
        const playerCoverage = Math.min(homePlayers.length, awayPlayers.length) > 0 ? 1 : 0;
        const refereeCoverage = refereeStats?.sampleSize ? 1 : 0;
        const homeHistoricalCoverage = params.homeHistoricalCoverage ?? null;
        const awayHistoricalCoverage = params.awayHistoricalCoverage ?? null;
        const matchCoveragePercent = homeHistoricalCoverage && awayHistoricalCoverage
            ? Math.min((0, MathUtils_1.clamp)(Number(homeHistoricalCoverage.coveragePercent ?? 0), 0, 100), (0, MathUtils_1.clamp)(Number(awayHistoricalCoverage.coveragePercent ?? 0), 0, 100))
            : null;
        // FIX BASELINE: partire da 0.30 anziché 0.45 — un richnessScore di 0.45
        // senza dati reali dava falsa confidenza al modello. La baseline 0.30
        // riflette l'incertezza genuina quando mancano statistiche di supporto.
        // Il ceiling rimane 0.93: con sample largo + xg + player data + arbitro
        // si raggiunge ~0.91, lasciando 0.02 di margine per scenari futuri.
        const baseRichnessScore = (0, MathUtils_1.clamp)(0.30 +
            Math.min(1, sampleBase / 24) * 0.32 +
            (hasBothXg ? 0.12 : 0) +
            playerCoverage * 0.10 +
            refereeCoverage * 0.06, 0.30, 0.93);
        // Historical coverage is match-scoped. Full coverage leaves the existing
        // score unchanged; partial coverage reduces confidence conservatively.
        // Missing coverage metadata is neutral for backwards compatibility.
        const coverageMultiplier = matchCoveragePercent === null
            ? 1
            : 0.70 + (matchCoveragePercent / 100) * 0.30;
        const richnessScore = (0, MathUtils_1.clamp)(baseRichnessScore * coverageMultiplier, 0.30, 0.93);
        return {
            supplementaryData: {
                homeTeamStats,
                awayTeamStats,
                refereeStats,
                homePlayers: homePlayers.map((player) => this.toPlayerData(player)),
                awayPlayers: awayPlayers.map((player) => this.toPlayerData(player)),
                competitiveness,
                isDerby: Boolean(normalizedRequest.isDerby),
                contextAdjustments,
            },
            competitiveness,
            homeXG: this.toFiniteNumber(homeTeam?.avg_home_xg),
            awayXG: this.toFiniteNumber(awayTeam?.avg_away_xg),
            richnessScore: Number(richnessScore.toFixed(3)),
            historicalCoverage: {
                home: homeHistoricalCoverage,
                away: awayHistoricalCoverage,
                matchCoveragePercent,
            },
        };
    }
}
exports.PredictionContextBuilder = PredictionContextBuilder;
