import { resolve } from 'node:path';
import { createCfbdClient, promptForApiKey } from './lib/cfbd.mjs';
import { resolveSeason } from './lib/season.mjs';

const args = process.argv.slice(2);
const options = { from: 2018, to: resolveSeason(), 'stats-from': 2022, out: '.cache/history' };
let force = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--force') { force = true; continue; }
  const name = argument.replace(/^--/, '');
  if (!argument.startsWith('--') || !(name in options) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: node scripts/sync-history.mjs --from 2018 --to 2026 --stats-from 2022 --out .cache/history [--force]');
  options[name] = args[++index];
}
const from = resolveSeason(options.from);
const to = resolveSeason(options.to);
const statsFrom = resolveSeason(options['stats-from']);
if (from > to) throw new Error('--from must not exceed --to.');
const apiKey = process.env.CFBD_API_KEY || await promptForApiKey();
const client = createCfbdClient({ apiKey, cacheDirectory: resolve(options.out), force });
const usage = await client.getUsage();
console.log('CFBD monthly calls remaining: ' + (usage.remainingCalls ?? 'unavailable') + ' of ' + (usage.monthlyLimit ?? 'unavailable') + '. Collection preserves a 50-call refresh reserve.');
for (let season = from; season <= to; season += 1) {
  const callsBefore = client.apiCalls;
  const dataset = await client.fetchSeasonDataset(season, { includeStats: season >= statsFrom });
  console.log(season + ': ' + dataset.games.length + ' scheduled games; ' + dataset.teamStats.length + ' box scores; ' + (client.apiCalls - callsBefore) + ' API calls.');
  const phases = Object.fromEntries([...new Set(dataset.games.map(game => game.seasonType))].sort().map(phase => [phase, dataset.games.filter(game => game.seasonType === phase).length]));
  console.log(season + ' season phases: ' + JSON.stringify(phases));
}
console.log('Raw historical archives saved to ' + resolve(options.out) + '. Total API calls: ' + client.apiCalls + '.');
