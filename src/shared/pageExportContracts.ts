import { z } from "zod";
import {
  MAX_BLOCKS_PER_PAGE,
  TranslationBlockSchema,
} from "./ipcSchemaPrimitives";
import type { FontLibrarySnapshot, MangaPage } from "./libraryTypes";
import {
  MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS,
  MAX_PAGE_EXPORT_SIDE_PX,
  validatePageExportRasterSize,
  type PageExportRasterSize,
} from "./pageExportLimits";

export const PAGE_EXPORT_ASSET_DIRECTORY = "page-export";
export const PAGE_EXPORT_RUNTIME_FILE = "runtime.js";
export const PAGE_EXPORT_STYLES_FILE = "styles.css";

export type PageArtworkSnapshot = Pick<
  MangaPage,
  "id" | "name" | "width" | "height" | "blocks"
>;

export type PageExportDocumentData = {
  fontLibrary: FontLibrarySnapshot;
  imageSrc: string;
  outputSize: PageExportRasterSize;
  page: PageArtworkSnapshot;
};

const CustomFontSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(200),
    family: z.string().min(1).max(200),
    fileName: z.string().min(1).max(260),
  })
  .strict();

const FontPreferencesSchema = z
  .object({
    favoriteIds: z.array(z.string().min(1).max(200)).max(1000),
    orderedIds: z.array(z.string().min(1).max(200)).max(1000),
    defaultFontId: z.string().min(1).max(200),
  })
  .strict();

const PageExportRasterSizeSchema = z
  .object({
    width: z.number().int().min(1).max(MAX_PAGE_EXPORT_SIDE_PX),
    height: z.number().int().min(1).max(MAX_PAGE_EXPORT_SIDE_PX),
  })
  .strict()
  .superRefine((size, context) => {
    const result = validatePageExportRasterSize(size);
    if (!result.valid) {
      context.addIssue({
        code: "custom",
        message: "Page export raster exceeds the safety budget.",
      });
    }
  });

const PageArtworkSnapshotSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(260),
    width: z.number().int().min(1).max(100000),
    height: z.number().int().min(1).max(100000),
    blocks: z.array(TranslationBlockSchema).max(MAX_BLOCKS_PER_PAGE),
  })
  .strict();

export const PageExportDocumentDataSchema = z
  .object({
    fontLibrary: z
      .object({
        customFonts: z.array(CustomFontSchema).max(1000),
        preferences: FontPreferencesSchema,
      })
      .strict(),
    imageSrc: z
      .string()
      .min(1)
      .max(MAX_PAGE_EXPORT_IMAGE_SOURCE_CHARS)
      .refine(
        (value) =>
          value.startsWith("mgt-image://") ||
          value.startsWith("data:image/png;base64,") ||
          value.startsWith("data:image/jpeg;base64,") ||
          value.startsWith("data:image/webp;base64,"),
        "Unsupported page export image source.",
      ),
    outputSize: PageExportRasterSizeSchema,
    page: PageArtworkSnapshotSchema,
  })
  .strict();
