import { describe, expect, it } from "vitest";
const { assertPortableKoharuPtx, koharuCudaBuildEnv } =
  require("../scripts/prepare-koharu-cuda-runner.cjs") as {
    assertPortableKoharuPtx: (binary: Buffer) => void;
    koharuCudaBuildEnv: (
      root: string,
      env: NodeJS.ProcessEnv,
    ) => NodeJS.ProcessEnv;
  };
describe("portable Koharu CUDA build", () => {
  it.each(["75", "86", "89", "120"])(
    "does not inherit build-host target %s",
    (hostTarget) => {
      const env = koharuCudaBuildEnv("C:/build", {
        CUDA_COMPUTE_CAP: hostTarget,
        USERPROFILE: "C:/user",
        KEEP_ME: "yes",
      });
      expect(env.CUDA_COMPUTE_CAP).toBe("75");
      expect(env.CARGO_ENCODED_RUSTFLAGS).toContain(
        "--remap-path-prefix=C:/build=/src",
      );
      expect(env.KEEP_ME).toBe("yes");
      expect(env.CARGO_TARGET_DIR).toMatch(/koharu-sm75$/);
      expect(env.CARGO_ENCODED_RUSTFLAGS).toContain(
        "--remap-path-prefix=C:/user=/user",
      );
    },
  );
  it("accepts the portable target even with multiple PTX modules", () => {
    expect(() =>
      assertPortableKoharuPtx(Buffer.from(".target sm_75\n.target sm_75")),
    ).not.toThrow();
  });
  it.each([
    "",
    ".target sm_89",
    ".target sm_120",
    ".target sm_75a",
    ".target sm_75\n.target sm_89",
  ])("rejects nonportable or missing PTX: %s", (value) => {
    expect(() => assertPortableKoharuPtx(Buffer.from(value))).toThrow(
      "portable sm_75 PTX",
    );
  });
});
