# Native preview integration resume boundary

Continue on `fix/redaction-review-and-sfx-93-20260911`. Never force-push or replay a whole old source snapshot. Read newer commit messages and inspect the current files first.

## Previously confirmed product checkpoints

- `77d92579d784f08dc8bd079c2de4aa38a49af91a`: F08 visible-region native mask integration. Preserve `renderKey` readiness and the narrowed F15 contracts.
- `b9c22d14c767d2b3d33c419d71f8beb4d5237779`: F09 backend native crops, immutable-source checks and variant keys. Backend support alone is not the finished inspection UI.

## Small next commits

1. Inspect `redactionNativePreview.ts` and `RedactionNativePreview.tsx` on the branch. These support files use the current cache API: `read(request, priority)`, `version(sessionId, pageId)`, and `retryPage`. Do not replace that cache with the older `load/pageEpoch/invalidate` implementation.
2. Include `redactionPreviewVariantKey(request.maxEdge, request.region)` in the existing renderer cache key, while preserving the page version, queue priority, concurrency and byte budget. Add the small crop-variant/cache invalidation regression before enabling inspection.
3. Connect native inspection in `RedactionCanvas.tsx` at zoom >= 100 for sources larger than 2048px. Place the native canvas after the overview image and before the mask. Bind its React key and completion state to session, page, retry version and visible region.
4. Add optional `inspectionReady` to `useRedactionImageReadiness`; combine it with the existing decoded image, exact mask and `renderKey` readiness. Preserve `form: Pick<RedactionWorkspaceController, "markPreview">` from `redactionWorkspaceTypes`. Do not mark a new viewport ready from an old completion.
5. Run focused lint/type checks, native crop/cache tests and the existing three basic UI smoke cases. Synchronize the exact current branch for final ordinary Check and F19 cleanup. Do not restore screenshot matrices.

Some earlier native-preview trees were created but not attached to the branch. Their existence is not proof of a push. Reconcile the current ref and actual file contents before claiming completion. The worktree used for local preparation is `/mnt/data/carrot-fixes`; its Git history is only a source-validation mirror, not remote ancestry.

Keep #93's already committed JSON recovery, structured-output handling and zero-result failure classification. Do not close that issue based solely on synthetic tests or claim a live reproduction of the reporter's custom model.
