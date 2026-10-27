/* Offline only. Reads a supplied calendar; never constructs a provider client. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const modulePath = process.env.ODDS_DEMAND_TEST_MODULE
  || path.join(__dirname, '../dist/services/odds-provider/OddsDemandSimulation.js');
const { simulateOddsDemandScenarios, simulateOddsDemandMonth, originalMonthlyApproximation } = require(modulePath);
const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!process.argv[index].startsWith('--') || !process.argv[index + 1]) throw new Error('Expected --option value');
  args[process.argv[index].slice(2)] = process.argv[index + 1];
}
if (!args.input || !args.asof || !args.month || !args['output-json'] || !args['output-md']) {
  throw new Error('--input, --asof, --month, --output-json and --output-md required');
}
const data = fs.readFileSync(args.input);
const fixtures = JSON.parse(data);
const main = simulateOddsDemandScenarios(fixtures, args.month, args.asof);
const months = [...new Set(fixtures.map((row) => row.date?.slice(0, 7)).filter(Boolean))].sort();
const concise = (run) => ({ groups: run.groupCount, eligibleFixtures: run.calendar.eligibleFixtureCount,
  completedFixtures: run.calendar.completedFixtureCount, futureUnverifiedFixtures: run.calendar.futureUnverifiedFixtureCount,
  requiredCredits: run.credits.requiredWithoutBudgetLimit, admittedCredits: run.credits.admitted,
  requiredHttpRequests: run.httpRequests.requiredWithoutBudgetLimit, admittedHttpRequests: run.httpRequests.admitted,
  coveredFixtures: run.coverage.coveredFixtures, skippedFixtures: run.coverage.skippedFixtures,
  fixtureCoverageFraction: run.coverage.fraction, cacheHitGroups: run.coverage.cacheHitGroups });
const monthly = months.map((month) => {
  const scenarios = simulateOddsDemandScenarios(fixtures, month, args.asof);
  return { month, calendarPastAsOfExport: month < args.asof.slice(0, 7),
    legacy: concise(scenarios.currentCallPaths), conservative: concise(scenarios.optimizedConservative),
    priority: concise(scenarios.optimizedT15Priority) };
});
const historical = monthly.filter((row) => row.calendarPastAsOfExport && row.conservative.eligibleFixtures > 0);
const worst = [...historical].sort((a, b) => b.conservative.requiredCredits - a.conservative.requiredCredits)[0];
const freshFiveMinuteCacheSensitivity = simulateOddsDemandMonth(fixtures, { month: args.month, asOf: args.asof,
  monthlyBudgetCredits: 500, reserveCredits: 50, reserveAppliesToT15: true, retryRate: .1,
  nightlyOddsEnabled: false, cacheWindowSeconds: 300, providerPriceAgeAtFetchSeconds: 0 });
const output = { schemaVersion: 'odds-demand-report-v1', offlineOnly: true,
  input: { path: args.input, sha256: crypto.createHash('sha256').update(data).digest('hex'), asOf: args.asof,
    matchCount: fixtures.length, completenessVerified: false },
  primaryMonth: main, freshFiveMinuteCacheSensitivity: concise(freshFiveMinuteCacheSensitivity),
  historicalMonthStress: worst, monthly,
  priorApproximation: originalMonthlyApproximation(),
  officialSources: [
    { url: 'https://the-odds-api.com/liveapi/guides/v4/', support: 'odds market/region cost, scores daysFrom cost, free events list, quota response headers' },
    { url: 'https://the-odds-api.com/', support: 'nominal free plan 500 credits per month' },
    { url: 'https://the-odds-api.com/manage/faqs.html', support: 'monthly reset; exact reset timezone not independently confirmed' },
  ],
  limitations: [
    'This report performs no HTTP request and measures no account quota or actual bookmaker coverage.',
    'UTC calendar months are an accounting scenario; exact provider reset timezone has not been independently confirmed.',
    'A request asking for three core markets in one EU region is budgeted as three credits. Empty odds responses can cost zero; fewer returned markets may reduce actual event-odds cost.',
    'Current-call-path scenario means the old nightly quote flag enabled as a counterfactual; local optimization disables it. Optional kickoff h2h plus scores calls exist but their daily frequency is not established.',
    'The two model portfolios share a feed; credits are not multiplied by A and C.',
    'Future schedules can be provisional even when exported as exact ISO strings. Such grouped demand is not a verified forecast.',
    'UI and extra-market costs are zero only in the explicit cache-only informational policy. Unrestricted direct refresh can consume additional quota.',
    'Coverage percentages refer to fixtures available in this export, not a proven complete calendar, valid quotes, placed bets or profitability.',
  ] };
fs.mkdirSync(path.dirname(args['output-json']), { recursive: true });
fs.writeFileSync(args['output-json'], `${JSON.stringify(output, null, 2)}\n`);
const percentage = (value) => value == null ? 'n.d.' : `${(value * 100).toFixed(1)}%`;
const b = main.optimizedConservative, p = main.optimizedT15Priority, a = main.currentCallPaths;
const rows = [
  ['A: vecchia nightly quote attiva, nessuna quota aggiuntiva UI', a],
  ['B: nightly quote spenta, riserva 50 intatta', b],
  ['B prioritaria: T−15 può usare anche la riserva', p],
  ['Sensibilità: refresh kickoff una volta al giorno per lega', main.kickoffRefreshSensitivityOnceDaily],
];
const lines = ['# Domanda quote mensile — simulazione offline del 27 ottobre 2026', '',
  '**Nessuna chiamata provider è stata effettuata.** I crediti sono stimati, non consumi osservati o un saldo disponibile certificato.', '',
  '## Fonti, copertura e regole', '',
  `Fonte: export locale di ${fixtures.length} partite Understat normalizzate dei cinque campionati, SHA-256 \`${output.input.sha256}\`. Non vengono usate soltanto le giocate o le 7.323 righe ML: vengono considerate tutte le fixture ammissibili del calendario esportato.`, '',
  'La documentazione [The Odds API v4](https://the-odds-api.com/liveapi/guides/v4/) distingue richieste HTTP e crediti: quote core = mercati × regioni; la richiesta sui punteggi con `daysFrom` costa 2 crediti. L’elenco `/events` è gratuito e non richiede il feed h2h né scores per conoscere gli eventi. Il [piano gratuito](https://the-odds-api.com/) pubblicizza 500 crediti mensili. Gli header `x-requests-last`, `used` e `remaining` restano la fonte operativa del consumo.', '',
  'Una chiamata sport/lega con h2h, totals e spreads in EU viene pianificata come 1 HTTP / 3 crediti. La stessa richiesta evento non diventa più economica: perde il raggruppamento fra partite della stessa lega. Risposte vuote o mercati mancanti possono costare meno, ma non forniscono la copertura richiesta. Non si assume il costo pieno come consumo effettivo già misurato.', '',
  'Gli eventi sono raggruppati per lega e kickoff UTC, con target a T−15. La competenza mensile segue il timestamp della decisione: un kickoff nei primi 15 minuti UTC del mese può consumare il budget del mese precedente. Il fuso esatto del reset provider non è stato confermato: i mesi UTC sono una convenzione esplicita della simulazione.', '',
  'Budget nominale: 500; riserva ordinaria: 50; margine retry: una richiesta aggiuntiva per ceil(10% dei gruppi T−15), distribuita deterministicamente e riservata prima di ammettere quel gruppo. È un’ipotesi prudenziale di capacità, non una stima delle probabilità di errore. Il retry è ipotizzato nella finestra massima di 60 secondi.', '',
  'La cache principale viene considerata riutilizzabile per 30 secondi, separatamente per lega. Il prezzo è ipotizzato aggiornato all’acquisizione: non è una misura reale. La sensibilità con cache 300 secondi resta condizionata al timestamp originale del provider e al limite di cinque minuti; non rende fresca una quota vecchia.', '',
  '## Verifica della precedente stima 855', '',
  'La formula era: 135 gruppi × 3 crediti = 405, più 5 leghe × 3 mercati × 30 giorni = 450, totale **855 crediti**. È aritmeticamente corretta come esempio di 30 giorni; non era un conteggio di HTTP effettivi né includeva retry, UI, kickoff refresh o mercati evento aggiuntivi.', '',
  `Il mese ${args.month} ha ${a.days} giorni: la sola quota notturna counterfactual vale ${a.days * 5 * 3} crediti e ${a.days * 5} HTTP, assumendo tutti e tre i mercati restituiti.`, '',
  `## Mese ${args.month}`, '',
  `Calendario disponibile: **${a.calendar.eligibleFixtureCount} fixture**, **${a.groupCount} gruppi lega/kickoff**, ${a.calendar.completedFixtureCount} partite già concluse e ${a.calendar.futureUnverifiedFixtureCount} timestamp futuri non verificati. La completezza del calendario non è certificata.`, '',
  '| Scenario | Crediti richiesti, retry inclusi | HTTP richiesti | Crediti ammessi | Fixture coperte / disponibili | Copertura calendario |',
  '|---|---:|---:|---:|---:|---:|',
];
for (const [label, run] of rows) lines.push(`| ${label} | ${run.credits.requiredWithoutBudgetLimit} | ${run.httpRequests.requiredWithoutBudgetLimit} | ${run.credits.admitted} | ${run.coverage.coveredFixtures}/${run.coverage.eligibleFixtures} | ${percentage(run.coverage.fraction)} |`);
lines.push('', 'A e C condividono lo stesso recupero: non esiste un secondo addebito per modello. In B le letture informative devono essere cache-only e non possono generare richieste extra. Lo scenario A ricostruisce il vecchio flag notturno; non significa che il nuovo codice locale lo lasci attivo.', '',
  'Il percorso di sincronizzazione kickoff precedente può chiamare h2h (1 credito) e scores con `daysFrom` (2 crediti) per lega. La sua frequenza non è dimostrata come giornaliera: è esclusa dallo scenario base e mostrata separatamente come sensibilità. Non vanno sommati costi ipotetici come se fossero consumi osservati.', '',
  `Con richieste evento una per fixture, il solo T−15 richiederebbe ${b.eventSpecificAlternative.baseCredits} crediti base e ${b.eventSpecificAlternative.totalCreditsWithRetryAllowance} includendo il medesimo margine retry. Per il feed sport raggruppato B la richiesta stimata è ${b.credits.requiredWithoutBudgetLimit}.`, '',
  `Sensibilità favorevole di cache fino a cinque minuti: ${freshFiveMinuteCacheSensitivity.credits.requiredWithoutBudgetLimit} crediti, ${freshFiveMinuteCacheSensitivity.coverage.cacheHitGroups} gruppi serviti da cache. È un limite condizionato a prezzi ancora validi, non copertura garantita.`, '',
  '## Stress sui mesi storici disponibili', '',
  'La tabella usa tutti i mesi esportati anteriori al mese di acquisizione. “Passato” non prova da solo completezza o disponibilità delle quote: sono dati di calendario utilizzati per simulare domanda.', '',
  '| Mese UTC decisione | Fixture disponibili | Gruppi | B crediti richiesti | Fixture ammesse con riserva intatta | Fixture ammesse T−15 prioritario |',
  '|---|---:|---:|---:|---:|---:|');
for (const row of historical) lines.push(`| ${row.month} | ${row.conservative.eligibleFixtures} | ${row.conservative.groups} | ${row.conservative.requiredCredits} | ${row.conservative.coveredFixtures} | ${row.priority.coveredFixtures} |`);
if (worst) lines.push('', `Il mese storico più oneroso disponibile è **${worst.month}**: ${worst.conservative.eligibleFixtures} fixture / ${worst.conservative.groups} gruppi, domanda B ${worst.conservative.requiredCredits} crediti. Non è lecito promettere copertura mensile completa dei cinque campionati con 500 crediti se la domanda calcolata supera tale valore. Anche l’uso della riserva non crea nuovi crediti.`);
lines.push('', '## Calendario futuro e fallback', '',
  'I timestamp futuri non esplicitamente marcati come sconosciuti vengono inclusi soltanto come scenario condizionato. Le date marcate `kickoffKnown=false`, `kickoffPrecision=date/unknown`, senza fuso, annullate o rinviate vengono escluse. L’export attuale non contiene una conferma indipendente degli orari futuri.', '',
  'Nei mesi futuri molte fixture della stessa lega condividono l’orario predefinito: ciò può ridurre artificialmente il numero dei gruppi. Un futuro mese con pochi gruppi non dimostra bassi consumi reali dopo la definizione degli anticipi/posticipi. Il sistema operativo deve verificare gli eventi prima del target.', '',
  '**Scenario C: bloccato.** Nessun fallback distinto, gratuito, autorizzato e con copertura dimostrata dei tre mercati è configurato. La sua capacità aggiuntiva provata è zero; non viene inventata una seconda quota gratuita né attribuita ad altri operatori.', '',
  'I tre mercati richiesti non corrispondono a tutti i mercati teorici del modello. Quote DC/DNB, BTTS o totali squadra non vengono inventate dai prezzi 1X2. Un eventuale ampliamento del feed modifica il budget e richiede disponibilità reale.', '',
  '## Uso ripetibile e conclusione', '',
  '```powershell', 'cd backend', 'npm run build', `node scripts/simulate-odds-demand.js --input artifacts/research/matches.json --asof ${args.asof} --month ${args.month} --output-json ../docs/performance/odds-demand-2026-10-27.json --output-md ../docs/performance/odds-demand-2026-10-27.md`, '```', '',
  'La simulazione rende verificabile il risparmio da separazione della nightly, condivisione A/C e cache. Non certifica SLA, latenza, assenza di errori, quote disponibili o consumo effettivo. Se il budget reale misurato non basta, il comportamento corretto è saltare la decisione e conservarne il motivo. Cambiare la finestra T−15, la freschezza o introdurre costi richiede una decisione esplicita.', '',
  '[Dati della simulazione](odds-demand-2026-10-27.json)', '');
fs.writeFileSync(args['output-md'], `${lines.join('\n')}\n`);
console.log(JSON.stringify({ offlineOnly: true, month: args.month, scenarios: rows.map(([label, run]) => ({ label, ...concise(run) })), historicalWorstMonth: worst?.month }));
