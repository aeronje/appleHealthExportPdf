# appleHealthExportPdf

A local Node.js script that reads an Apple Health export ZIP and creates a one-page PDF dashboard for the latest workout. Works on Windows and Linux with Node.js 22 or later. Version: 1.1.1; version metadata is in `manifest.json`.

## Run

Install dependencies once from the repository directory:

```sh
npm ci
```

Place your Apple Health ZIP export in `import/`, then run:

```sh
node appleHealthExportPdf.mjs
```

```text
appleHealthExportPdf/
  import/          <- put Apple Health ZIP exports here
  output/pdf/      <- generated workout dashboards appear here
  appleHealthExportPdf.mjs
```

Any filename ending in `.zip` is recognized, including uppercase `.ZIP`. If several files are present, the newest **file modification time** wins. Equal timestamps use ascending filename order for a deterministic choice. Files in subfolders, symlinks and other extensions are ignored. Modification time is a filesystem property, not the date embedded in the filename or the export contents; copying tools may preserve it.

The script always reads the repository's `import/` and writes to its `output/pdf/`, even when launched by full path from a different working directory. The selected filename and its timestamp are printed before processing. A missing or empty import folder produces an actionable error. If the newest ZIP is invalid, the run fails instead of silently using an older export.

Inside the selected ZIP, the latest workout is still chosen by its actual workout start time. These are two separate decisions: newest ZIP file first, newest workout inside it second.

The output filename includes workout date, time and activity. Repeated runs add a numeric suffix instead of overwriting a PDF. An optional custom output is resolved from the terminal's working directory:

```sh
node appleHealthExportPdf.mjs --output my-workout.pdf
```

An explicit output must end in `.pdf` and must not already exist. `--help` shows usage. The old `--input` option was removed in v1.1.0 so imports always come from `import/`. ZIPs remain untouched. The archive must contain exactly one `export.xml` with a `HealthData` root.

Private contents of `import/` are ignored by Git, while its README and `.gitkeep` preserve the folder in a public clone. Generated PDFs and ZIP files elsewhere in the project are ignored too.

## What's in the PDF

- Latest workout type, indoor/outdoor label when present, local start time and source.
- Distance, recorded workout duration, derived pace (speed for cycling), active energy and heart-rate summary.
- Elapsed time, the difference between elapsed and recorded duration, and total energy when available.
- The latest workout's linked GPS route, drawn locally without map tiles or network requests.
- Up to five most recent workouts of the same activity for context.

## Data rules and limits

- `export.xml` is streamed from the ZIP. Only workout summaries are retained. The XML is not extracted to disk. Other health records, ECG files and the CDA document are not imported.
- The latest valid workout is chosen by `startDate` as a timezone-aware instant, regardless of XML order, creation date, ZIP filename or export date. End time breaks ties. Invalid timestamps/types are skipped with a warning. All activity types are eligible, not only walking/running/cycling.
- Identical normalized workout summaries are deduplicated; different sources remain distinct.
- Direct child `WorkoutStatistics` provide the workout totals. Nested activity totals are ignored to prevent double counting. Legacy distance and energy attributes are supported. Legacy total energy is never relabeled as active energy.
- Distance is converted to km; energy to kcal; duration to minutes internally. Unknown units and missing values show as not recorded, never invented zeros. Heart-rate values come from Apple's workout summary, not a new average of unrelated samples.
- Pace/speed are computed from recorded duration and distance. Pauses remain part of elapsed time but do not inflate the recorded duration. This computed pace can differ from Apple's separately calculated pace metrics.
- No calories, durations, distances or heart-rate values are inferred from the route. The route is a simplified local trace with a north-up projection, not a street map. Missing GPS is expected for some activities. Multi-segment routes remain disconnected. Very long routes are downsampled for the PDF.
- Workout timestamps display their exported wall time and timezone, independent of the computer's timezone. History can be sparse if workouts were not recorded or exported.
- Dependencies are downloaded during installation only. Runtime processing uses local files and opens no ports. No Apple account, AI service, API key or upload is involved. PDFs include health metrics and any available route, and remain in your chosen local output directory.
- Health ZIPs, PDFs, temporary files and output directories are ignored by Git. Tests use synthetic data only.

## Verify and maintain

```sh
npm test
```

Tests cover chronological selection across timezone offsets, pauses, unit conversion, missing metrics, cycling, nested statistics, duplicates, malformed archives, missing routes, newest ZIP selection, extension filtering, tied timestamps, invalid newest imports, and invocation from a different working directory. Keep package and manifest versions aligned when changing behavior.

Implementation references: [yauzl ZIP streaming](https://github.com/thejoshwolfe/yauzl), [saxes XML parsing](https://github.com/lddubeau/saxes), and [PDFKit vector graphics](https://pdfkit.org/docs/vector.html).
