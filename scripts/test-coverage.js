import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = resolve('.');
const sourcePath = resolve('src/game.js');
const sourceUrl = pathToFileURL(sourcePath).href;
const sourceCode = await readFile(sourcePath, 'utf8');
const sourceLength = sourceCode.length;
const coverageDirectory = await mkdtemp(join(tmpdir(), 'js13k-coverage-'));
const tests = (await readdir(resolve('test')))
  // Source-mutant tests intentionally change byte offsets and would create
  // incompatible coverage records under the same canonical game URL.
  .filter(name => name.endsWith('.test.js') && name !== 'mutation.test.js')
  .sort()
  .map(name => resolve('test', name));

try {
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-isolation=none', ...tests], {
      cwd: root,
      env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => resolveExit(code ?? 1));
  });
  if (exitCode) process.exitCode = exitCode;
  if (exitCode) throw new Error(`Tests failed with exit code ${exitCode}`);

  const functions = new Map();
  for (const file of await readdir(coverageDirectory)) {
    const report = JSON.parse(await readFile(join(coverageDirectory, file), 'utf8'));
    for (const script of report.result || []) {
      if (script.url !== sourceUrl) continue;
      for (const entry of script.functions) {
        const primary = entry.ranges[0];
        // The VM adapter is appended immediately before the source IIFE closes.
        // Requiring the complete function to fit inside the original byte span
        // excludes adapter functions and the transformed outer wrapper.
        if (!primary || primary.endOffset > sourceLength) continue;
        const key = `${entry.functionName}:${primary.startOffset}:${primary.endOffset}`;
        const aggregate = functions.get(key) || {
          name: entry.functionName || '(anonymous)',
          start: primary.startOffset,
          end: primary.endOffset,
          count: 0,
          branches: new Map(),
        };
        aggregate.count = Math.max(aggregate.count, primary.count);
        for (const range of entry.ranges.slice(1)) {
          if (range.endOffset > sourceLength) continue;
          const rangeKey = `${range.startOffset}:${range.endOffset}`;
          aggregate.branches.set(rangeKey, Math.max(aggregate.branches.get(rangeKey) || 0, range.count));
        }
        functions.set(key, aggregate);
      }
    }
  }

  if (!functions.size) throw new Error(`No raw V8 coverage found for ${sourceUrl}; refusing to report an empty 100% result`);
  const functionValues = [...functions.values()];
  const coveredFunctions = functionValues.filter(entry => entry.count > 0).length;
  const branchRanges = functionValues.flatMap(entry => [...entry.branches.values()]);
  const coveredBranches = branchRanges.filter(count => count > 0).length;
  const ratio = (covered, total) => total ? covered / total * 100 : 100;
  const percent = (covered, total) => total ? `${ratio(covered, total).toFixed(1)}%` : 'n/a';

  console.log(`\nRaw V8 coverage for ${basename(sourcePath)} (VM source, adapter excluded)`);
  console.log(`Functions: ${coveredFunctions}/${functionValues.length} (${percent(coveredFunctions, functionValues.length)})`);
  console.log(`Branch ranges: ${coveredBranches}/${branchRanges.length} (${percent(coveredBranches, branchRanges.length)})`);

  const uncovered = functionValues.filter(entry => !entry.count).map(entry => entry.name);
  if (uncovered.length) console.log(`Uncovered functions: ${uncovered.join(', ')}`);
  const uncoveredLines = new Set();
  for (const entry of functionValues) {
    for (const [range, count] of entry.branches) {
      if (count) continue;
      const start = Number(range.split(':')[0]);
      uncoveredLines.add(sourceCode.slice(0, start).split('\n').length);
    }
  }
  if (uncoveredLines.size) console.log(`Uncovered branch-range starts: ${[...uncoveredLines].sort((a, b) => a - b).map(line => `L${line}`).join(', ')}`);
  if (ratio(coveredFunctions, functionValues.length) < 98) throw new Error('Function coverage fell below 98%');
  if (ratio(coveredBranches, branchRanges.length) < 90) throw new Error('Branch-range coverage fell below 90%');
} finally {
  await rm(coverageDirectory, { recursive: true, force: true });
}
