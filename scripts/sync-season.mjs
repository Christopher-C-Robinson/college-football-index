import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, '..');
const year = Number(process.argv[2] || new Date().getFullYear());

async function promptForApiKey() {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Set CFBD_API_KEY in your environment when running without an interactive terminal.');
  }
  output.write('CFBD API key (input hidden): ');
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();
  return new Promise(function (resolve, reject) {
    let secret = '';
    function finish(error) {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(secret.trim());
    }
    function onData(chunk) {
      for (const character of chunk.toString()) {
        if (character === '\u0003') return finish(new Error('Sync cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\u0008') secret = secret.slice(0, -1);
        else secret += character;
      }
    }
    input.on('data', onData);
  });
}

if (!Number.isInteger(year) || year < 2000 || year > 2100) {
  throw new Error('Pass a valid season year, for example: node scripts/sync-season.mjs 2026');
}
const apiKey = process.env.CFBD_API_KEY || await promptForApiKey();
if (!apiKey) throw new Error('An API key is required. The key is never read from or written to project files.');

const baseUrl = 'https://api.collegefootballdata.com';
let apiCalls = 0;

async function request(endpoint, params) {
  const url = new URL(baseUrl + endpoint);
  Object.entries(params).forEach(function (entry) { url.searchParams.set(entry[0], String(entry[1])); });
  apiCalls += 1;
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + apiKey } });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error('CFBD request failed (' + response.status + ') for ' + endpoint + ': ' + detail);
  }
  return response.json();
}

const schedules = [];
for (const classification of ['fbs', 'fcs']) {
  const result = await request('/games', { year: year, seasonType: 'regular', classification: classification });
  if (Array.isArray(result)) schedules.push(...result);
}
const teamMetadata = await request('/teams', { year: year });
const gamesById = new Map();
schedules.forEach(function (game) { gamesById.set(String(game.id), game); });
const games = Array.from(gamesById.values()).sort(function (a, b) {
  return String(a.startDate || '').localeCompare(String(b.startDate || ''));
});
const completedWeeks = Array.from(new Set(games.filter(function (game) {
  return game.completed && Number.isFinite(Number(game.week));
}).map(function (game) { return Number(game.week); }))).sort(function (a, b) { return a - b; });

const teamStats = [];
for (const week of completedWeeks) {
  const weekStats = [];
  for (const classification of ['fbs', 'fcs']) {
    const result = await request('/games/teams', {
      year: year,
      week: week,
      seasonType: 'regular',
      classification: classification
    });
    if (Array.isArray(result)) weekStats.push(...result);
  }
  const unique = new Map();
  weekStats.forEach(function (entry) { unique.set(String(entry.id || entry.gameId), entry); });
  teamStats.push(...unique.values());
}

const resultsThrough = games.filter(function (game) { return game.completed; })
  .map(function (game) { return String(game.startDate || '').slice(0, 10); })
  .filter(Boolean)
  .sort()
  .pop() || null;

const dataset = {
  meta: {
    season: year,
    asOf: new Date().toISOString().slice(0, 10),
    resultsThrough: resultsThrough,
    generatedAt: new Date().toISOString(),
    provider: 'CollegeFootballData.com API',
    scope: 'Regular-season FBS + FCS schedule/results and team box scores',
    starter: false,
    completeD1: true,
    apiCalls: apiCalls
  },
  games: games,
  teamMetadata: Array.isArray(teamMetadata) ? teamMetadata.filter(function (team) {
    return ['fbs', 'fcs'].includes(String(team.classification || '').toLowerCase());
  }) : [],
  teamStats: teamStats
};

const outputPath = resolve(projectDirectory, 'data', 'current-season.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
console.log('Saved ' + games.length + ' scheduled games and ' + teamStats.length + ' team box-score entries to data/current-season.json.');
console.log('CFBD API calls: ' + apiCalls + ' (two schedule requests, one team-metadata request, plus two per completed week).');
console.log('As of ' + dataset.meta.asOf + '. Keep the API key out of project files and source control.');
