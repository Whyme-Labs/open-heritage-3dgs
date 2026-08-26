# Validation record

Validation performed on 25 August 2026 (Node server revision) and 26 August 2026 (Vite + Workers + R2 migration).

## Passed (26 August 2026, Vite/Workers/R2)

- `npm run verify`: file layout, manifest, boundaries, pinned dependencies, worker and wrangler config tokens.
- `npx tsc --noEmit` over `worker/index.ts`.
- `npm run build`: client bundle plus Worker bundle produced by Vite.
- Local end-to-end through the Vite dev server with the simulated `SCENES` R2 bucket:
  - static assets: `/scenes.json`, `/boundaries/*.json`, `/viewer/index.html` -> 200;
  - `HEAD /scenes/<slug>.ply` -> 200 with `Content-Length`, `Accept-Ranges`, ETag;
  - `Range: bytes=0-99`, open-ended, and suffix (`bytes=-64`) requests -> 206 with correct `Content-Range`;
  - unsatisfiable range -> 416; missing object -> 404;
  - ranged body bytes verified byte-identical against the source PLY header.

## Passed (25 August 2026)

- JavaScript syntax checks for the main application, local server, viewer builder, verifier, and injected controls.
- Bash syntax checks for setup, downloading, and scene preparation.
- JSON parsing and structural checks for the scene manifest and all four boundary files.
- Viewer-template injection test against the documented `html`, `css`, and `js` package interface.
- Scene-preparation flow with a deterministic converter fixture, covering SOG-only output and voxel plus GLB collision output.
- Downloader regression test matching the observed failure: existing Pantheon skipped, Saka returning HTTP 403, later scenes continuing, and a successful overall batch exit.
- HTTP server tests for GET, HEAD, byte-range requests, method rejection, and path traversal rejection (superseded by the Worker R2 route tests above).

## Environment-limited checks

The build environment has no outbound DNS, so it could not run the real `npm install`. It also has no usable headless GPU, so it could not render a real WebGPU frame. The package interfaces, URL parameters, renderer fallback, camera-state hooks, collision inputs, and CLI flags were checked against the pinned upstream source and documentation.

The first full run on a given machine remains the final integration check:

```bash
./setup.sh
npm run sync:r2
npm run dev
```

Open `http://localhost:5173`, confirm that Pantheon loads, and check the renderer badge. Chrome or Safari should report either `WebGPU active` or `WebGL2 fallback`.
