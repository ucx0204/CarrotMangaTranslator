// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */

const FONT_ROLE_KEYS = "fontRole, fontRoleConfidence";

/** @param {PromptSection[]} sections @param {PromptOptions} options */
function applyFontMatchingIntentOutput(sections, options) {
  if (!options.autoFontMatching) return;
  const output = sections.find((section) => section[0] === "Output");
  if (!output) return;
  const keyIndex = output.findIndex((line) =>
    line.startsWith("Use exactly these keys, one per line:"),
  );
  if (keyIndex >= 0) {
    output[keyIndex] = output[keyIndex].replace(
      "textRole,",
      `textRole, ${FONT_ROLE_KEYS},`,
    );
  }
  const templateIndex = output.findIndex(
    (line) =>
      line.includes("textRole: <ordinary|sound>") && line.includes("jp:"),
  );
  if (templateIndex >= 0) {
    output[templateIndex] = output[templateIndex].replace(
      "textRole: <ordinary|sound>\n",
      [
        "textRole: <ordinary|sound>",
        "fontRole: <fine-grained role>",
        "fontRoleConfidence: <0.00-1.00>",
      ].join("\n"),
    );
  }
}

/** @param {PromptOptions} options @returns {PromptSection} */
function buildFontMatchingIntentSection(options) {
  if (!options.autoFontMatching) return [];
  return [
    "Font matching intent",
    "Classify the visible source lettering and its container, not the work title, genre stereotype, translated wording, or string length.",
    "fontRole must be exactly one of: dialogue, narration, thought, whisper, aside_balloon_edge, emphasis_dialogue, shout, sfx_impact, sfx_motion, sfx_ambient, sfx_emotion, sfx_comic, sign_ui_title, other, unknown_needs_review.",
    "Use dialogue for normal speech-balloon text; narration for caption/free narrative text; thought for internal monologue or thought containers; whisper for visibly quiet speech.",
    "Use aside_balloon_edge only for small handwritten or detached text beside a balloon; use emphasis_dialogue for visibly emphasized speech and shout only for clearly shouted speech.",
    "Use sfx_impact for hits/explosions/heavy shocks, sfx_motion for movement/cutting/speed, sfx_ambient for environmental texture or ominous atmosphere, sfx_emotion for heartbeats/sighs/soft reactions, and sfx_comic for comedic reaction lettering.",
    'fontRole values beginning with "sfx_" require textRole "sound"; every other concrete fontRole requires textRole "ordinary".',
    "Use sign_ui_title for signs, interface labels, chapter/title lettering, and display cards. Use unknown_needs_review whenever the visual role is genuinely ambiguous.",
    "fontRoleConfidence is confidence in that fine-grained visual role only. It is separate from translation confidence; use below 0.82 when the container, lettering intent, or SFX class is uncertain.",
  ];
}

module.exports = {
  applyFontMatchingIntentOutput,
  buildFontMatchingIntentSection,
};
