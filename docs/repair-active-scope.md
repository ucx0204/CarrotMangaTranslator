# Active repair checkpoint coordination

Continue on `fix/redaction-review-and-sfx-93-20260911`; never force-push.

- Preserved current HEAD `f1fa6f2`: F03 resource-scoped conflict policy (verification pending), F13 source budget, F05 value equality, F01/F02 and SFX fixes.
- SFX `9088c21` and `168ac7d`: bounded JSON recovery and honest zero-result failure classification are pushed. Native broader SFX tests remain pending; see `sfx-93-repair.md`.
- Independent work proceeding from this checkpoint: **F06 per-page undo budget, then F07 copy-scale policy**. Do not duplicate/replay an already pushed variant.
- Concurrent F04/F10 preview/error ownership work must be preserved. Validate F03/F13 against the latest exact tree before marking them verified.
- Source transfer workflow is temporary; remove it after the final source synchronization. Preserve the original three basic UI checks; no browser screenshot matrix.

Read commit messages newer than this file first. Consolidate this coordination note into the main repair record at completion.
