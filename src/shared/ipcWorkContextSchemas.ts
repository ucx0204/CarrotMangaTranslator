import { z } from "zod";
import {
  MAX_CHARACTER_PROFILES,
  MAX_GATHERED_TEXT_LENGTH,
  MAX_GLOSSARY_ENTRIES,
  MAX_ID_LIST_LENGTH,
  MAX_PAGES_PER_REQUEST,
  MAX_STORY_MEMORY_PAGES,
  storeId,
  title,
  uuid,
} from "./ipcSchemaPrimitives";

const GlossaryEntryCategorySchema = z.enum([
  "character",
  "alias",
  "place",
  "term",
  "sfx",
  "honorific",
  "other",
]);

const CharacterSpeechStyleSchema = z.enum([
  "neutral",
  "polite",
  "casual",
  "rough",
  "childish",
  "elderly",
  "formal",
  "custom",
]);

const DefaultToneSchema = z.preprocess(
  (value) => {
    if (value === "webtoon" || value === "formal") {
      return "natural_korean";
    }
    return value;
  },
  z.enum(["natural_korean", "literal"]),
);

export const WorkStyleGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    workId: storeId,
    glossary: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            source: z.string().min(1).max(400),
            target: z.string().max(400),
            category: GlossaryEntryCategorySchema,
            aliases: z.array(z.string().max(200)).max(50).optional(),
            note: z.string().max(2000).optional(),
            enabled: z.boolean(),
            createdAt: z.string().max(80),
            updatedAt: z.string().max(80),
          })
          .strict(),
      )
      .max(MAX_GLOSSARY_ENTRIES),
    characters: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            displayName: z.string().min(1).max(200),
            sourceNames: z.array(z.string().min(1).max(200)).max(50),
            targetName: z.string().max(200),
            aliases: z.array(z.string().max(200)).max(50).optional(),
            speechStyle: CharacterSpeechStyleSchema,
            customSpeechStyle: z.string().max(1000).optional(),
            note: z.string().max(2000).optional(),
            enabled: z.boolean(),
            createdAt: z.string().max(80),
            updatedAt: z.string().max(80),
          })
          .strict(),
      )
      .max(MAX_CHARACTER_PROFILES),
    rules: z
      .object({
        honorifics: z.enum(["preserve", "adapt", "drop"]),
        sfxMode: z.enum(["preserve", "translate", "note"]),
        defaultTone: DefaultToneSchema,
      })
      .strict(),
    createdAt: z.string().max(80),
    updatedAt: z.string().max(80),
  })
  .strict();

export const ChapterStoryMemorySchema = z
  .object({
    schemaVersion: z.literal(1),
    workId: storeId,
    chapterId: storeId,
    pages: z
      .array(
        z
          .object({
            pageId: storeId,
            pageName: z.string().max(260),
            pageIndex: z.number().int().min(0).max(MAX_PAGES_PER_REQUEST),
            sourceDigest: z.string().max(2000),
            translatedDigest: z.string().max(2000),
            summary: z.string().max(1200),
            characterIds: z.array(z.string().max(200)).max(100).optional(),
            updatedAt: z.string().max(80),
          })
          .strict(),
      )
      .max(MAX_STORY_MEMORY_PAGES),
    updatedAt: z.string().max(80),
    aiAnalyzedAt: z.string().max(80).optional(),
  })
  .strict();

export const WorkStyleGuideRequestSchema = z.object({ workId: uuid }).strict();

export const ChapterStoryMemoryRequestSchema = z
  .object({ chapterId: uuid })
  .strict();

export const AnalyzeWorkContextRequestSchema = z
  .object({
    chapterId: uuid,
    scope: z.enum(["chapter", "work", "missing"]).optional(),
    maxInputChars: z.number().int().min(4000).max(500000).optional(),
  })
  .strict();

export const ExportReviewTextRequestSchema = z
  .object({
    chapterId: uuid,
    format: z.enum(["csv", "tsv"]),
    includeBom: z.boolean().optional(),
  })
  .strict();

export const ImportReviewTextRequestSchema = z
  .object({
    chapterId: uuid,
    content: z.string().max(MAX_GATHERED_TEXT_LENGTH),
    format: z.enum(["csv", "tsv", "auto"]),
    updateSourceText: z.boolean().optional(),
    requireSourceMatch: z.boolean().optional(),
  })
  .strict();

export const SaveTextFileRequestSchema = z
  .object({
    defaultName: z.string().min(1).max(260),
    content: z.string().max(MAX_GATHERED_TEXT_LENGTH),
  })
  .strict();

export const WorkShareExportRequestSchema = z
  .object({
    workId: uuid,
    chapterIds: z.array(uuid).min(1).max(MAX_ID_LIST_LENGTH),
  })
  .strict();

export const WorkShareImportRequestSchema = z
  .object({
    previewId: uuid,
    target: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("new"), title }).strict(),
      z.object({ mode: z.literal("existing"), workId: uuid }).strict(),
    ]),
    entries: z
      .array(
        z.discriminatedUnion("source", [
          z
            .object({ source: z.literal("existing"), chapterId: uuid, title })
            .strict(),
          z
            .object({
              source: z.literal("package"),
              packageChapterId: z.string().min(1).max(200),
              title,
            })
            .strict(),
        ]),
      )
      .max(MAX_ID_LIST_LENGTH),
  })
  .strict();
