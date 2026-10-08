import { resolve } from 'node:path';
import { assertValidDataset, readJson } from './lib/dataset.mjs';

const args = process.argv.slice(2);
if (args.length > 1) throw new Error('Usage: node scripts/validate-data.mjs [dataset.json]');
const path = resolve(args[0] || 'data/current-season.json');
const dataset = await readJson(path);
const report = assertValidDataset(dataset);
console.log('Valid dataset: ' + path);
console.log(JSON.stringify(report.coverage, null, 2));
for (const warning of report.warnings) console.warn('Warning: ' + warning);
