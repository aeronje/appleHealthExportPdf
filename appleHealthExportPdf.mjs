#!/usr/bin/env node
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json' with { type: 'json' };
import { selectInput } from './src/input.mjs';
import { readExport } from './src/export.mjs';
import { renderReport, duration } from './src/report.mjs';

async function main() {
  const repoDirectory = path.dirname(fileURLToPath(import.meta.url));
  const { values } = parseArgs({ options: { output: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log(`appleHealthExportPdf v${manifest.version}\n\nUsage: node /path/to/appleHealthExportPdf.mjs [--output report.pdf]\n\nInput: newest .zip by modification time in the repository's import/ folder.\nEqual timestamps: filename ascending. Non-ZIP files and subfolders are ignored.\nDefault output: repository's output/pdf/ folder.\nSelects the latest workout inside the chosen ZIP by workout start time.\nExisting PDFs are never overwritten. All processing is local.`);
    return;
  }
  const selected = await selectInput(path.join(repoDirectory, 'import'));
  const input = selected.file;
  if (values.output && path.extname(values.output).toLowerCase() !== '.pdf') throw new Error('--output must end in .pdf.');
  if (values.output) {
    try { await access(path.resolve(values.output)); throw new Error(`Output already exists: ${path.resolve(values.output)}. Choose another filename.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  console.log(`appleHealthExportPdf v${manifest.version}`);
  console.log(`Selected ${selected.name} from ${selected.count} ZIP file(s); modified ${new Date(selected.modifiedMs).toISOString()}.`);
  const data = await readExport(input, console.log);
  const w = data.latest;
  console.log(`Found ${data.workouts.length} unique workouts. Latest: ${w.activity}, ${w.startDate}.`);
  console.log(`Workout duration: ${duration(w.durationMin)}. Distance: ${w.distanceKm === null ? 'not recorded' : `${w.distanceKm.toFixed(2)} km`}.`);
  for (const warning of data.warnings) console.warn(`Warning: ${warning}`);
  const pdf = await renderReport(data, path.basename(input));
  const stamp = w.startDate.slice(0, 19).replace(/[^0-9]/g, '');
  const name = `workout-${stamp}-${w.activity.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  const defaultDir = path.join(repoDirectory, 'output/pdf');
  let output = values.output ? path.resolve(values.output) : path.join(defaultDir, `${name}.pdf`);
  await mkdir(path.dirname(output), { recursive: true });
  for (let suffix = 2; ; suffix++) {
    try { await writeFile(output, pdf, { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || values.output) throw error;
      output = path.join(defaultDir, `${name}-${suffix}.pdf`);
    }
  }
  console.log(`PDF created: ${output}`);
}

main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
