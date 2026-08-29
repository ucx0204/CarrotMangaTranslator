# Flux CPU-only runner r1 handoff

- Release: <https://github.com/ucx0204/CarrotMangaTranslator/releases/tag/flux-runners-cpu-win-x64-r1>
- Producer commit: `f73ea665c14d68a2cd8ffeb9fccc9aca3c22d757`
- Release state: prerelease, asset-only, immutable
- Inventory authority: [`flux-runners-cpu-win-x64-r1.json`](./flux-runners-cpu-win-x64-r1.json)
- Checksums: [`flux-runners-cpu-win-x64-r1-SHA256SUMS.txt`](./flux-runners-cpu-win-x64-r1-SHA256SUMS.txt)

## Contract

`scripts/prepare-flux-klein-cpu-runner.cjs` builds the shared Flux Klein Rust
runner with locked dependencies, release optimizations and no default features. The producer
requires Windows x64 and rejects a binary unless `--capabilities` reports `cpu-native`,
`cpu_only=true`, `cuda_compiled=false`, `metal_compiled=false` and protocol version 1.

`scripts/package-flux-klein-cpu-release.cjs` creates a deterministic ZIP with exactly one root
entry, `mgt-flux-klein-cpu.exe`. Its manifest binds both archive and executable names, byte sizes
and SHA-256 values; `SHA256SUMS.txt` binds the archive and manifest.

## Publication verification

The three assets were uploaded sequentially without replacement. They were then downloaded with
`gh release download` into a new empty directory. Server and downloaded name, count, byte size and
SHA-256 matched the pre-upload inventory. The downloaded ZIP contained exactly the one expected
root executable; its byte size and SHA-256 matched the manifest, and both CPU-only capability and
shutdown protocol probes passed from the re-extracted executable.

The app pins the release URL, archive bytes and SHA-256, executable bytes and SHA-256, and cache
version in `src/main/inpainting/fluxAssets/constants.ts`. `cpuRunner.ts` downloads only on first
`cpu-native` use, extracts with the shared safe ZIP path and writes a URL/hash-bound cache marker.
The Windows installer must not contain the CPU runner.

After updating the consumer, `npm run smoke:flux-cpu-remote` ran from a production build with a new
empty runtime root and an explicitly empty local tools directory. It downloaded the real GitHub ZIP,
validated the pinned archive and executable contracts, ran the CPU-only capability and shutdown
protocol probes, then resolved the same executable from the verified cache on a second call.

## Rollback

Do not modify, replace or delete the r1 release or its assets. If the consumer must be rolled back,
make a new code commit that removes the r1 download contract and disables `cpu-native` selection
until a newly tagged immutable runner is available. Do not reuse this tag, asset name or cache
version for different bytes.
