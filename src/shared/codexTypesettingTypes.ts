import type { CharacterProfile, GlossaryEntry } from "./workContextTypes";
import type { BBox, Point } from "./textTypes";
import type { RegionEditProtection } from "./regionEditProtectionTypes";

type CodexFontPreset = {
  id: string;
  name: string;
  fonts: Array<{ fontId: string; purpose: string }>;
};

export type CodexSfxRendering = "image" | "font";

export type CodexTypesettingOptions = {
  version: 1;
  eraseOriginal?: boolean;
  regionOutput?: "text" | "image";
  preset: CodexFontPreset;
  /** Missing in older saved requests; defaults to generated SFX. */
  sfxRendering?: CodexSfxRendering;
};

export type CodexTypesettingPreferences = {
  eraseOriginal?: boolean;
  enabled: boolean;
  selectedPresetId: string;
  presets: CodexFontPreset[];
  sfxRendering?: CodexSfxRendering;
};

/** Chapter-wide family assignment; weight and treatment remain per-region. */
export type CodexSourceFontGroup = {
  id: string;
  description: string;
  members: Array<{ regionId: string; bold: boolean; italic: boolean }>;
};

export type CodexPageRegion = {
  /** Planning/review metadata; never an output-layer clipping mask. */
  parentRegionId?: string;
  styleGroupId?: string;
  styleDescription?: string;
  /** Set only after explicit user confirmation; later model output cannot replace it. */
  translationLocked?: boolean;
  /** Foreground objects over the source SFX, in full-page normalized coordinates. */
  occlusionPolygons?: Point[][];
  id: string;
  action: "keep" | "text" | "image";
  sourceText: string;
  translatedText: string;
  sourceBbox: BBox;
  /** Separate glyph envelopes, normalized within the tight source crop. */
  erasePolygons?: Point[][];
  renderBbox: BBox;
  role: "ordinary" | "sound";
  direction: "horizontal" | "vertical";
  background: "white" | "black" | "artwork";
  reason: string;
  /** Localized unreadable source: protected keep content, saved for review. */
  preserveReason?: string;
};

type CodexPageMemory = {
  glossary: Array<
    Pick<GlossaryEntry, "source" | "target"> & {
      category: Exclude<GlossaryEntry["category"], "sfx">;
    }
  >;
  characters: Array<
    Pick<
      CharacterProfile,
      | "displayName"
      | "sourceNames"
      | "targetName"
      | "speechStyle"
      | "customSpeechStyle"
    >
  >;
};

export type CodexPageReading = {
  /** User-approved exclusions in this page's coordinates, shared by every region. */
  editProtection?: RegionEditProtection;
  memory?: CodexPageMemory;
  summary: string;
  regions: CodexPageRegion[];
};
