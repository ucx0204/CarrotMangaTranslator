import type {
  AutomaticFontCandidate,
  AutomaticFontSemanticSlot,
} from "../../shared/fontMatchingTypes";
import type { MangaPage } from "../../shared/libraryTypes";
import { stripRichTextMarkup } from "../../shared/richTextMarkup";
import { resolveUiLocale, type UiLocale } from "../../shared/uiLocales";
import { fontCandidateSupportsText } from "../fontCoverage";
import { fontCandidateSupportsBodyLocale } from "./automaticFontBodyCoverage";
import {
  resolveWorkFontProfile,
  type WorkFontProfile,
} from "./automaticFontProfiles";
import type { OverlayItem } from "./types";

export type AutomaticFontDecision = {
  fontId: string;
  slot: AutomaticFontSemanticSlot;
  /** Measurement-only width correction; rendered glyphs are not stretched. */
  fontMetricWidthScale?: number;
};

type SoundSlot = Exclude<AutomaticFontSemanticSlot, "body">;

const STRONG_IMPACT =
  /쾅|꽝|쿵|콰앙|펑|빵|붐|퍽|탕|두둥|ドン|ガン|ゴン|バン|ズド|ドカ|轰|轟|砰|嘭|咚|哐|啪|爆|boom|bang|crash|slam|thud|pow/i;
const SHARP_MOTION =
  /슥|휙|쉭|촤악|챙|샥|탁|딱|찰칵|찌익|찌릿|찌르르|파직|지직|ズバ|シュ|サッ|スッ|キン|カチ|ビリ|ピリ|メキ|ベキ|バキ|ギシ|ミシ|嗖|唰|咻|咔嚓|喀嚓|锵|鏘|whoosh|swish|slash|snap|click|zap|crack/i;
const SOFT_EMOTION =
  /두근|콩닥|살랑|사락|반짝|하아|후우|쓰담|꼬옥|キラ|ドキ|ふわ|ほわ|ぎゅ|ぽっ|怦怦|扑通|撲通|闪闪|閃閃|抱紧|抱緊|sparkle|flutter|sigh/i;
const COMIC_REACTION =
  /띠용|헉|앗|꺅|으악|에엑|짜잔|뿅|데굴|콰당|큼큼|흠흠|에헴|냠|우물|쩝|ズコ|ガーン|ギャ|えっ|ジャーン|こほん|モシャ|モグ|诶|欸|哇|登场|登場|锵锵|鏘鏘|ta-?da|oops|gasp|ahem|munch/i;
const AMBIENT_EERIE =
  /스산|오싹|으스스|소름|웅성|웅웅|고요|침묵|ゴゴ|ゾク|ザワ|シーン|ひゅ|沙沙|簌簌|阴森|陰森|寂静|寂靜|寒意|窃窃|竊竊|eerie|rumble|silence/i;

const STRONG_FONT_LABEL =
  /bold|black|heavy|impact|display|poster|gothic|굵|고딕|돋움|두꺼|강렬|太|黒|粗|黑|特粗|粗体|粗體/i;
const SHARP_FONT_LABEL =
  /italic|oblique|slant|brush|marker|callig|motion|speed|붓|필기|기울|斜|筆|行書|毛草|書法|书法/i;
const SOFT_FONT_LABEL =
  /hand|script|round|cute|soft|casual|kalam|gowoon|손글씨|동글|귀여|감성|可愛|かわい|丸|手書|手写|手寫|圆|圓|柔/i;
const COMIC_FONT_LABEL =
  /comic|cartoon|play|fun|pop|luck|freckle|jua|gaegu|개구|주아|만화|漫画|漫畫|卡通|コミック|kuaile|huninn/i;
const EERIE_FONT_LABEL =
  /serif|classic|mincho|batang|myeongjo|gungseo|cubic|dot|pixel|궁서|명조|바탕|고전|明朝|宋|楷|古|点阵|點陣|像素|도트/i;

const CUSTOM_SLOT_THRESHOLD: Readonly<Record<SoundSlot, number>> = {
  "strong-impact": 80,
  "sharp-motion": 80,
  "soft-emotion": 80,
  "comic-reaction": 80,
  "ambient-eerie": 80,
};

const BODY_FALLBACK_FONT_IDS: Readonly<Record<UiLocale, readonly string[]>> = {
  ko: [
    "nanum-barun-gothic",
    "ridi-batang",
    "nanum-myeongjo",
    "seoul-namsan",
    "seoul-hangang",
  ],
  en: ["comic-neue", "kalam", "permanent-marker", "freckle-face"],
  ja: ["yusei-magic", "hachi-maru-pop", "mochiy-pop-one", "dot-gothic-16"],
  "zh-Hans": [
    "zcool-xiaowei",
    "zcool-qingke-huangyou",
    "zcool-kuaile",
    "ma-shan-zheng",
  ],
  "zh-Hant": ["lxgw-wenkai-tc", "iansui", "huninn", "lxgw-marker-gothic"],
};

const SOUND_FALLBACK_FONT_IDS: Readonly<Record<UiLocale, readonly string[]>> = {
  ko: [
    "dohyeon",
    "jua",
    "cafe24-gowoonbam",
    "chosun-gungseo",
    "nanum-barun-gothic",
  ],
  en: [
    "bangers",
    "luckiest-guy",
    "permanent-marker",
    "freckle-face",
    "comic-neue",
    "kalam",
  ],
  ja: [
    "dela-gothic-one",
    "reggae-one",
    "mochiy-pop-one",
    "hachi-maru-pop",
    "dot-gothic-16",
    "yusei-magic",
  ],
  "zh-Hans": [
    "zcool-qingke-huangyou",
    "zcool-kuaile",
    "liu-jian-mao-cao",
    "long-cang",
    "zcool-xiaowei",
  ],
  "zh-Hant": [
    "lxgw-marker-gothic",
    "huninn",
    "chenyu-luoyan",
    "cubic-11",
    "iansui",
    "lxgw-wenkai-tc",
  ],
};

const WIDTH_CLASS_SCALE: Readonly<Record<number, number>> = {
  1: 0.5,
  2: 0.625,
  3: 0.75,
  4: 0.875,
  5: 1,
  6: 1.125,
  7: 1.25,
  8: 1.5,
  9: 2,
};

const CUSTOM_EVIDENCE_SCORERS: Readonly<
  Record<SoundSlot, (candidate: AutomaticFontCandidate) => number>
> = {
  "strong-impact": (candidate) =>
    booleanScore(STRONG_FONT_LABEL.test(candidate.label), 82) +
    resolveStrongWeightScore(candidate.weight) +
    booleanScore(candidate.width <= 4, 8),
  "sharp-motion": (candidate) =>
    booleanScore(SHARP_FONT_LABEL.test(candidate.label), 82) +
    booleanScore(candidate.italic, 64) +
    booleanScore(candidate.width <= 3, 18),
  "soft-emotion": (candidate) =>
    booleanScore(SOFT_FONT_LABEL.test(candidate.label), 82) +
    booleanScore(candidate.italic, 8) +
    booleanScore(candidate.weight <= 500, 5),
  "comic-reaction": (candidate) =>
    booleanScore(COMIC_FONT_LABEL.test(candidate.label), 82) +
    booleanScore(candidate.width >= 5, 5) +
    booleanScore(candidate.weight >= 600, 7),
  "ambient-eerie": (candidate) =>
    booleanScore(EERIE_FONT_LABEL.test(candidate.label), 82) +
    booleanScore(candidate.serif === true, 60) +
    booleanScore(candidate.weight <= 500, 12),
};

/**
 * Portable deterministic ranker. The output language chooses the built-in
 * catalog, while user fonts are admitted only when they cover the entire
 * translated string and expose clear evidence for the requested role.
 */
export function resolveAutomaticFontDecision({
  item,
  page,
  workTitle,
  targetLanguage,
  bodyTextCorpus,
  candidates = [],
}: {
  item: OverlayItem;
  page: MangaPage;
  workTitle?: string;
  targetLanguage?: string;
  bodyTextCorpus?: string;
  candidates?: readonly AutomaticFontCandidate[];
}): AutomaticFontDecision | undefined {
  const locale = resolveUiLocale(targetLanguage);
  if (!locale) return undefined;

  const profile = resolveWorkFontProfile(locale, workTitle);
  const slot = isSoundItem(item) ? resolveSoundSlot(item, page) : "body";
  const translatedText = stripRichTextMarkup(
    String(item.translatedText ?? item.ko ?? ""),
  ).trim();
  const coverageText =
    slot === "body" ? bodyTextCorpus?.trim() || translatedText : translatedText;
  const customFont = resolveCustomFontCandidate({
    candidates,
    locale,
    slot,
    translatedText: coverageText,
  });
  const builtInFont = resolveBuiltInFontCandidate({
    candidates,
    locale,
    profile,
    slot,
    translatedText: coverageText,
  });
  return buildFontDecision(
    customFont ?? builtInFont.candidate,
    customFont?.fontId ?? builtInFont.fontId,
    slot,
  );
}

function resolveCustomFontCandidate({
  candidates,
  locale,
  slot,
  translatedText,
}: {
  candidates: readonly AutomaticFontCandidate[];
  locale: UiLocale;
  slot: AutomaticFontSemanticSlot;
  translatedText: string;
}): AutomaticFontCandidate | undefined {
  if (!translatedText) return undefined;

  const ranked = candidates
    .filter(
      (candidate) =>
        candidate.source === "custom" &&
        (slot === "body"
          ? candidate.supportedLocales.includes(locale) &&
            fontCandidateSupportsBodyLocale(candidate, locale) &&
            fontCandidateSupportsText(candidate, translatedText)
          : fontCandidateSupportsText(candidate, translatedText)),
    )
    .map((candidate) => ({
      candidate,
      evidence: scoreCustomFontEvidence(candidate, slot),
    }))
    .filter(({ candidate, evidence }) =>
      slot === "body"
        ? isConservativeBodyDefault(candidate)
        : evidence >= CUSTOM_SLOT_THRESHOLD[slot],
    )
    .map(({ candidate, evidence }) => ({
      candidate,
      score: evidence + (candidate.favorite ? 3 : 0),
    }));

  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      normalizePreferenceRank(left.candidate.preferenceRank) -
        normalizePreferenceRank(right.candidate.preferenceRank) ||
      compareFontIds(left.candidate.fontId, right.candidate.fontId),
  );
  return ranked[0]?.candidate;
}

function resolveBuiltInFontCandidate({
  candidates,
  locale,
  profile,
  slot,
  translatedText,
}: {
  candidates: readonly AutomaticFontCandidate[];
  locale: UiLocale;
  profile: WorkFontProfile;
  slot: AutomaticFontSemanticSlot;
  translatedText: string;
}): { candidate?: AutomaticFontCandidate; fontId: string } {
  const preferred =
    slot === "body" ? profile.body : profile.sound[slot as SoundSlot];
  const builtIns = candidates.filter(
    (candidate) => candidate.source === "built-in",
  );
  // Tests and recovery paths may intentionally omit the bundled catalog.
  if (builtIns.length === 0) {
    return { fontId: preferred };
  }
  const orderedIds = uniqueFontIds([
    preferred,
    ...(slot === "body"
      ? BODY_FALLBACK_FONT_IDS[locale]
      : SOUND_FALLBACK_FONT_IDS[locale]),
    profile.body,
    ...BODY_FALLBACK_FONT_IDS[locale],
  ]);
  const byId = new Map(
    builtIns.map((candidate) => [candidate.fontId, candidate] as const),
  );
  const candidate = orderedIds
    .map((fontId) => byId.get(fontId))
    .find(
      (font): font is AutomaticFontCandidate =>
        Boolean(font) &&
        (slot === "body"
          ? fontCandidateSupportsBodyLocale(
              font as AutomaticFontCandidate,
              locale,
            ) &&
            fontCandidateSupportsText(
              font as AutomaticFontCandidate,
              translatedText,
            )
          : Boolean(translatedText) &&
            fontCandidateSupportsText(
              font as AutomaticFontCandidate,
              translatedText,
            )),
    );
  return { candidate, fontId: candidate?.fontId ?? preferred };
}

function buildFontDecision(
  candidate: AutomaticFontCandidate | undefined,
  fontId: string,
  slot: AutomaticFontSemanticSlot,
): AutomaticFontDecision {
  const fontMetricWidthScale = candidate
    ? WIDTH_CLASS_SCALE[Math.round(candidate.width)]
    : undefined;
  return {
    fontId,
    slot,
    ...(fontMetricWidthScale && fontMetricWidthScale !== 1
      ? { fontMetricWidthScale }
      : {}),
  };
}

function uniqueFontIds(fontIds: readonly string[]): string[] {
  return [...new Set(fontIds)];
}

function scoreCustomFontEvidence(
  candidate: AutomaticFontCandidate,
  slot: AutomaticFontSemanticSlot,
): number {
  return slot === "body"
    ? booleanScore(candidate.defaultFont, 100)
    : CUSTOM_EVIDENCE_SCORERS[slot](candidate);
}

function resolveStrongWeightScore(weight: number): number {
  if (weight >= 800) return 82;
  if (weight >= 700) return 52;
  return 0;
}

function booleanScore(condition: boolean, score: number): number {
  return condition ? score : 0;
}

function isConservativeBodyDefault(candidate: AutomaticFontCandidate): boolean {
  return (
    candidate.defaultFont &&
    !candidate.italic &&
    candidate.weight >= 300 &&
    candidate.weight <= 700 &&
    candidate.width >= 3 &&
    candidate.width <= 7
  );
}

function normalizePreferenceRank(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : Number.MAX_SAFE_INTEGER;
}

function compareFontIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function resolveSoundSlot(item: OverlayItem, page: MangaPage): SoundSlot {
  const text = `${item.sourceText ?? item.jp} ${item.translatedText ?? item.ko}`;
  return (
    resolveSemanticSoundSlot(text) ?? resolveGeometricSoundSlot(item, page)
  );
}

function resolveSemanticSoundSlot(text: string): SoundSlot | undefined {
  if (AMBIENT_EERIE.test(text)) return "ambient-eerie";
  if (SOFT_EMOTION.test(text)) return "soft-emotion";
  if (COMIC_REACTION.test(text)) return "comic-reaction";
  if (STRONG_IMPACT.test(text)) return "strong-impact";
  if (SHARP_MOTION.test(text)) return "sharp-motion";
  return undefined;
}

function resolveGeometricSoundSlot(
  item: OverlayItem,
  page: MangaPage,
): SoundSlot {
  const text = `${item.sourceText ?? item.jp} ${item.translatedText ?? item.ko}`;
  const blockWidthPx = (item.bbox.w / 1000) * page.width;
  const blockHeightPx = (item.bbox.h / 1000) * page.height;
  const blockAreaRatio = (item.bbox.w * item.bbox.h) / 1_000_000;
  if (
    (item.fontSize ?? 0) >= 36 ||
    blockAreaRatio >= 0.045 ||
    /[!?！？]{2,}/.test(text)
  ) {
    return "strong-impact";
  }
  if (Math.abs(item.angle ?? 0) >= 10 || blockHeightPx >= blockWidthPx * 1.8) {
    return "sharp-motion";
  }
  return "comic-reaction";
}

function isSoundItem(item: OverlayItem): boolean {
  return String(item.textRole ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "")
    .match(/^(sound|sfx|soundeffect|effect|reaction|onomatopoeia)$/)
    ? true
    : false;
}
