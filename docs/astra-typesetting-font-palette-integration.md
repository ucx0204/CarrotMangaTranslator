# Font palette lab reference and eventual integration

User requested read-only reference to
`C:/Users/sam40/Downloads/망가번역기-font-palette-lab-20260905` while frozen Astra
v0.4.3 candidate 4 was running, and said that worktree would later reach main.
No merge, external mutation, font replacement or active-candidate input change
was performed. Exact inspected file hashes, HEAD and dirty file inventory are
in `.tmp/astra-typesetting-research/font-palette-reference-001/reference.json`.
The external used-chapter registry was compared with ours: all exclusions were
already present and current discovery-004 was not previously used there.

## Mechanisms and evidence limits

S5 learns complete-glyph source similarity from verified OFL fonts, with
same-face/different-character positives and same-character/different-face
negatives. It retains kana and kanji evidence separately. Its complete-link
grouping requires every cross-pair to agree under a synthetic held-out cutoff;
weak evidence stays unresolved instead of forcing a fixed group count.

S6 pools S5 groups only when pooled script evidence and at least three shared
characters' observed pixel evidence agree. This addresses fragmentation caused
by differing character composition. It is source-only research, not proof of
commercial manga font identification or Korean matching. Earlier S4 failures
explicitly show ordinary mixed Japanese faces splitting by script/content.

C11 freezes S6 membership then chooses one curated Korean face per resolved
group. Its monoline/antique/strong mapping to Mongtori/Ridi Batang/Dohyeon is an
explicit researcher policy, with synthetic bold/italic off; unresolved groups
keep baseline. The binding audit proves invariants and consistent assignments,
not visual correctness. It must not silently replace Astra's independent
family/weight/slant model or erase genuine emphasis. In particular, our user
wants underlying family consistency while retaining weight variants, not one
uniform style forced on every member.

The transferable audit questions are script composition versus style, complete
glyph evidence versus disconnected fragments, purity versus fragmentation,
and whether uncertain short handwriting gets forced into a generic group.
Source family grouping, Korean face choice, weight and final layout remain
separate judgments. Lab rejected candidates and model-produced labels remain
research evidence, not human gold.

## Shared product contracts after the worktrees meet

- Reuse the common built-in/custom font catalog and actual renderer. Do not
  create a competing font manager or copy private legacy inference modules
  into the Astra feature. Lab's new palette and reference banks are separately
  versioned; the running Astra four-font preset remains frozen for evaluation.
- Lab removes Black And White Picture, Kirang Haerang and Single Day from the
  default bundle and preserves installed copies under stable custom UUIDs.
  Reuse `resolveDemotedBlockFontId` for persisted Astra preset IDs when that
  shared contract lands. Otherwise `validatePreset` would reject a saved legacy
  ID although the preserved custom font exists. Do not migrate page text or
  delete preserved font files as part of this integration.
- Keep the maximum ten fonts and user purpose notes. Newly added Kkubulim,
  Geummyeon Seongsil and Shilla need real font specimens and translated-text
  coverage checks. The lab documents empty glyph outlines despite cmap entries
  for some fonts; an ID existing in a catalog is not sufficient automatic
  lettering evidence. Existing catalog/coverage gateways are the authority.
- Lab keys (`Pxxx/Dxxx`, `SG5/SG6`) and Astra page/region UUIDs are different
  identities. Any future adapter must bind source image/crop hashes and explicit
  membership; never join by row order, copy Korean winners as source labels,
  or claim a membership hash identifies a universal font family.
- Both branches touch shared coverage tests; font catalog/rendering changes
  can change actual specimens even without a text conflict. After eventual
  integration, run focused preset alias/custom coverage/export checks, full
  checks/build, actual wide/narrow UI QA and a newly sealed whole-chapter
  experiment. Existing immutable trial outputs remain tied to their own bytes.

No product promotion, public release, integration completion or visual-quality
improvement is claimed from reading this reference. Inspect any newer lab
handoff and resynchronize used-chapter exclusions before the next fresh sample.

## Additional frozen-run weight defect

During candidate 4, the actual saved Gungseo and Mongtori specimens were compared
pixel for pixel. Their regular/bold halves are identical at 24, 40 and 60 pixels;
Gothic and Myeongjo differ. The exact receipt is candidate-004's
`readonly-specimen-weight-probe.json`. Both affected files have no fvar table.
Our CSS and the reference lab both declare a 400–800 weight range for those
single static files, while the actual renderer requests 400/800 and permits
weight synthesis. Thus simply merging the palette lab does not resolve this.

The [CSS Fonts specification](https://www.w3.org/TR/css-fonts-4/#font-prop-desc)
uses descriptor ranges for face matching. The inspected
[Chromium implementation](https://chromium.googlesource.com/chromium/src/+/d9eaf9872de887283c06369be628e2a280f51e98/third_party/blink/renderer/core/css/css_segmented_font_face.cc)
guards synthetic face selection with range capabilities. This supports the
descriptor hypothesis, but is not an exact-version runtime causal test. After
the frozen trial report is complete, characterize an honest single-weight
descriptor in the actual renderer, checking unchanged regular pixels and visible
bold differences before touching shared font declarations. Do not make every
source group bold, replace the font, or silently flatten emphasis as a workaround.

### Causal renderer diagnostic completed, production still frozen

`font-weight-causal-probe-v043-003/result.json` characterizes the descriptor
change in a separate hidden process using the actual frozen production specimen
producer and renderer. Only that process's document CSS is changed after each
production HTML load: Gungseo/Mongtori range 400–800 becomes the static weight 400. Source, out/ and font bytes pass the full frozen inventory before and after.

At 24/40/60px, regular pixels stay identical for both faces. Bold ink increases
and 1,544/2,846/4,985 Gungseo pixels and 1,433/2,698/4,643 Mongtori pixels change.
Untouched Gothic/Myeongjo regular/bold control pixels all stay identical. Both
changed specimen images were directly viewed and show visible weight contrast.
No manga/model call or production CSS edit was made.

The first diagnostic failed to find declarations through CSS imports; the second
changed only a document that the next production render reloaded, and correctly
reported no effect. Their failure artifacts are retained. The third records
the exact descriptor changes after all four actual document loads, before the
renderer's own font/layout checks. This timing correction is diagnostic harness
work, not three manga candidates or a shipped fix. Apply the characterized source
change only after the frozen whole-chapter report, then verify shared UI/export.

### Integration after the frozen report

The source descriptor correction was applied after the complete v0.4.3 audit.
`correctness-preparation-v044/verified.json` binds the v0.4.4 files and passing
26-gate check, including build and production artwork parity. The UI proof uses
actual PageArtwork/TextEditorGroup/Modal components and the actual bundled font
bytes in wide and narrow captures. Failed fallback-font captures are retained
and explicitly rejected. The two valid captures show the intended faces and bold
contrast. No font bytes, existing model assets or frozen training/evaluation banks
were replaced. A newly generated render-bank inventory now has 39 CSS candidates
and 760 render jobs, rather than 41/800: two false static 800 candidates were
removed. This does not retrain or promote the existing font matcher.
