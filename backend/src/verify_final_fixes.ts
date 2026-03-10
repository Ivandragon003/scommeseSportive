import { PredictionService } from './services/PredictionService';
import { DatabaseService } from './db/DatabaseService';

async function verify() {
    const db = new DatabaseService();
    const svc = new PredictionService(db);

    console.log('--- Final Refined Verification ---');
    try {
        const odds = {
            'shots_total_over_23.5': 1.90,
            'shots_home_over_11.5': 1.85,
            'sot_total_over_7.5': 2.10,
            'yellow_over_3.5': 1.80,
        };

        console.log('Testing alignOddsKeys with domain mapping...');
        const aligned = (svc as any).alignOddsKeys(odds);
        console.log('Aligned keys:', Object.keys(aligned));

        const expectedKeys = ['shotsOver235', 'shotsHomeOver115', 'shotsOTOver75', 'yellowOver35'];
        const missing = expectedKeys.filter(k => !aligned[k]);

        if (missing.length > 0) {
            console.error('FAILED: Missing critical aligned keys:', missing);
        } else {
            console.log('SUCCESS: All domain-mapped keys are present.');
        }

        console.log('Testing enrichFlatProbabilities for camelCase keys...');
        const flatProbs: any = {
            'homeWin': 0.45,
            'draw': 0.25,
            'awayWin': 0.30,
            'btts': 0.52
        };
        (svc as any).enrichFlatProbabilities(flatProbs);
        console.log('Enriched keys:', Object.keys(flatProbs));

        if (flatProbs.dnb_home > 0 && flatProbs.double_chance_1x > 0) {
            console.log(`SUCCESS: DNB Home (${flatProbs.dnb_home.toFixed(3)}) and DC 1X (${flatProbs.double_chance_1x.toFixed(3)}) calculated correctly.`);
        } else {
            console.error('FAILED: CamelCase keys not recognized in enrichment.');
        }

        console.log('--- Verification Complete ---');
    } catch (err) {
        console.error('Verification script crashed:', err);
    }
}

verify();
