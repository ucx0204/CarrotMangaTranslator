import type {
  FontMatchingPaletteRole,
  FontMatchingSemanticRole,
  FontMatchRolePredictionV2,
  RankedFontCandidateV2,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { UiLocale } from "../../shared/uiLocales";

/**
 * Weak semantic priors for shadow-mode ranking and explicit profile choices.
 * They are neither training truth nor sufficient evidence for auto-apply.
 */
const KOREAN_ROLE_PRIORS: Readonly<
  Partial<Record<FontMatchingSemanticRole, readonly string[]>>
> = {
  whisper: ["cafe24-gowoonbam", "gaegu", "griun-pol-sensibility"],
  aside_balloon_edge: ["gaegu", "cafe24-gowoonbam", "griun-pol-sensibility"],
  emphasis_dialogue: ["jua", "dohyeon", "start-over", "nanum-gothic"],
  shout: ["dohyeon", "jua", "start-over", "nanum-gothic"],
  sfx_impact: ["dohyeon", "start-over", "jua", "mongtori"],
  sfx_motion: ["griun-pol-sensibility", "gaegu", "start-over", "dohyeon"],
  sfx_ambient: [
    "chosun-gungseo",
    "mongtori",
    "griun-pol-sensibility",
    "seoul-hangang",
  ],
  sfx_emotion: ["cafe24-gowoonbam", "gaegu", "jua", "mongtori"],
  sfx_comic: ["jua", "gaegu", "start-over", "dohyeon"],
  sign_ui_title: ["dohyeon", "nanum-gothic", "jua", "nanum-barun-gothic"],
};

export function rankFontMatchingV2Candidates({
  candidates,
  locale,
  profile,
  role,
  userDefaultFontId,
}: {
  candidates: readonly AutomaticFontCandidate[];
  locale: UiLocale;
  profile: WorkTypographyProfileV2 | null;
  role: FontMatchRolePredictionV2;
  userDefaultFontId?: string;
}): RankedFontCandidateV2[] {
  const rolePriors = locale === "ko" ? KOREAN_ROLE_PRIORS[role.primary] : [];
  const scored = candidates.map((candidate) => {
    const roleFit = resolveRoleFit(candidate, rolePriors ?? []);
    const styleFit = resolveMetadataStyleFit(candidate, role.primary);
    const workProfileFit = resolveWorkProfileFit(
      candidate.fontId,
      profile,
      role.primary,
    );
    const userPreferenceFit = resolveUserPreferenceFit(
      candidate,
      userDefaultFontId,
    );
    const totalScore =
      roleFit * 0.58 +
      styleFit * 0.12 +
      workProfileFit * 0.2 +
      userPreferenceFit * 0.1;
    return {
      candidate,
      roleFit,
      styleFit,
      workProfileFit,
      userPreferenceFit,
      totalScore,
    };
  });
  scored.sort(
    (left, right) =>
      right.totalScore - left.totalScore ||
      left.candidate.preferenceRank - right.candidate.preferenceRank ||
      compareStrings(left.candidate.fontId, right.candidate.fontId),
  );
  return scored.map((entry, index) =>
    buildRankedCandidate(entry, index, role, rolePriors ?? []),
  );
}

function buildRankedCandidate(
  entry: {
    candidate: AutomaticFontCandidate;
    roleFit: number;
    styleFit: number;
    workProfileFit: number;
    userPreferenceFit: number;
    totalScore: number;
  },
  index: number,
  role: FontMatchRolePredictionV2,
  rolePriors: readonly string[],
): RankedFontCandidateV2 {
  return {
    rank: index + 1,
    fontId: entry.candidate.fontId,
    renderStatus: "rendered",
    unrenderableReason: null,
    styleFit: entry.styleFit,
    roleFit: entry.roleFit,
    layoutFit: null,
    glyphCoverage: null,
    workProfileFit: entry.workProfileFit,
    userPreferenceFit: entry.userPreferenceFit,
    genrePriorContribution: 0,
    switchPenalty: 0,
    totalScore: entry.totalScore,
    confidence: resolveCandidateConfidence(
      entry.candidate,
      role,
      index,
      rolePriors.length > 0,
    ),
    reasonCodes: buildCandidateReasonCodes(entry.candidate, {
      rolePrior: rolePriors.includes(entry.candidate.fontId),
      workProfile: entry.workProfileFit > 0,
      userPreference: entry.userPreferenceFit > 0,
    }),
  };
}

function resolveRoleFit(
  candidate: AutomaticFontCandidate,
  preferredIds: readonly string[],
): number {
  const index = preferredIds.indexOf(candidate.fontId);
  if (index < 0) return 0.16;
  return Math.max(0.62, 0.94 - index * 0.09);
}

function resolveMetadataStyleFit(
  candidate: AutomaticFontCandidate,
  role: FontMatchingSemanticRole,
): number {
  const normalizedWeight = clampProbability((candidate.weight - 100) / 800);
  const normalizedWidth = clampProbability((candidate.width - 1) / 8);
  if (role === "narration" || role === "thought") {
    return clampScore((candidate.serif ? 0.72 : 0.28) - normalizedWeight * 0.1);
  }
  if (role === "whisper" || role === "sfx_emotion") {
    return clampScore(0.72 - normalizedWeight * 0.42);
  }
  if (
    role === "shout" ||
    role === "emphasis_dialogue" ||
    role === "sfx_impact"
  ) {
    return clampScore(0.3 + normalizedWeight * 0.62);
  }
  if (role === "sfx_motion") {
    return clampScore(
      0.28 + (candidate.italic ? 0.42 : 0) + (1 - normalizedWidth) * 0.22,
    );
  }
  return 0.5;
}

function resolveWorkProfileFit(
  fontId: string,
  profile: WorkTypographyProfileV2 | null,
  role: FontMatchingSemanticRole,
): number {
  if (!profile) return 0;
  const anchor = resolveRoleAnchor(profile, role);
  if (anchor) {
    if (anchor.primaryFontId === fontId) return 1;
    return anchor.allowedFontIds.includes(fontId) ? 0.72 : -0.4;
  }
  const palette = profile.rolePalettes.find(
    (entry) => entry.role === (role as FontMatchingPaletteRole),
  );
  if (!palette) return 0;
  const index = palette.allowedFontIds.indexOf(fontId);
  return index < 0 ? -0.4 : Math.max(0.64, 0.94 - index * 0.08);
}

function resolveRoleAnchor(
  profile: WorkTypographyProfileV2,
  role: FontMatchingSemanticRole,
) {
  if (role === "dialogue") return profile.dialogueAnchor;
  if (role === "narration") return profile.narrationAnchor;
  return role === "thought" ? profile.thoughtAnchor : null;
}

function resolveUserPreferenceFit(
  candidate: AutomaticFontCandidate,
  userDefaultFontId?: string,
): number {
  if (candidate.fontId === userDefaultFontId) return 1;
  if (candidate.defaultFont) return 0.82;
  if (candidate.favorite) return 0.45;
  return Math.max(0, 0.2 - candidate.preferenceRank * 0.01);
}

function resolveCandidateConfidence(
  candidate: AutomaticFontCandidate,
  role: FontMatchRolePredictionV2,
  rankIndex: number,
  hasRolePrior: boolean,
): number {
  if (!hasRolePrior || candidate.source === "custom") {
    return Math.min(0.74, role.confidence);
  }
  return clampProbability(role.confidence - rankIndex * 0.035);
}

function buildCandidateReasonCodes(
  candidate: AutomaticFontCandidate,
  evidence: {
    rolePrior: boolean;
    workProfile: boolean;
    userPreference: boolean;
  },
): string[] {
  return [
    "semantic_bootstrap_v2",
    ...(evidence.rolePrior ? ["role_prior"] : []),
    ...(evidence.workProfile ? ["work_profile_fit"] : []),
    ...(evidence.userPreference ? ["user_preference"] : []),
    ...(candidate.source === "custom" ? ["custom_font_unverified"] : []),
  ];
}

function clampProbability(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function clampScore(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
