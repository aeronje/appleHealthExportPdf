import PDFDocument from 'pdfkit';
import manifest from '../manifest.json' with { type: 'json' };

const C = { ink: '#122C35', muted: '#5E737B', paper: '#F3F6F5', white: '#FFFFFF', teal: '#087F8C', coral: '#E8795C', line: '#DBE5E5', light: '#BCD1D2' };
const number = (n, digits = 0) => n === null || !Number.isFinite(n) ? 'Not recorded' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const duration = n => {
  if (n === null || !Number.isFinite(n)) return 'Not recorded';
  const seconds = Math.round(n * 60), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}h ` : ''}${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
};
const pace = n => n === null ? 'Not recorded' : `${Math.floor(Math.round(n * 60) / 60)}:${String(Math.round(n * 60) % 60).padStart(2, '0')}`;
const clean = s => String(s).replace(/[\u2010-\u2015]/g, '-').replace(/\u00a0/g, ' ');
const activityName = w => w.activity.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function dateLabel(raw) {
  // Display the export's own local wall time, regardless of this machine's zone.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw);
  if (!m) return raw;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hour = Number(m[4]);
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}  |  ${hour % 12 || 12}:${m[5]} ${hour >= 12 ? 'PM' : 'AM'}`;
}

export async function renderReport(data, inputName) {
  const w = data.latest;
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Latest workout', Author: 'appleHealthExportPdf', Subject: 'Local Apple Health workout summary' } });
  const chunks = [];
  const completed = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const text = (value, x, y, size = 10, color = C.ink, width = 520, bold = false, align = 'left') => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(clean(value), x, y, { width, height: size * 2.6, ellipsis: true, lineBreak: false, align });
  };
  const rect = (x, y, width, height, color, radius = 10) => doc.roundedRect(x, y, width, height, radius).fill(color);
  const line = (x, y, x2, y2, color = C.line, width = 0.6) => doc.moveTo(x, y).lineTo(x2, y2).lineWidth(width).strokeColor(color).stroke();
  const card = (x, y, label, value, detail, color = C.ink) => {
    rect(x, y, 169, 80, C.white);
    text(label, x + 13, y + 12, 9, C.muted, 143);
    text(value, x + 13, y + 29, value.length > 15 ? 17 : 24, color, 145, true);
    text(detail, x + 13, y + 62, 8, C.muted, 145);
  };

  doc.rect(0, 0, 596, 842).fill(C.paper);
  doc.rect(0, 0, 596, 150).fill(C.ink);
  doc.rect(32, 31, 28, 4).fill(C.coral);
  text('Your latest workout', 70, 26, 11, C.light, 460);
  const title = `${w.environment ? `${w.environment} ` : ''}${activityName(w)}`;
  text(title.charAt(0).toUpperCase() + title.slice(1), 32, 56, title.length > 27 ? 25 : 34, C.white, 530, true);
  text(dateLabel(w.startDate), 33, 102, 12, C.white, 525);
  const offset = w.startDate.match(/([+-]\d{2}):?(\d{2})$/);
  text(`${w.timezone || (offset ? `UTC${offset[1]}:${offset[2]}` : 'Export timezone')}  |  ${w.source}`, 33, 123, 9, C.light, 525);

  card(32, 166, 'Distance', number(w.distanceKm, 2), 'kilometers', C.teal);
  card(213, 166, 'Workout duration', duration(w.durationMin), 'Recorded by Apple Health');
  const cycling = w.activity === 'Cycling';
  card(394, 166, cycling ? 'Average speed' : 'Average pace', cycling ? number(w.speedKmh, 2) : pace(w.paceMinKm), cycling ? 'km/h | workout duration' : 'min/km | workout duration');
  card(32, 258, 'Active energy', number(w.activeKcal), 'kcal', C.coral);
  card(213, 258, 'Average heart rate', number(w.hrAvg), 'bpm | Apple workout summary');
  card(394, 258, 'Heart rate range', w.hrMin !== null && w.hrMax !== null ? `${number(w.hrMin)} - ${number(w.hrMax)}` : 'Not recorded', 'bpm | minimum to maximum');

  rect(32, 354, 320, 228, C.white);
  text('Workout route', 47, 369, 12, C.ink, 275, true);
  text('GPS trace from this workout', 47, 387, 8, C.muted, 275);
  const segments = data.routeSegments;
  const points = segments.flat();
  if (points.length > 1) {
    const origin = points[0];
    const cos = Math.cos(origin[1] * Math.PI / 180);
    const project = p => [((p[0] - origin[0] + 540) % 360 - 180) * cos, p[1] - origin[1]];
    const xy = points.map(project);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of xy) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    const scale = Math.min(263 / Math.max(maxX - minX, 0.00001), 137 / Math.max(maxY - minY, 0.00001));
    const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
    const plot = p => { const q = project(p); return [192 + (q[0] - centerX) * scale, 479 - (q[1] - centerY) * scale]; };
    doc.save().rect(45, 405, 294, 148).clip();
    for (const segment of segments) {
      segment.forEach((p, i) => { const [x, y] = plot(p); i ? doc.lineTo(x, y) : doc.moveTo(x, y); });
      doc.lineWidth(1.8).strokeColor(C.teal).stroke();
    }
    const start = plot(points[0]), end = plot(points.at(-1));
    doc.circle(...start, 4).fill(C.teal); doc.circle(...end, 4).fill(C.coral);
    doc.restore();
    doc.circle(50, 566, 3).fill(C.teal); text('Start', 58, 561, 8, C.muted, 35);
    doc.circle(107, 566, 3).fill(C.coral); text('Finish', 115, 561, 8, C.muted, 38);
    text('North up | no map tiles', 185, 561, 8, C.muted, 152, false, 'right');
  } else {
    text('No GPS route available', 63, 463, 16, C.muted, 260, true);
    text('Workout totals remain available above.', 63, 489, 9, C.muted, 260);
  }

  rect(364, 354, 199, 228, C.ink);
  text('Session details', 379, 369, 12, C.white, 165, true);
  const details = [
    ['Elapsed time', duration(w.elapsedMin)],
    ['Outside workout duration', duration(w.nonActiveMin)],
    ['Total energy', w.totalKcal === null ? 'Not recorded' : `${number(w.totalKcal)} kcal`],
    ['Finished', dateLabel(w.endDate).split('  |  ').at(-1)],
  ];
  details.forEach(([label, value], i) => {
    const y = 399 + i * 40;
    text(label, 379, y, 8, C.light, 167);
    text(value, 379, y + 13, 14, C.white, 168, true);
  });
  text('Elapsed includes pauses.', 379, 565, 8, C.light, 169);

  const recent = data.workouts.filter(x => x.activity === w.activity).sort((a, b) => b.startMs - a.startMs || b.endMs - a.endMs).slice(0, 5);
  text(`Recent ${activityName(w)} workouts`, 32, 602, 13, C.ink, 525, true);
  text('Date and local start', 42, 627, 8, C.muted, 220);
  text('Distance', 275, 627, 8, C.muted, 70, false, 'right');
  text('Duration', 359, 627, 8, C.muted, 100, false, 'right');
  text('Avg bpm', 473, 627, 8, C.muted, 80, false, 'right');
  recent.forEach((r, i) => {
    const y = 645 + i * 24;
    if (i === 0) rect(32, y - 4, 531, 23, '#DCECE9', 4);
    text(dateLabel(r.startDate), 42, y, 9, C.ink, 220, i === 0);
    text(r.distanceKm === null ? 'n/a' : `${number(r.distanceKm, 2)} km`, 275, y, 9, C.ink, 70, false, 'right');
    text(r.durationMin === null ? 'n/a' : duration(r.durationMin), 359, y, 9, C.ink, 100, false, 'right');
    text(r.hrAvg === null ? 'n/a' : number(r.hrAvg), 473, y, 9, C.ink, 80, false, 'right');
  });
  line(32, 776, 563, 776);
  text(`${data.workouts.length} unique workouts scanned. Latest selected by workout start time.`, 32, 786, 8, C.muted, 531);
  text(`Source: ${inputName} | appleHealthExportPdf v${manifest.version} | Local report`, 32, 800, 8, C.muted, 531);
  if (data.warnings.length) text(`${data.warnings.length} import warning(s); see command output. Missing values are not estimated.`, 32, 814, 7, C.muted, 531);
  else text('Missing values are not estimated. Pace/speed use recorded workout duration and distance.', 32, 814, 7, C.muted, 531);
  doc.end();
  return completed;
}
