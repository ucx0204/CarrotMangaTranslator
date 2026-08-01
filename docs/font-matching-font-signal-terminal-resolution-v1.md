# Font-signal terminal resolution v1

Two final-v3 accepted recrops are not safe font-training inputs after the
source-derived glyph gate is applied:

- `fm_511d6cd195edb424c3f3efe7`
- `fm_ef3d9054b5f850ddc134087e`

At original scale, both contain a complete target text object, but the target
is inseparable by a tighter rectangle from dense screentone, speed lines, or
person/clothing art. The deterministic gate reports exactly
`high_frequency_art_or_pattern_contamination` for both. Tighter rectangles
either cut glyphs or retain the contamination. No manual mask, generated
repair, or synthetic replacement is authorized for the core dataset.

The terminal finalizer is deliberately limited to those two IDs. It binds each
human terminal decision to the sealed final-v3 accepted row and line bytes,
accepted crop file and pixels, review-context file and pixels, preserved source
page, normalization contract, gate result, and gate statistics. It refuses a
different ID, different reason, additional hold, symlink, source drift, overlap,
or existing output.

The promoter then materializes only the other 18 rows. Its new parent-exclusion
ledger contains all 20 parents: 18 superseded by clean successors and two
terminally excluded without successors. Consequently, neither contaminated
parent can remain in the successor master.

## Read-only preflight

```powershell
python scripts/finalize_font_matching_font_signal_terminal_exclusions_v1.py preflight --final-root datasets/font-matching-font-signal-recrop-repair-final-v3 --library-root library --output-root datasets/font-matching-font-signal-terminal-resolution-v1 --reviewer codex-root-direct-review-v4 --exclude-id fm_511d6cd195edb424c3f3efe7 --exclude-id fm_ef3d9054b5f850ddc134087e --expected-accepted 20 --expected-terminal 7
```

The verified production preflight result is 20 checked, 18 pass, two human
terminal exclusions, zero unresolved holds, and zero replacement/synthetic
pixels. Preflight must not create the output root.

## Build and validate the immutable terminal artifact

Run `build` only after confirming the preflight result and both direct visual
reviews. Then run `validate` with the identical arguments.

```powershell
python scripts/finalize_font_matching_font_signal_terminal_exclusions_v1.py build --final-root datasets/font-matching-font-signal-recrop-repair-final-v3 --library-root library --output-root datasets/font-matching-font-signal-terminal-resolution-v1 --reviewer codex-root-direct-review-v4 --exclude-id fm_511d6cd195edb424c3f3efe7 --exclude-id fm_ef3d9054b5f850ddc134087e --expected-accepted 20 --expected-terminal 7
python scripts/finalize_font_matching_font_signal_terminal_exclusions_v1.py validate --final-root datasets/font-matching-font-signal-recrop-repair-final-v3 --library-root library --output-root datasets/font-matching-font-signal-terminal-resolution-v1 --reviewer codex-root-direct-review-v4 --exclude-id fm_511d6cd195edb424c3f3efe7 --exclude-id fm_ef3d9054b5f850ddc134087e --expected-accepted 20 --expected-terminal 7
```

## Promote the remaining 18

Run the promoter preflight first. Build and validate use the same arguments,
changing only the positional command.

```powershell
python scripts/promote_font_matching_font_signal_recrop_repair.py preflight --final-root datasets/font-matching-font-signal-recrop-repair-final-v3 --source-master-root datasets/font-matching-master-v2 --catalog-registry datasets/font-matching-catalog-registry-v2.json --library-root library --terminal-exclusion-review-root datasets/font-matching-font-signal-terminal-resolution-v1 --output-root datasets/font-matching-font-signal-recrop-promotion-v1 --successor-registry-output datasets/font-matching-catalog-registry-v3.json --successor-master-output datasets/font-matching-master-v3 --expected-accepted 20 --expected-terminal 7
python scripts/promote_font_matching_font_signal_recrop_repair.py build --final-root datasets/font-matching-font-signal-recrop-repair-final-v3 --source-master-root datasets/font-matching-master-v2 --catalog-registry datasets/font-matching-catalog-registry-v2.json --library-root library --terminal-exclusion-review-root datasets/font-matching-font-signal-terminal-resolution-v1 --output-root datasets/font-matching-font-signal-recrop-promotion-v1 --successor-registry-output datasets/font-matching-catalog-registry-v3.json --successor-master-output datasets/font-matching-master-v3 --expected-accepted 20 --expected-terminal 7
python scripts/promote_font_matching_font_signal_recrop_repair.py validate --final-root datasets/font-matching-font-signal-recrop-repair-final-v3 --source-master-root datasets/font-matching-master-v2 --catalog-registry datasets/font-matching-catalog-registry-v2.json --library-root library --terminal-exclusion-review-root datasets/font-matching-font-signal-terminal-resolution-v1 --output-root datasets/font-matching-font-signal-recrop-promotion-v1 --successor-registry-output datasets/font-matching-catalog-registry-v3.json --successor-master-output datasets/font-matching-master-v3 --expected-accepted 20 --expected-terminal 7
```

The promotion does not execute the successor registry or master commands. Use
the exact sealed argv arrays in
`font-matching-font-signal-recrop-promotion-v1/registry-successor-input.json`
after promotion validation succeeds.
