import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { posix } from 'node:path';

const Q = 'HKQuantityTypeIdentifier';
const factors = {
  minutes: { min: 1, s: 1 / 60, sec: 1 / 60, hr: 60, h: 60 },
  km: { km: 1, m: 0.001, mi: 1.609344, yd: 0.0009144, ft: 0.0003048 },
  kcal: { kcal: 1, kJ: 1 / 4.184, J: 1 / 4184, cal: 0.001 },
  bpm: { 'count/min': 1, bpm: 1 },
};
export function convert(value, unit, target) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value), factor = factors[target]?.[unit];
  return Number.isFinite(n) && n >= 0 && factor !== undefined ? n * factor : null;
}

export function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const iso = value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/, '$1T$2$3:$4');
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? Date.parse(iso) : NaN;
}

function normalize(raw) {
  const a = raw.attributes;
  const startMs = timestamp(a.startDate), endMs = timestamp(a.endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || !a.workoutActivityType) return null;
  const stat = (type, field, target) => {
    const s = raw.statistics.find(s => s.type === Q + type);
    return s ? convert(s[field], s.unit, target) : null;
  };
  const activity = a.workoutActivityType.replace(/^HKWorkoutActivityType/, '');
  const distanceType = { Cycling: 'DistanceCycling', Swimming: 'DistanceSwimming', WheelchairWalkPace: 'DistanceWheelchair', WheelchairRunPace: 'DistanceWheelchair', CrossCountrySkiing: 'DistanceCrossCountrySkiing', Rowing: 'DistanceRowing', Paddling: 'DistancePaddleSports', SkatingSports: 'DistanceSkatingSports' }[activity] ?? 'DistanceWalkingRunning';
  const distanceKm = stat(distanceType, 'sum', 'km') ?? convert(a.totalDistance, a.totalDistanceUnit, 'km');
  const durationMin = convert(a.duration, a.durationUnit, 'minutes');
  const elapsedMin = (endMs - startMs) / 60000;
  const activeKcal = stat('ActiveEnergyBurned', 'sum', 'kcal');
  const basalKcal = stat('BasalEnergyBurned', 'sum', 'kcal');
  const hrAvg = stat('HeartRate', 'average', 'bpm');
  const hrMin = stat('HeartRate', 'minimum', 'bpm');
  const hrMax = stat('HeartRate', 'maximum', 'bpm');
  // Keep legacy total energy separate: it must not be relabeled as active energy.
  const totalKcal = activeKcal !== null && basalKcal !== null ? activeKcal + basalKcal : convert(a.totalEnergyBurned, a.totalEnergyBurnedUnit, 'kcal');
  return {
    activity, startMs, endMs, startDate: a.startDate, endDate: a.endDate,
    source: a.sourceName || 'Not recorded', timezone: raw.metadata.HKTimeZone ?? null,
    environment: raw.metadata.HKIndoorWorkout === '0' ? 'Outdoor' : raw.metadata.HKIndoorWorkout === '1' ? 'Indoor' : null,
    durationMin, elapsedMin, distanceKm, activeKcal, basalKcal, totalKcal, hrAvg, hrMin, hrMax,
    paceMinKm: durationMin > 0 && distanceKm > 0 ? durationMin / distanceKm : null,
    speedKmh: durationMin > 0 && distanceKm !== null ? distanceKm / (durationMin / 60) : null,
    nonActiveMin: durationMin !== null && durationMin <= elapsedMin ? elapsedMin - durationMin : null,
    routes: raw.routes,
  };
}

async function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => err ? reject(err) : resolve(zip)));
}
async function entries(zip) {
  return new Promise((resolve, reject) => {
    const result = [];
    const fail = err => { cleanup(); reject(err); };
    const entry = value => { result.push(value); zip.readEntry(); };
    const end = () => { cleanup(); resolve(result); };
    const cleanup = () => { zip.off('error', fail); zip.off('entry', entry); zip.off('end', end); };
    zip.on('error', fail); zip.on('entry', entry); zip.on('end', end); zip.readEntry();
  });
}
async function parseEntry(zip, entry, configure) {
  const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => err ? reject(err) : resolve(s)));
  // Saxes does not fetch DTDs or expand external entities. Apple includes a DTD.
  const parser = new SaxesParser();
  configure(parser);
  stream.setEncoding('utf8');
  try { for await (const chunk of stream) parser.write(chunk); parser.close(); }
  finally { stream.destroy(); }
}

export function workoutCollector(parser) {
  const result = { workouts: [], skipped: 0, duplicates: 0, exportDate: null };
  const stack = [], seen = new Set();
  let raw = null, root = false;
  parser.on('opentag', node => {
    const parent = stack.at(-1); stack.push(node.name);
    if (stack.length === 1) { root = node.name === 'HealthData'; if (!root) throw new Error('export.xml is not an Apple HealthData document.'); }
    if (node.name === 'ExportDate') result.exportDate = node.attributes.value;
    if (node.name === 'Workout' && parent === 'HealthData') raw = { attributes: node.attributes, statistics: [], metadata: {}, routes: [] };
    else if (raw && parent === 'Workout' && node.name === 'WorkoutStatistics') raw.statistics.push(node.attributes);
    else if (raw && parent === 'Workout' && node.name === 'MetadataEntry') raw.metadata[node.attributes.key] = node.attributes.value;
    else if (raw && node.name === 'FileReference' && parent === 'WorkoutRoute') raw.routes.push(node.attributes.path);
  });
  parser.on('closetag', node => {
    if (node.name === 'Workout' && raw) {
      const w = normalize(raw);
      if (!w) result.skipped++;
      else {
        const key = JSON.stringify(w);
        if (seen.has(key)) result.duplicates++;
        else { seen.add(key); result.workouts.push(w); }
      }
      raw = null;
    }
    stack.pop();
  });
  return result;
}

export function selectLatest(workouts) {
  return [...workouts].sort((a, b) => b.startMs - a.startMs || b.endMs - a.endMs)[0] ?? null;
}

async function routePoints(zip, entry) {
  const segments = []; let current = null;
  await parseEntry(zip, entry, parser => {
    parser.on('opentag', node => {
      const name = node.name.split(':').at(-1);
      if (name === 'trkseg') { current = []; segments.push(current); }
      if (name === 'trkpt' && current) {
        const { lat, lon } = node.attributes;
        const latitude = Number(lat), longitude = Number(lon);
        if (lat !== undefined && lon !== undefined && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) current.push([longitude, latitude]);
      }
    });
    parser.on('closetag', node => { if (node.name.split(':').at(-1) === 'trkseg') current = null; });
  });
  return segments.filter(s => s.length > 1).map(points => {
    const step = Math.max(1, Math.ceil(points.length / 4000));
    return points.filter((_, i) => i % step === 0 || i === points.length - 1);
  });
}

export async function readExport(file, progress = () => {}) {
  const zip = await openZip(file);
  // Forward asynchronous archive errors to streams through normal yauzl handling;
  // retain an error listener while between individual stream operations.
  let archiveError; const onError = err => { archiveError = err; }; zip.on('error', onError);
  try {
    const files = await entries(zip);
    const xmlFiles = files.filter(e => /(^|\/)export\.xml$/.test(e.fileName) && !e.fileName.startsWith('__MACOSX/'));
    if (xmlFiles.length !== 1) throw new Error(`Expected one export.xml inside the ZIP; found ${xmlFiles.length}.`);
    const xml = xmlFiles[0];
    progress(`Reading ${(xml.uncompressedSize / 1e6).toFixed(0)} MB of XML; keeping workout summaries only...`);
    let result;
    await parseEntry(zip, xml, parser => { result = workoutCollector(parser); });
    if (archiveError) throw archiveError;
    const latest = selectLatest(result.workouts);
    if (!latest) throw new Error(`No valid workouts found in this export.${result.skipped ? ` ${result.skipped} had invalid dates or types.` : ''}`);
    result.latest = latest; result.routeSegments = []; result.warnings = [];
    const base = posix.dirname(xml.fileName);
    for (const reference of new Set(latest.routes)) {
      const relative = String(reference).replace(/^\/+/, '');
      // Only resolve an archive member. No extraction and no filesystem writes.
      if (relative.split('/').includes('..') || relative.includes('\\')) { result.warnings.push('Unsafe route reference skipped.'); continue; }
      const entry = files.find(e => e.fileName === posix.join(base, relative) || e.fileName === relative);
      if (!entry) { result.warnings.push('A referenced GPS route was missing.'); continue; }
      try { result.routeSegments.push(...await routePoints(zip, entry)); }
      catch { result.warnings.push('A GPS route could not be read; workout statistics are still available.'); }
    }
    if (result.skipped) result.warnings.push(`${result.skipped} workout(s) with invalid dates or types were skipped.`);
    return result;
  } finally { zip.close(); zip.off('error', onError); }
}
