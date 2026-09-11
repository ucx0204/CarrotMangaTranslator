# Native preview integration resume boundary

Continue on `fix/redaction-review-and-sfx-93-20260911`. Never force-push or replay a whole old source snapshot. Read newer commit messages and inspect the current files first; the branch may advance while a checkpoint is being prepared.

## Verified checkpoints

- Preserve the existing F08 visible-region mask renderer, its `renderKey` readiness, and the narrowed F15 contracts.
- `ffe8358f43a9f223b8f876a13d9ba20f6298ebff`: the native crop schema, source-bound validation, immutable-source decoding and backend crop cache are attached to the branch. This is the verified backend checkpoint; do not use the older unavailable `b9c22d14` reference as evidence of completion.
- `6f7c2ed24725cca4baed21c750e03205048e3360`: the renderer preview queue now includes the shared crop variant identity. Overview images, different tile coordinates and different tile dimensions cannot satisfy each other's requests. Page-wide retry, request deduplication, priority, concurrency, LRU budgets and stale-fill protection remain intact.
- The cache checkpoint changes only `redactionPreviewCache.ts` and `manualRedactionNativePreviewCache.test.ts`. Both new regressions failed before the fix; the two new and four existing cache tests pass afterward. Focused ESLint and formatting pass. These are small non-DOM tests, not added UI scenarios.

## Remaining small commits

1. Connect `RedactionNativePreview` in `RedactionCanvas.tsx` at zoom >= 100 for sources larger than 2048px. Place it after the overview image and before the mask. Reuse `read(request, priority)`, `version(sessionId, pageId)` and `retryPage`; do not restore an old cache API.
2. Bind inspection completion to the current session, page, retry version and visible-region request instance. Add optional `inspectionReady` to `useRedactionImageReadiness`, preserving decoded-image, exact-mask and `renderKey` checks. A late completion, or returning to a previously visited viewport, must not approve a newly mounted blank inspection canvas.
3. Run focused lint/type checks, native crop/cache checks and the existing three basic UI smoke cases on the integrated source. The cache-only success does not establish native canvas integration or full repository success.
4. Finish ordinary Check, reconcile the main repair queue and F18 preparation integration status, and perform F19 documentation/temporary exporter cleanup. Do not restore screenshot matrices.

Check run `34591301018` was in progress for `6f7c2ed` when this checkpoint was written; re-query its result rather than assuming success. No master merge, squash, release or version change has been performed by the cache checkpoint.

Local preparation used `/mnt/data/carrot-repair`, a verified source mirror initially matching tree `7295c28df543e03482063e33007f75efae5f841b`. Its local commit history is not remote ancestry. Only the two files named above were uploaded for `6f7c2ed`; superseded local proposals were not applied to the branch. Recover from the current remote files, not a whole local snapshot.

Keep #93's already committed JSON recovery, structured-output handling and zero-result failure classification. Do not close that issue based solely on synthetic tests or claim a live reproduction of the reporter's custom model.
