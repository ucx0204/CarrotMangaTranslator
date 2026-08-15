import { z } from "zod";
import {
  isValidWarpTransform,
  MAX_BLOCK_LOCAL_COORDINATE,
  MIN_BLOCK_LOCAL_COORDINATE,
  warpPointCount,
} from "./blockTransforms";

const WarpPointSchema = z
  .object({
    x: z
      .number()
      .finite()
      .min(MIN_BLOCK_LOCAL_COORDINATE)
      .max(MAX_BLOCK_LOCAL_COORDINATE),
    y: z
      .number()
      .finite()
      .min(MIN_BLOCK_LOCAL_COORDINATE)
      .max(MAX_BLOCK_LOCAL_COORDINATE),
  })
  .strict();

export const WarpTransformSchema = z
  .object({
    version: z.literal(1),
    gridSize: z.union([z.literal(3), z.literal(5)]),
    points: z.array(WarpPointSchema).min(16).max(36),
  })
  .strict()
  .superRefine((transform, context) => {
    if (transform.points.length !== warpPointCount(transform.gridSize)) {
      context.addIssue({
        code: "custom",
        message: "warp point count does not match its grid size",
        path: ["points"],
      });
      return;
    }
    if (!isValidWarpTransform(transform)) {
      context.addIssue({
        code: "custom",
        message: "invalid or unsafe warp transform",
      });
    }
  });
