import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, cp, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { SaxesParser } from 'saxes';
import yazl from 'yazl';
import { convert, timestamp, workoutCollector, selectLatest, readExport } from '../src/export.mjs';
import { selectInput } from '../src/input.mjs';
import { duration } from '../src/report.mjs';

const cli = fileURLToPath(new URL('../appleHealthExportPdf.mjs', import.meta.url));
const workout = (attributes = '', body = '') => `<Workout workoutActivityType="HKWorkoutActivityTypeWalking" sourceName="Test Watch" startDate="2026-09-13 18:00:00 +0800" endDate="2026-09-13 19:00:00 +0800" ${attributes}>${body}</Workout>`;
const xml = content => `<?xml version="1.0" encoding="UTF-8"?><HealthData>${content}</HealthData>`;
function parse(content) { const p = new SaxesParser(); const result = workoutCollector(p); p.write(xml(content)).close(); return result; }
async function zipfile(dir, members) {
  const z = new yazl.ZipFile(), chunks = [];
  const done = new Promise((resolve, reject) => { z.outputStream.on('data', b => chunks.push(b)); z.outputStream.on('end', resolve); z.outputStream.on('error', reject); });
  for (const [name, value] of Object.entries(members)) z.addBuffer(Buffer.from(value), name);
  z.end(); await done;
  const file = path.join(dir, 'export.zip'); await writeFile(file, Buffer.concat(chunks)); return file;
}
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'apple-health-export-pdf-'));
  t.after(() => {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(dir));
    if (!relative.startsWith('apple-health-export-pdf-') || relative.includes(path.sep)) throw new Error('Unexpected temporary directory');
    return rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function stageCli(dir) {
  const repo = path.join(dir, 'repo');
  await mkdir(path.join(repo, 'import'), { recursive: true });
  for (const name of ['appleHealthExportPdf.mjs', 'src', 'package.json', 'manifest.json']) await cp(path.join(path.dirname(cli), name), path.join(repo, name), { recursive: true });
  await symlink(path.join(path.dirname(cli), 'node_modules'), path.join(repo, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { repo, stagedCli: path.join(repo, 'appleHealthExportPdf.mjs'), imports: path.join(repo, 'import') };
}

test('latest selection uses actual instants, not XML order, creation date or wall clock', () => {
  const a = workout().replaceAll('18:00:00 +0800', '12:00:00 +0000').replaceAll('19:00:00 +0800', '13:00:00 +0000');
  const b = workout('creationDate="2027-01-01 00:00:00 +0000"');
  const result = parse(a + b);
  assert.equal(selectLatest(result.workouts).startDate, '2026-09-13 12:00:00 +0000');
  assert.equal(timestamp('2026-09-13 18:00:00 +0800'), Date.parse('2026-09-13T10:00:00Z'));
  assert.ok(Number.isNaN(timestamp('2026-09-13 18:00:00')));
});

test('workout duration drives pace; elapsed time stays separate; statistics override legacy distance', () => {
  const result = parse(workout('duration="30" durationUnit="min" totalDistance="500" totalDistanceUnit="m"', '<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="5" unit="km"/>'));
  const w = result.workouts[0];
  assert.equal(w.elapsedMin, 60); assert.equal(w.durationMin, 30); assert.equal(w.nonActiveMin, 30);
  assert.equal(w.distanceKm, 5); assert.equal(w.paceMinKm, 6);
});

test('known units convert, unknown or absent values never become zero', () => {
  assert.equal(convert(1, 'mi', 'km'), 1.609344);
  assert.equal(convert(120, 's', 'minutes'), 2);
  assert.equal(convert(4184, 'J', 'kcal'), 1);
  assert.equal(convert('', 'km', 'km'), null);
  assert.equal(convert(-1, 'km', 'km'), null);
  assert.equal(convert(5, 'furlong', 'km'), null);
  assert.equal(convert(0, 'kcal', 'kcal'), 0);
});

test('missing metrics, legacy total energy, zero-distance indoor workouts and generic activity', () => {
  const w = parse(workout('duration="1800" durationUnit="s" totalDistance="0" totalDistanceUnit="km" totalEnergyBurned="100" totalEnergyBurnedUnit="kcal"').replace('HKWorkoutActivityTypeWalking', 'HKWorkoutActivityTypeYoga')).workouts[0];
  assert.equal(w.activity, 'Yoga'); assert.equal(w.hrAvg, null); assert.equal(w.activeKcal, null);
  assert.equal(w.totalKcal, 100); assert.equal(w.paceMinKm, null); assert.equal(w.durationMin, 30);
});

test('only parent workout statistics count, nested activities cannot double count totals', () => {
  const w = parse(workout('', '<WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="100" unit="kcal"/><WorkoutActivity><WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="500" unit="kcal"/></WorkoutActivity>')).workouts[0];
  assert.equal(w.activeKcal, 100);
});

test('cycling distance and normalized duplicates; invalid dates are counted', () => {
  const cycling = workout('duration="1" durationUnit="hr"', '<WorkoutStatistics type="HKQuantityTypeIdentifierDistanceCycling" sum="10" unit="mi"/>').replace('HKWorkoutActivityTypeWalking', 'HKWorkoutActivityTypeCycling');
  const r = parse(cycling + cycling + workout().replace('2026-09-13 18:00:00 +0800', 'invalid'));
  assert.equal(r.workouts.length, 1); assert.equal(r.duplicates, 1); assert.equal(r.skipped, 1);
  assert.ok(Math.abs(r.workouts[0].speedKmh - 16.09344) < 1e-8);
});

test('ZIP reads Apple DTD, Unicode and linked GPX segments without extracting other health files', async t => {
  const dir = await temporary(t);
  const document = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE HealthData [<!ELEMENT HealthData ANY>]>' + xml(workout('', '<WorkoutRoute><FileReference path="/workout-routes/test.gpx"/></WorkoutRoute>')).replace(/<\?xml[^>]+>/, '').replace('Test Watch', 'Synthetic José Watch');
  const input = await zipfile(dir, {
    'apple_health_export/export.xml': document,
    'apple_health_export/workout-routes/test.gpx': '<gpx><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1.1" lon="1.1"/></trkseg><trkseg><trkpt lat="2" lon="2"/><trkpt lat="2.1" lon="2.1"/></trkseg></trk></gpx>',
    'apple_health_export/electrocardiograms/ignored.csv': 'unrelated data',
  });
  const r = await readExport(input);
  assert.equal(r.latest.source, 'Synthetic José Watch'); assert.equal(r.routeSegments.length, 2);
  assert.deepEqual(await readdir(dir), ['export.zip']);
});

test('missing route reports a warning and preserves the latest workout', async t => {
  const dir = await temporary(t);
  const input = await zipfile(dir, { 'export.xml': xml(workout('', '<WorkoutRoute><FileReference path="/workout-routes/missing.gpx"/></WorkoutRoute>')) });
  const r = await readExport(input);
  assert.equal(r.latest.activity, 'Walking'); assert.equal(r.warnings.length, 1);
});

test('bad or empty exports fail with useful errors', async t => {
  const dir = await temporary(t);
  for (const [members, expected] of [
    [{ 'export_cda.xml': '<x/>' }, /Expected one export.xml/],
    [{ 'export.xml': xml('') }, /No valid workouts/],
    [{ 'export.xml': '<Other/>' }, /not an Apple HealthData/],
    [{ 'export.xml': '<HealthData><Workout>' }, /unclosed tag/],
  ]) { const input = await zipfile(dir, members); await assert.rejects(readExport(input), expected); }
  await writeFile(path.join(dir, 'export.zip'), 'not a zip');
  await assert.rejects(readExport(path.join(dir, 'export.zip')));
});

test('CLI always reads repo import and writes repo output when launched elsewhere', async t => {
  const dir = await temporary(t);
  const { repo, stagedCli, imports } = await stageCli(dir);
  await zipfile(imports, { 'apple_health_export/export.xml': xml(workout('duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"')) });
  execFileSync(process.execPath, [stagedCli], { cwd: dir });
  execFileSync(process.execPath, [stagedCli], { cwd: dir });
  assert.ok(!(await readdir(dir)).includes('output'));
  const outputs = await readdir(path.join(repo, 'output/pdf'));
  assert.equal(outputs.length, 2);
  for (const name of outputs) assert.equal((await readFile(path.join(repo, 'output/pdf', name))).subarray(0, 5).toString(), '%PDF-');
  const existing = path.join(repo, 'output/pdf', outputs[0]);
  const before = await readFile(existing);
  const result = spawnSync(process.execPath, [stagedCli, '--output', existing], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /already exists/);
  assert.deepEqual(await readFile(existing), before);
});

test('CLI handles empty import, removed input option, unknown flags and help', async t => {
  const dir = await temporary(t);
  const { stagedCli } = await stageCli(dir);
  const missing = spawnSync(process.execPath, [stagedCli], { cwd: dir, encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /No .zip files found/);
  assert.equal(spawnSync(process.execPath, [stagedCli, '--unknown'], { cwd: dir }).status, 1);
  assert.equal(spawnSync(process.execPath, [stagedCli, '--input', 'elsewhere.zip'], { cwd: dir }).status, 1);
  assert.equal(spawnSync(process.execPath, [stagedCli, '--help'], { cwd: dir }).status, 0);
  assert.equal(duration(59.999), '1h 0m 00s');
});

test('ZIP selection uses newest mtime, accepts uppercase and ignores other files and directories', async t => {
  const dir = await temporary(t);
  await writeFile(path.join(dir, 'export-2099.zip'), 'older');
  await writeFile(path.join(dir, 'latest.ZIP'), 'newer');
  await writeFile(path.join(dir, 'notes.xml'), 'ignore');
  await mkdir(path.join(dir, 'folder.zip'));
  await utimes(path.join(dir, 'export-2099.zip'), 100, 100);
  await utimes(path.join(dir, 'latest.ZIP'), 200, 200);
  const selected = await selectInput(dir);
  assert.equal(selected.name, 'latest.ZIP'); assert.equal(selected.count, 2);
});

test('equal timestamps use ascending filenames, independent of directory enumeration', async t => {
  const dir = await temporary(t);
  for (const name of ['z.zip', 'a.zip']) { await writeFile(path.join(dir, name), 'zip'); await utimes(path.join(dir, name), 100, 100); }
  assert.equal((await selectInput(dir)).name, 'a.zip');
});

test('missing and ZIP-free import folders give actionable errors', async t => {
  const dir = await temporary(t);
  await assert.rejects(selectInput(path.join(dir, 'missing')), /Import folder not found/);
  await writeFile(path.join(dir, 'export.zip.tmp'), 'incomplete');
  await assert.rejects(selectInput(dir), /No .zip files found/);
});

test('an invalid newest ZIP fails rather than falling back to an older valid export', async t => {
  const dir = await temporary(t);
  const { stagedCli, imports, repo } = await stageCli(dir);
  const old = await zipfile(imports, { 'export.xml': xml(workout()) });
  await utimes(old, 100, 100);
  const newest = path.join(imports, 'new.zip');
  await writeFile(newest, 'not a ZIP'); await utimes(newest, 200, 200);
  const result = spawnSync(process.execPath, [stagedCli], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stdout, /Selected new.zip/);
  assert.ok(!(await readdir(repo)).includes('output'));
});
