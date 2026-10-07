# Test suite optimization, October 2026

This change preserves application behavior, coverage thresholds, platform coverage,
and the capacity/recovery integration scenarios. It does not disable test isolation
or increase the macOS worker limit, which protects against prior heap exhaustion.

## Verification ownership

| Previous check                                                 | Retained verification                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcpChapterDeletionCatalog.test.ts`                            | `mcpExchangeRetentionRecords.test.ts`: chapter page bounds, non-downloadable metadata, and the shared kind matrix                                                                          |
| `mcpContextRetentionContracts.test.ts`                         | Same file: context bounds including fractional/oversized input, all four public list descriptors, and legacy page bounds                                                                   |
| `mcpResearchBatchRetentionIndex.test.ts`                       | Same file: zero-page research records, unknown kinds, and shared legacy/context bounds                                                                                                     |
| Exchange raster page floor                                     | Same file: raster and text MIME page floors in one table; output payload/source-binding checks remain separate                                                                             |
| `rendererCustomSelectCoverage.test.ts`                         | `check-maintainability-policy.cjs`: the same tag prohibition over all renderer `.ts`/`.tsx`, including UI primitives; cannot be accepted through a baseline update                         |
| Exact motion durations, scale factor, delay and CSS whitespace | Removed cosmetic implementation assertions; reduced-motion, clipping/scaling exclusions and layout-size tweening guards remain in `uiMotionCss.test.ts`                                    |
| Repeated research search setup                                 | `searchEvidence` within the original evidence suite; preserves query, credits and every result field. Three character correction cases use named table rows with the original expectations |

The 50-page workflow, 35 sequential child edits, 512-job compaction/replay, ownership,
revocation, cancellation, transaction failure and recovery tests remain intact.

## Execution changes

- The native PNG boundary fixture retains decoded pixels and lazily encodes each
  image once. Crop uses independent pixels directly. Each PNG result is a copied
  buffer. A characterization test checks byte parity, pixels, alpha, nested crop
  coordinates and mutation isolation.
- Native CLI probes reuse successful results only within one invocation, keyed by
  executable path, ordered arguments, full sorted environment and timeout. Failed
  or interrupted probes are not reused. Every preset still constructs and checks
  its flags, asserts the result, and records evidence; reused logs point to the
  original probe log. Prepared published binaries are immutable during the run.
- Check caches Cargo registry/git sources and the relevant native target folders.
  Keys separate OS, architecture, runner image, Rust compiler identity, manifests,
  lockfiles, build scripts/options and Rust source. Source changes can restore the
  matching dependency cache; Cargo still rebuilds and all capability/tests run.
- UAC Acceptance's duplicate full-check job runs only for its dedicated branch
  push. PRs receive the full suite from Check. Both packaged installer smoke paths
  remain in UAC Acceptance.

## GitHub test sharding

Check now runs four isolated test runners per OS in parallel with static checks,
the application build, Electron smoke checks, and native CLI/runtime validation.
Each macOS test runner still uses one Vitest worker and the existing 4 GiB heap
limit. Windows retains its resource-aware worker limit. No test is selected by
changed paths; every discovered test file runs on both platforms, with only the
existing platform skips.

The existing required job names, `windows-check` and `macos-arm64-check`, are the
final gates. They fail unless their build job and every test shard succeeded.
Before Vitest merges the four blob reports, Check verifies their commit, platform,
architecture and SHA-256, and compares their combined file inventory with a fresh
`vitest list --filesOnly`. Missing, duplicate, stale and extra files are errors.
The merged report is checked against the same inventory again. Coverage thresholds
are deferred only in shard subprocesses; the merge enforces the unchanged global,
per-file and production-cleanup coverage floors.

`npm run check` and `npm run check:cold` still run all 27 gates locally. CI uses
three explicit parts; passing one part is not a complete Check:

```text
npm run check -- --phase=build
npm run check -- --phase=test --shard=1/4  (also 2/4, 3/4, 4/4)
npm run check -- --phase=merge
```

The setup composite shares locked toolchain setup. Only the build job saves
native/check caches; test runners restore native caches and still build and
validate the import runner. Build and test checkouts fetch the current revision.
The merge job retains full history with `blob:none` filtering because the cleanup
coverage gate compares source paths against its historical baseline commit.

Shard artifacts are scoped to the workflow run and OS. Rerunning a failed shard
replaces its own artifact; unchanged successful shards remain usable at the same
commit. Diagnostic artifacts retain the run attempt and shard number. Wall time
must be measured from workflow start through the final gates, including queues,
setup, transfers and merging; parallelism can increase total runner minutes.

Local validation of the distributed path passed the build/static gates, all four
test shards and the merged coverage gates: 1,329 files, 10,324 passing cases and
nine existing skips. Ten added cases exercise the CI partition and missing/stale/
duplicate shard guards in the existing check test file. No previous case changed
status or disappeared (one existing case embeds a varying timestamp in its name).
No per-file coverage metric decreased; two files recorded slightly higher coverage.

## Measurement

The pre-change reference is successful Check run
[37595355553](https://github.com/ucx0204/CarrotMangaTranslator/actions/runs/37595355553).
Windows/macOS coverage stages took 1040.63/1270.95 seconds and import-runner builds
took 209.51/158.82 seconds. File result durations identify MCP as the largest group,
but sums across parallel workers must not be reported as wall-clock savings.

Compare the same candidate commit on Windows and macOS with a missing native cache
and then a restored cache. Preserve check timing, coverage summary and native CLI
probe artifacts for both. Local timings and fixture microbenchmarks are diagnostic
only, not a substitute for measuring GitHub runner performance.

Local validation on Windows passed all 27 Check gates (386.00 seconds), including
1,329 test files and unchanged coverage totals: statements 85.51%, branches 78.95%,
functions 87.80%, lines 86.70%. The earlier local reference was 356.18 seconds;
this run does not establish a full-suite speed improvement. GitHub native-cache
savings require the cold/restored-cache comparison described above.
