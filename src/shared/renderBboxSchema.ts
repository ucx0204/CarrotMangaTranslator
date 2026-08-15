import { z } from "zod";
import {
  MAX_RENDER_BBOX_COORDINATE,
  MAX_RENDER_BBOX_SIZE,
  MIN_RENDER_BBOX_COORDINATE,
  clampRenderBbox,
} from "./renderBbox";

export const RenderBBoxSchema = z
  .object({
    x: z
      .number()
      .finite()
      .min(MIN_RENDER_BBOX_COORDINATE)
      .max(MAX_RENDER_BBOX_COORDINATE),
    y: z
      .number()
      .finite()
      .min(MIN_RENDER_BBOX_COORDINATE)
      .max(MAX_RENDER_BBOX_COORDINATE),
    w: z.number().finite().min(1).max(MAX_RENDER_BBOX_SIZE),
    h: z.number().finite().min(1).max(MAX_RENDER_BBOX_SIZE),
  })
  .strict()
  .transform(clampRenderBbox);
