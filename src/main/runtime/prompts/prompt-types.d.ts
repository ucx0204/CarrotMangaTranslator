export type PromptBbox = {
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
};

export type PreviousPromptBlock = {
  previousId?: unknown;
  index?: unknown;
  candidateId?: unknown;
  bbox?: PromptBbox;
  textRole?: unknown;
  sourceText?: unknown;
  translatedText?: unknown;
  confidence?: unknown;
};

export type PromptOptions = {
  modelProvider?: string;
  sourceLanguage?: unknown;
  targetLanguage?: unknown;
  modelRepo?: unknown;
  modelFile?: unknown;
  localModelPath?: unknown;
  regionCropMode?: unknown;
  strictRefineMode?: unknown;
  keepBlocksMode?: unknown;
  collectPageContext?: unknown;
  cumulativeContextDetail?: unknown;
  autoFontMatching?: unknown;
  previousBlocksForPrompt?: PreviousPromptBlock[];
  workContext?: PromptWorkContext | null;
  glossaryOmissionTerms?: unknown[];
  imageWidth?: unknown;
  imageHeight?: unknown;
  ocrPipeline?: unknown;
  ocrBboxHints?: OcrHint[];
  [key: string]: unknown;
};

export type ImageVariant = {
  role?: string;
  width?: unknown;
  height?: unknown;
  [key: string]: unknown;
};

export type PromptSection = string[];

export type PromptWorkContext = {
  styleGuide?: PromptStyleGuide | null;
  storyMemory?: { pages?: PromptStoryPage[] } | null;
};

export type PromptStyleGuide = {
  glossary?: PromptGlossaryEntry[];
  characters?: PromptCharacterEntry[];
  rules?: PromptRules;
};

export type PromptGlossaryEntry = {
  enabled?: boolean;
  aliases?: unknown[];
  note?: unknown;
  category?: unknown;
  source?: unknown;
  target?: unknown;
};

export type PromptCharacterEntry = {
  enabled?: boolean;
  sourceNames?: unknown[];
  speechStyle?: unknown;
  customSpeechStyle?: unknown;
  displayName?: unknown;
  targetName?: unknown;
};

export type PromptRules = {
  honorifics?: unknown;
  sfxMode?: unknown;
  defaultTone?: unknown;
};

export type PromptStoryPage = {
  pageIndex?: unknown;
  pageName?: unknown;
  summary?: unknown;
  visualSummary?: unknown;
  translatedDigest?: unknown;
};

export type OcrHint = {
  id?: unknown;
  label?: unknown;
  x1?: unknown;
  y1?: unknown;
  x2?: unknown;
  y2?: unknown;
  score?: unknown;
  groupId?: unknown;
  orderInGroup?: unknown;
  rolePrior?: unknown;
  containerType?: unknown;
  geometryLocked?: unknown;
  [key: string]: unknown;
};

export type OcrHintGroup = {
  groupId: string;
  rolePrior: string;
  containerType: string;
  hints: OcrHint[];
};

export type PromptBox = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type PromptCoordinateFrame = {
  space: "pixels" | "normalized_1000";
  frame: { width: number; height: number };
};
