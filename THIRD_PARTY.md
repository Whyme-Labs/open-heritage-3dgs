# Third-party software

## SuperSplat Viewer

- Package: `@playcanvas/supersplat-viewer`
- Pinned version: `1.29.3`
- Publisher: PlayCanvas
- License: MIT
- Purpose: Local WebGPU and WebGL2 Gaussian splat viewer

## SplatTransform

- Package: `@playcanvas/splat-transform`
- Pinned version: `3.3.0`
- Publisher: PlayCanvas
- License: MIT
- Purpose: PLY to SOG conversion and optional voxel/collision generation

## PlayCanvas Engine

- Package: `playcanvas`
- Pinned version: `2.21.4`
- Publisher: PlayCanvas
- License: MIT
- Purpose: Peer runtime dependency for SplatTransform

## download-splat helper

- Repository: `f-g-s/download-splat`
- Pinned commit: `a3102e90efe2c6314a1b3e0d53c23cc1c0e2175d`
- License: MIT
- Purpose: Resolve downloadable SuperSplat scene pages and convert them to PLY

The helper's own README warns users to respect creator rights. This project invokes it only for scenes whose pages display a download option and a compatible license. A scene-side HTTP 403 is treated as a stop signal, not bypassed.

## Build and deployment tooling

- Packages: `vite` (MIT), `@cloudflare/vite-plugin` (MIT), `wrangler` (MIT OR Apache-2.0), `@cloudflare/workers-types` (MIT OR Apache-2.0), `typescript` (Apache-2.0)
- Purpose: client bundling, local Workers/R2 emulation, and Cloudflare Workers deployment
