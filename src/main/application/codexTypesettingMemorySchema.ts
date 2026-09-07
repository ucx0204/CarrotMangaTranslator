import { z } from "zod/v4";

export const codexPageMemorySchema = z
  .object({
    glossary: z
      .array(
        z
          .object({
            source: z.string().min(1).max(200),
            target: z.string().max(200),
            category: z.enum([
              "character",
              "alias",
              "place",
              "term",
              "honorific",
              "other",
            ]),
          })
          .strict(),
      )
      .max(20),
    characters: z
      .array(
        z
          .object({
            displayName: z.string().min(1).max(100),
            sourceNames: z.array(z.string().min(1).max(100)).min(1).max(10),
            targetName: z.string().min(1).max(100),
            speechStyle: z.enum([
              "neutral",
              "polite",
              "casual",
              "rough",
              "childish",
              "elderly",
              "formal",
              "custom",
            ]),
            customSpeechStyle: z.string().max(1000),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .optional();
