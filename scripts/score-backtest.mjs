import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scoreReports } from './lib/scoring.mjs';

async function jsonPaths(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(entries.sort((left, right) => left.name.localeCompare(right.name)).map(entry => {
      const child = resolve(path, entry.name);
      return entry.isDirectory() ? jsonPaths(child) : extname(child).toLowerCase() === '.json' ? [child] : [];
    }));
    return nested.flat();
  } catch (error) {
    if (error.code !== 'ENOTDIR') throw error;
    return extname(path).toLowerCase() === '.json' ? [path] : [];
  }
}

export async function runScorer(args = process.argv.slice(2)) {
  const inputs = [];
  let outputPath = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--out') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--out needs a file path.');
      outputPath = resolve(args[index + 1]);
      index += 1;
    } else if (args[index].startsWith('--')) throw new Error(`Unknown option: ${args[index]}`);
    else inputs.push(resolve(args[index]));
  }
  if (!inputs.length) throw new Error('Usage: node scripts/score-backtest.mjs <directory-or-files...> [--out summary.json]');
  const paths = Array.from(new Set((await Promise.all(inputs.map(jsonPaths))).flat())).sort();
  const reports = [];
  const reportPaths = [];
  for (const path of paths) {
    if (path === outputPath) continue;
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (!data || !Array.isArray(data.predictions)) continue;
    reports.push(data);
    reportPaths.push(path);
  }
  const summary = { ...scoreReports(reports), files: reportPaths.map(path => relative(process.cwd(), path)) };
  const serialized = JSON.stringify(summary, null, 2) + '\n';
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
  } else process.stdout.write(serialized);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runScorer().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
