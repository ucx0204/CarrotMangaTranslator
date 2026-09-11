# Active repair checkpoint coordination

Continue on `fix/redaction-review-and-sfx-93-20260911`; never force-push.

- Preserved current HEAD `fc062c1`: F06 page/batch history is already committed. F03/F13/F05 and both SFX checkpoints are also present. Do not replay alternate variants.
- Independent work here is now **F08 bounded visible-region mask rendering and F09 native-resolution preview crops**. Start with the backwards-compatible pure raster-region API, then connect the viewport and preview adapter in separate commits.
- Preserve concurrent F04/F10 work and F14/F07 changes; do not overwrite their files from an old snapshot. The shared raster function and preview request contract will gain optional region support, preserving full-page behavior.
- SFX `9088c21` and `168ac7d`: bounded JSON recovery and honest zero-result failure classification are pushed. Native broader SFX tests remain pending; see `sfx-93-repair.md`.
- Source transfer workflow is temporary; remove it after source synchronization. Preserve the original three basic UI checks; no browser screenshot matrix.

Read newer commit messages first. Consolidate this note into the main repair record at completion.
