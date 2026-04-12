const test = require('node:test');
const assert = require('node:assert/strict');
const { EurobetOddsService } = require('../dist/services/EurobetOddsService.js');

function createBaseBetGroup() {
  return [
    {
      oddGroupList: [
        {
          oddGroupDescription: '1X2',
          oddList: [
            { boxTitle: '1', oddValue: 195 },
            { boxTitle: 'X', oddValue: 340 },
            { boxTitle: '2', oddValue: 410 },
          ],
        },
      ],
    },
  ];
}

function createMeetingItem({ eventAlias, homeTeam, awayTeam, commenceTime }) {
  return {
    eventInfo: {
      aliasUrl: eventAlias,
      eventData: new Date(commenceTime).getTime(),
      teamHome: { description: homeTeam },
      teamAway: { description: awayTeam },
    },
    betGroupList: createBaseBetGroup(),
  };
}

function createMeetingResponse(items, groupAliases = ['statistiche-partita']) {
  return {
    result: {
      groupData: {
        groupList: groupAliases.map((aliasUrl) => ({ aliasUrl })),
      },
      dataGroupList: [
        {
          itemList: items,
        },
      ],
    },
  };
}

function createEventResponse(item, groupAliases = ['statistiche-partita']) {
  return {
    result: {
      eventInfo: item.eventInfo,
      betGroupList: item.betGroupList,
      groupData: {
        groupList: groupAliases.map((aliasUrl) => ({ aliasUrl })),
      },
    },
  };
}

function createOddsMatch(markets, overrides = {}) {
  return {
    matchId: 'eurobet_test_match',
    meetingAlias: 'it-serie-a',
    eventAlias: 'inter-milan-202604121845',
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-04-12T18:45:00.000Z',
    bookmakers: [
      {
        bookmakerKey: 'eurobet',
        bookmakerName: 'Eurobet',
        markets,
      },
    ],
    availableGroupAliases: [],
    loadedGroupAliases: ['base'],
    unavailableGroupAliases: [],
    ...overrides,
  };
}

test('Eurobet getOdds usa il meeting JSON come percorso primario senza dipendere dal DOM', async () => {
  const service = new EurobetOddsService();
  const item = createMeetingItem({
    eventAlias: 'inter-milan-202604121845',
    homeTeam: 'Inter',
    awayTeam: 'AC Milan',
    commenceTime: '2026-04-12T18:45:00.000Z',
  });

  service.resolveMeetingAlias = async () => 'it-serie-a';
  service.fetchMeetingDetail = async () => createMeetingResponse([item]);
  service.collectMeetingPageMetadata = async () => {
    throw new Error('Il DOM fallback non dovrebbe essere usato quando il meeting JSON è valido');
  };

  const matches = await service.getOdds('Serie A');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].eventAlias, 'inter-milan-202604121845');
  assert.equal(matches[0].meetingAlias, 'it-serie-a');

  const odds = service.extractBestOdds(matches[0]);
  assert.equal(odds.homeWin, 1.95);
  assert.equal(odds.draw, 3.4);
  assert.equal(odds.awayWin, 4.1);
});

test('Eurobet getOddsForFixtures matcha le fixture dal meeting JSON prima del fallback per alias', async () => {
  const service = new EurobetOddsService();
  const item = createMeetingItem({
    eventAlias: 'inter-milan-202604121845',
    homeTeam: 'Inter',
    awayTeam: 'AC Milan',
    commenceTime: '2026-04-12T18:45:00.000Z',
  });

  let eventFallbackCalls = 0;

  service.resolveMeetingAlias = async () => 'it-serie-a';
  service.fetchMeetingDetail = async () => createMeetingResponse([item]);
  service.fetchEventDetail = async () => {
    eventFallbackCalls += 1;
    throw new Error('Il fallback su event detail non dovrebbe essere usato');
  };

  const matches = await service.getOddsForFixtures('Serie A', [
    {
      homeTeam: 'Internazionale',
      awayTeam: 'Milan',
      commenceTime: '2026-04-12T18:45:00.000Z',
    },
  ]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].homeTeam, 'Inter');
  assert.equal(matches[0].awayTeam, 'AC Milan');
  assert.equal(eventFallbackCalls, 0);
});

test('Eurobet fixtureMatches accetta alias squadra e tolleranza oraria realistica', () => {
  const service = new EurobetOddsService();
  const fixture = {
    homeTeam: 'PSG',
    awayTeam: 'Man City',
    commenceTime: '2026-04-12T18:45:00.000Z',
  };
  const match = {
    matchId: 'eurobet_psg_city',
    meetingAlias: 'eu-champions-league',
    eventAlias: 'paris-saint-germain-manchester-city-202604122015',
    homeTeam: 'Paris Saint-Germain',
    awayTeam: 'Manchester City',
    commenceTime: '2026-04-12T20:15:00.000Z',
    bookmakers: [],
    availableGroupAliases: [],
    loadedGroupAliases: ['base'],
    unavailableGroupAliases: [],
  };

  assert.equal(service.fixtureMatches(fixture, match), true);
  assert.ok(service.scoreFixtureMatch(fixture, match) >= 700);
});

test('Eurobet buildTimeCandidates genera varianti coerenti per UTC e Europe/Rome con delta fino a 120 minuti', () => {
  const service = new EurobetOddsService();
  const candidates = service.buildTimeCandidates('2026-04-12T18:45:00.000Z');

  assert.ok(candidates.includes('202604121645'));
  assert.ok(candidates.includes('202604121845'));
  assert.ok(candidates.includes('202604122045'));
  assert.ok(candidates.includes('202604122245'));
});

test('Eurobet buildEventAliasCandidates combina alias squadra e timestamp candidati', () => {
  const service = new EurobetOddsService();
  const aliases = service.buildEventAliasCandidates({
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-04-12T18:45:00.000Z',
  });

  assert.ok(aliases.includes('inter-milan-202604121845'));
  assert.ok(aliases.includes('internazionale-ac-milan-202604121845'));
  assert.ok(aliases.includes('inter-milan-202604122045'));
});

test('Eurobet getOdds usa il fallback DOM/event quando il meeting JSON è vuoto', async () => {
  const service = new EurobetOddsService();
  const item = createMeetingItem({
    eventAlias: 'juventus-roma-202604122045',
    homeTeam: 'Juventus',
    awayTeam: 'Roma',
    commenceTime: '2026-04-12T20:45:00.000Z',
  });

  service.resolveMeetingAlias = async () => 'it-serie-a';
  service.fetchMeetingDetail = async () => createMeetingResponse([]);
  service.withPage = async (task) => task({});
  service.collectMeetingPageMetadata = async () => ({
    eventAliases: ['juventus-roma-202604122045'],
    groupAliases: ['statistiche-partita'],
  });
  service.fetchEventDetail = async () => createEventResponse(item);

  const originalWarn = console.warn;
  console.warn = () => undefined;
  let matches;
  try {
    matches = await service.getOdds('Serie A');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(matches.length, 1);
  assert.equal(matches[0].eventAlias, 'juventus-roma-202604122045');
  assert.equal(service.extractBestOdds(matches[0]).homeWin, 1.95);
});

test('Eurobet logga diagnostica chiara quando meeting JSON e fallback DOM sono entrambi vuoti', async () => {
  const service = new EurobetOddsService();
  const warnings = [];
  const originalWarn = console.warn;

  service.resolveMeetingAlias = async () => 'it-serie-a';
  service.fetchMeetingDetail = async () => createMeetingResponse([]);
  service.withPage = async (task) => task({});
  service.collectMeetingPageMetadata = async () => ({
    eventAliases: [],
    groupAliases: [],
  });

  console.warn = (message) => warnings.push(String(message));
  try {
    await assert.rejects(
      service.getOdds('Serie A'),
      /Eurobet non ha restituito quote valide per Serie A/
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(
    warnings.some((line) =>
      line.includes('Meeting JSON vuoto o senza eventi')
      && line.includes('"competition":"Serie A"')
      && line.includes('"meetingAlias":"it-serie-a"'))
  );
  assert.ok(
    warnings.some((line) =>
      line.includes('Fallback DOM senza anchor evento')
      && line.includes('"competition":"Serie A"')
      && line.includes('"meetingAlias":"it-serie-a"'))
  );
});

test('Eurobet parsePrice supporta centesimi, decimali numerici e stringhe formattate', () => {
  const service = new EurobetOddsService();

  assert.equal(service.parsePrice(183), 1.83);
  assert.equal(service.parsePrice(1.83), 1.83);
  assert.equal(service.parsePrice('1.83'), 1.83);
  assert.equal(service.parsePrice('1,83'), 1.83);
});

test('Eurobet extractLineFromAdditionalInfo preserva quarter line e due decimali utili', () => {
  const service = new EurobetOddsService();

  assert.equal(service.extractLineFromAdditionalInfo([250]), 2.5);
  assert.equal(service.extractLineFromAdditionalInfo([225]), 2.25);
  assert.equal(service.extractLineFromAdditionalInfo([175]), 1.75);
  assert.equal(service.extractLineFromAdditionalInfo([95]), 0.95);
});

test('Eurobet parseJsonPayload logga snippet quando riceve HTML/captcha invece di JSON', () => {
  const service = new EurobetOddsService();
  const warnings = [];
  const originalWarn = console.warn;

  console.warn = (message) => warnings.push(String(message));
  try {
    assert.throws(
      () => service.parseJsonPayload('<html><title>Just a moment</title><body>captcha challenge</body></html>', 'Risposta network test', {
        expectedResponseUrl: 'https://example.test/api',
      }),
      /HTML\/captcha invece di JSON/
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(warnings.some((line) => line.includes('expectedResponseUrl')));
  assert.ok(warnings.some((line) => line.includes('snippet')));
  assert.ok(warnings.some((line) => line.includes('captcha challenge')));
});

test('Eurobet mappa le selection key principali dai mercati bookmaker', () => {
  const service = new EurobetOddsService();
  const match = createOddsMatch([
    {
      marketKey: 'h2h',
      outcomes: [
        { name: 'Inter', price: 1.95 },
        { name: 'Draw', price: 3.4 },
        { name: 'Milan', price: 4.1 },
      ],
    },
    {
      marketKey: 'double_chance',
      outcomes: [
        { name: '1X', price: 1.22 },
        { name: 'X2', price: 1.95 },
        { name: '12', price: 1.31 },
      ],
    },
    {
      marketKey: 'draw_no_bet',
      outcomes: [
        { name: 'Inter', price: 1.42 },
        { name: 'Milan', price: 2.75 },
      ],
    },
    {
      marketKey: 'totals',
      outcomes: [
        { name: 'Over', price: 1.88, point: 2.5, description: 'Goals' },
        { name: 'Under', price: 1.92, point: 2.5, description: 'Goals' },
      ],
    },
    {
      marketKey: 'shots',
      outcomes: [
        { name: 'Over', price: 1.8, point: 25.5, description: 'Shots' },
      ],
    },
    {
      marketKey: 'cards',
      outcomes: [
        { name: 'Over', price: 1.9, point: 4.5, description: 'Cards' },
      ],
    },
    {
      marketKey: 'fouls',
      outcomes: [
        { name: 'Over', price: 1.85, point: 22.5, description: 'Fouls' },
      ],
    },
  ]);

  const odds = service.extractBestOdds(match);

  assert.equal(odds.homeWin, 1.95);
  assert.equal(odds.draw, 3.4);
  assert.equal(odds.awayWin, 4.1);
  assert.equal(odds.over25, 1.88);
  assert.equal(odds.under25, 1.92);
  assert.equal(odds.double_chance_1x, 1.22);
  assert.equal(odds.double_chance_x2, 1.95);
  assert.equal(odds.double_chance_12, 1.31);
  assert.equal(odds.dnb_home, 1.42);
  assert.equal(odds.dnb_away, 2.75);
  assert.equal(odds['shots_total_over_25.5'], 1.8);
  assert.equal(odds['yellow_over_4.5'], 1.9);
  assert.equal(odds['fouls_over_22.5'], 1.85);
});

test('Eurobet parseBetGroupMarkets costruisce mercati coerenti da JSON mockato', () => {
  const service = new EurobetOddsService();
  const markets = service.parseBetGroupMarkets('Inter', 'Milan', [
    {
      betDescription: '',
      oddGroupList: [
        {
          oddGroupDescription: '1X2',
          oddList: [
            { boxTitle: '1', oddValue: 195 },
            { boxTitle: 'X', oddValue: 340 },
            { boxTitle: '2', oddValue: 410 },
          ],
        },
      ],
    },
    {
      betDescription: 'Doppia Chance',
      oddGroupList: [
        {
          oddGroupDescription: 'DC',
          oddList: [
            { boxTitle: '1X', oddValue: 122 },
            { boxTitle: 'X2', oddValue: 195 },
            { boxTitle: '12', oddValue: 131 },
          ],
        },
      ],
    },
    {
      betDescription: 'Draw No Bet',
      oddGroupList: [
        {
          oddGroupDescription: 'Rimborso in caso di pareggio',
          oddList: [
            { boxTitle: '1', oddValue: 142 },
            { boxTitle: '2', oddValue: 275 },
          ],
        },
      ],
    },
    {
      betDescription: 'Under Over Goal',
      oddGroupList: [
        {
          oddGroupDescription: 'U/O Goal',
          oddList: [
            { boxTitle: 'Over', oddValue: 188, additionalInfo: [250] },
            { boxTitle: 'Under', oddValue: 192, additionalInfo: [250] },
          ],
        },
      ],
    },
    {
      betDescription: 'Tiri Totali',
      oddGroupList: [
        {
          oddGroupDescription: 'Over Under Tiri',
          oddList: [
            { boxTitle: 'Over', oddValue: 180, additionalInfo: [2550] },
          ],
        },
      ],
    },
    {
      betDescription: 'Cartellini Totali',
      oddGroupList: [
        {
          oddGroupDescription: 'Over Under Cartellini',
          oddList: [
            { boxTitle: 'Over', oddValue: 190, additionalInfo: [450] },
          ],
        },
      ],
    },
    {
      betDescription: 'Falli Totali',
      oddGroupList: [
        {
          oddGroupDescription: 'Over Under Falli',
          oddList: [
            { boxTitle: 'Over', oddValue: 185, additionalInfo: [2250] },
          ],
        },
      ],
    },
  ]);

  const match = createOddsMatch(markets);
  const odds = service.extractBestOdds(match);

  assert.equal(markets.some((market) => market.marketKey === 'h2h'), true);
  assert.equal(markets.some((market) => market.marketKey === 'double_chance'), true);
  assert.equal(markets.some((market) => market.marketKey === 'draw_no_bet'), true);
  assert.equal(markets.some((market) => market.marketKey === 'totals'), true);
  assert.equal(markets.some((market) => market.marketKey === 'shots'), true);
  assert.equal(markets.some((market) => market.marketKey === 'cards'), true);
  assert.equal(markets.some((market) => market.marketKey === 'fouls'), true);
  assert.equal(odds['shots_total_over_25.5'], 1.8);
  assert.equal(odds['yellow_over_4.5'], 1.9);
  assert.equal(odds['fouls_over_22.5'], 1.85);
});

test('Eurobet mergeMarkets non duplica outcome già presenti e aggiunge solo quelli nuovi', () => {
  const service = new EurobetOddsService();
  const bookmakers = [
    {
      bookmakerKey: 'eurobet',
      bookmakerName: 'Eurobet',
      markets: [
        {
          marketKey: 'cards',
          outcomes: [
            { name: 'Over', price: 1.9, point: 4.5, description: 'Cards' },
          ],
        },
      ],
    },
  ];

  const merged = service.mergeMarkets(bookmakers, [
    {
      marketKey: 'cards',
      outcomes: [
        { name: 'Over', price: 1.9, point: 4.5, description: 'Cards' },
        { name: 'Under', price: 1.87, point: 4.5, description: 'Cards' },
      ],
    },
    {
      marketKey: 'fouls',
      outcomes: [
        { name: 'Over', price: 1.85, point: 22.5, description: 'Fouls' },
      ],
    },
  ]);

  const signatures = merged[0].markets.flatMap((market) =>
    market.outcomes.map((outcome) =>
      `${market.marketKey}|${outcome.name}|${String(outcome.point ?? '')}|${String(outcome.description ?? '')}`)
  );

  assert.equal(signatures.filter((entry) => entry === 'cards|Over|4.5|Cards').length, 1);
  assert.ok(signatures.includes('cards|Under|4.5|Cards'));
  assert.ok(signatures.includes('fouls|Over|22.5|Fouls'));
});
