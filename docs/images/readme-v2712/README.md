# README screenshots and sample artwork

Captured on 2026-09-21 from the production renderer at source commit
`e0dacc3ef0952c4958d65b1402ad19c02ec0cf88`, with the local fixes for issues
#119, #122, #123 and #124. The captures show version 2.7.12 before the release version bump. These fixes
and the rewritten documentation are included in v2.7.13.

## What the pictures demonstrate

The UI screenshots use the actual `App` and its production components/styles.
An isolated `qa:ui` bridge supplies an original demo work, page, translation
blocks, glossary and character. No personal library, account credentials or
private manuscript was used. Hardware information is explicitly demo data.

The story is **홍차가 식었으므로, 전부 처형하였습니다**: villainess Seraphina
calmly announces executions over cold tea and a sneeze, leaving the court silent.
The user requested simple black-and-white manga, severe expressions and stronger
comic menace, without elaborate rendering.

The art and Korean sound-effect edit were prepared with **Codex's built-in
imagegen tool**, not the fallback API/CLI. The UI was not generated with AI.
This is an explanatory sample, not an end-to-end run or quality benchmark of the
app's OCR, translation, inpainting or sound-effect generation pipeline.

| Asset                                          | Purpose                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| [demo-original.png](demo-original.png)         | Generated Japanese original                                                        |
| [demo-clean.png](demo-clean.png)               | Empty dialogue balloons and narration; large Japanese impact retained              |
| [demo-sfx-ko.png](demo-sfx-ko.png)             | Imagegen localization of the large impact lettering to Korean `쾅`                 |
| [comparison-before.png](comparison-before.png) | Original shown through the production `PageArtwork` renderer                       |
| [comparison-after.png](comparison-after.png)   | Korean image background plus editable Korean text blocks rendered by `PageArtwork` |
| [workspace.png](workspace.png)                 | Actual app workspace with the same Korean sample                                   |

The comparison keeps the dialogue as ordinary text blocks, sized and positioned
inside the cleaned balloons. The large effect is already present in the prepared
background for these documentation captures. The screenshots therefore do not
claim to demonstrate an app-created generated-image block or its saved history.

## Final prompt specifications

The following records the final generation/edit instructions in condensed form.
The edits use the preceding image as their target and preserve its page layout,
characters and simple ink style.

1. **Story / illustration:** four-panel black-and-white villainess manga, sparse
   background and clean ink. Keep the existing cold-tea/execution/sneeze story.
   Seraphina should look smug and intimidating; attendants should look terrified.
   Use exaggerated expressions and forceful brush-lettered effects, without
   graphic injury or decorative detail. Japanese dialogue:
   - `公爵様、紅茶はたった一度冷めただけです…`
   - `分かっています。だから侍従長を処刑しました…`
   - `今、くしゃみをしたのは誰？`
   - `うるさかったので、くしゃみをした方も処刑しました…`
   - Bottom effect: `シーン`
   - Narration: `その日、宮廷はいつにも増して静かだった…`
2. **Clean lettering areas:** remove the four dialogue texts, bottom narration
   and `シーン`. Leave balloons, their outlines, artwork and the large split
   Japanese `ドン` unchanged. Do not insert replacement dialogue.
3. **Localize the large effect:** replace the large split Japanese impact in the
   middle-right panel with brush-lettered Korean `쾅`, white over dark hair and
   black in the lower white area. Retain the rough ink energy, empty balloons,
   faces, panel borders and all other artwork. Do not add detail or other text.

Selected built-in output IDs, in the same order:

- `exec-ba94fa10-2211-49b9-9cf2-b13ea1a8a523`
- `exec-36529ec0-d0ea-45aa-8737-bc275da0a4e9`
- `exec-50815514-8f71-40e5-99ed-f6ff914d1968`

## Capture method

A temporary renderer entry imported the real app, initialized Korean UI, and
extended the complete bridge injected by the repository QA tool. Settings began
with the app's clean defaults. Screens were reached through their actual buttons,
tabs and shortcuts. The temporary entry was removed after capture.

```powershell
npm run qa:ui -- --entry "qa-readme.html?scene=workspace" --build-channel stable --wait 7500 --width 1600 --height 980 --output docs/images/readme-v2712/workspace.png
```

The same entry covered import, translation, text/layout/format editing, batch
preview, sound-effect candidates, terms/characters/rules/story, gathered text,
retouching, inpainting, image/PSD export, command search, shortcuts and settings.
Comparison pages were captured at 1086 × 1448 using `PageArtwork` with matching
image and overlay dimensions. Wide UI captures are 1600 × 980; additional
workspace, batch, format, image-settings and SFX QA captures are 1240 × 760.

Screens were opened for visual inspection. The fixture also rejected renderer
errors, text-layout overflow and external viewport scrolling. The code changes
passed `npm run check`, including tests, type checks, lint, build, artwork parity
and protocol/bundle smoke checks. These checks do not measure AI model quality.
