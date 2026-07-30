import type { AutomaticFontSemanticSlot } from "../../shared/fontMatchingTypes";
import type { UiLocale } from "../../shared/uiLocales";

type SoundSlot = Exclude<AutomaticFontSemanticSlot, "body">;
type WorkGenre = "neutral" | "romance" | "action" | "cozy";

export type WorkFontProfile = {
  body: string;
  sound: Readonly<Record<SoundSlot, string>>;
};

const WORK_FONT_PROFILES: Readonly<
  Record<UiLocale, Readonly<Record<WorkGenre, WorkFontProfile>>>
> = {
  ko: {
    neutral: koreanProfile("nanum-barun-gothic"),
    romance: koreanProfile("ridi-batang", "gaegu"),
    action: koreanProfile("nanum-barun-gothic", "jua", "griun-pol-sensibility"),
    cozy: {
      body: "seoul-namsan",
      sound: {
        "strong-impact": "jua",
        "sharp-motion": "gaegu",
        "soft-emotion": "cafe24-gowoonbam",
        "comic-reaction": "jua",
        "ambient-eerie": "mongtori",
      },
    },
  },
  en: {
    neutral: englishProfile("comic-neue"),
    romance: englishProfile("kalam"),
    action: englishProfile("comic-neue"),
    cozy: englishProfile("kalam"),
  },
  ja: {
    neutral: japaneseProfile("yusei-magic"),
    romance: japaneseProfile("hachi-maru-pop"),
    action: japaneseProfile("yusei-magic"),
    cozy: japaneseProfile("hachi-maru-pop"),
  },
  "zh-Hans": {
    neutral: simplifiedChineseProfile("zcool-xiaowei"),
    romance: simplifiedChineseProfile("zcool-xiaowei"),
    action: simplifiedChineseProfile("zcool-qingke-huangyou"),
    cozy: simplifiedChineseProfile("zcool-kuaile"),
  },
  "zh-Hant": {
    neutral: traditionalChineseProfile("lxgw-wenkai-tc"),
    romance: traditionalChineseProfile("iansui"),
    action: traditionalChineseProfile("lxgw-marker-gothic"),
    cozy: traditionalChineseProfile("huninn"),
  },
};

const ROMANCE_TITLE =
  /로맨|연애|사랑|결혼|약혼|악녀|영애|공작|후작|백작|황녀|왕자|令嬢|公爵|侯爵|王子|皇女|恋|愛|婚|恋爱|戀愛|爱情|愛情|公主|千金|恶女|惡女|romance|love|duke|prince|princess|villainess/i;
const ACTION_TITLE =
  /액션|헌터|던전|전쟁|전투|용사|마왕|기사|군대|무협|레벨|회귀|전생|戦|剣|勇者|魔王|騎士|軍|战|戰|剑|劍|骑士|騎士|猎人|獵人|地牢|战争|戰爭|等级|等級|battle|hunter|dungeon|war|level/i;
const COZY_TITLE =
  /일상|육아|요리|카페|힐링|코미디|개그|귀여|가족|슬라임|VRMMO|日常|育児|料理|喫茶|コメディ|ギャグ|家族|スライム|育儿|育兒|咖啡|治愈|治癒|喜剧|喜劇|搞笑|家庭|可爱|可愛|史莱姆|史萊姆|cozy|cafe|comedy|family|cute|slime|vrmmo/i;

export function resolveWorkFontProfile(
  locale: UiLocale,
  workTitle: string | undefined,
): WorkFontProfile {
  const profiles = WORK_FONT_PROFILES[locale];
  return profiles[resolveWorkGenre(workTitle)] ?? profiles.neutral;
}

function koreanProfile(
  body: string,
  comicReaction = "jua",
  ambientEerie = "chosun-gungseo",
): WorkFontProfile {
  return {
    body,
    sound: {
      "strong-impact": "dohyeon",
      "sharp-motion": "start-over",
      "soft-emotion": "cafe24-gowoonbam",
      "comic-reaction": comicReaction,
      "ambient-eerie": ambientEerie,
    },
  };
}

function englishProfile(body: string): WorkFontProfile {
  return {
    body,
    sound: {
      "strong-impact": "bangers",
      "sharp-motion": "permanent-marker",
      "soft-emotion": "kalam",
      "comic-reaction": "luckiest-guy",
      "ambient-eerie": "permanent-marker",
    },
  };
}

function japaneseProfile(body: string): WorkFontProfile {
  return {
    body,
    sound: {
      "strong-impact": "dela-gothic-one",
      "sharp-motion": "reggae-one",
      "soft-emotion": "hachi-maru-pop",
      "comic-reaction": "mochiy-pop-one",
      "ambient-eerie": "dot-gothic-16",
    },
  };
}

function simplifiedChineseProfile(body: string): WorkFontProfile {
  return {
    body,
    sound: {
      "strong-impact": "zcool-qingke-huangyou",
      "sharp-motion": "liu-jian-mao-cao",
      "soft-emotion": "zcool-xiaowei",
      "comic-reaction": "zcool-kuaile",
      "ambient-eerie": "long-cang",
    },
  };
}

function traditionalChineseProfile(body: string): WorkFontProfile {
  return {
    body,
    sound: {
      "strong-impact": "lxgw-marker-gothic",
      "sharp-motion": "chenyu-luoyan",
      "soft-emotion": "iansui",
      "comic-reaction": "huninn",
      "ambient-eerie": "cubic-11",
    },
  };
}

function resolveWorkGenre(workTitle: string | undefined): WorkGenre {
  const title = String(workTitle ?? "").trim();
  if (!title) return "neutral";
  const matches: Array<{
    genre: Exclude<WorkGenre, "neutral">;
    score: number;
  }> = [
    { genre: "romance", score: countMatches(title, ROMANCE_TITLE) },
    { genre: "action", score: countMatches(title, ACTION_TITLE) },
    { genre: "cozy", score: countMatches(title, COZY_TITLE) },
  ];
  matches.sort((left, right) => right.score - left.score);
  return matches[0].score > 0 && (matches[1]?.score ?? 0) < matches[0].score
    ? matches[0].genre
    : "neutral";
}

function countMatches(value: string, pattern: RegExp): number {
  const matchPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  return value.match(matchPattern)?.length ?? 0;
}
