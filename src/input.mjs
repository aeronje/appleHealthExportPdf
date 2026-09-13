import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function selectInput(importDirectory) {
  let entries;
  try { entries = await readdir(importDirectory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Import folder not found: ${importDirectory}. Create it and add an Apple Health .zip export.`);
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.zip') continue;
    const file = path.join(importDirectory, entry.name);
    const info = await stat(file);
    candidates.push({ file, name: entry.name, modifiedMs: info.mtimeMs });
  }
  // A stable filename comparison resolves equal timestamps on every platform.
  candidates.sort((a, b) => b.modifiedMs - a.modifiedMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!candidates.length) throw new Error(`No .zip files found in ${importDirectory}. Add an Apple Health export ZIP and run again.`);
  return { ...candidates[0], count: candidates.length };
}
