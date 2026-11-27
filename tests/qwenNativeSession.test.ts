import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
const { runNativeSession } =
  require("../src/main/runtime/qwen-native-session.cjs") as {
    runNativeSession(
      api: Record<string, unknown>,
      lines: string[],
      reply: (response: { id: string; ok: boolean; error?: string }) => void,
    ): Promise<void>;
  };

it("reuses the native context and copies RGB and RGBA before freeing each result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qwen-native-pixels-"));
  const rgba = Buffer.from([1, 2, 3, 123]);
  const reference = new PNG({ width: 1, height: 1 });
  reference.data.set(rgba);
  const input = join(dir, "reference.png");
  const result = { data: rgba };
  const api = {
    ctx_opt_create: () => ({}),
    img_gen_opt_create: () => ({}),
    opt_set_bool: () => 0,
    opt_set_int: () => 0,
    opt_set_float: () => 0,
    opt_set_string: () => 0,
    opt_set_loras: () => 0,
    opt_free: vi.fn(),
    ctx_create: vi.fn((_opts, handle) => {
      handle[0] = {};
      return 0;
    }),
    ctx_free: vi.fn(),
    tensor_create: vi.fn((_type, _rank, _dimensions, rgb: Buffer) => {
      expect(rgb).toEqual(rgba.subarray(0, 3));
      return {};
    }),
    tensor_free: vi.fn(),
    opt_set_tensors: () => 0,
    generate_image: vi.fn((_ctx, _opts, handle) => {
      handle[0] = result;
      return 0;
    }),
    result_get_image: () => result,
    tensor_dim: (_tensor: unknown, axis: number) =>
      axis === 0 ? result.data.length : 1,
    tensor_data: () => result.data,
    tensor_byte_size: () => result.data.length,
    result_free: vi.fn(),
  };
  const lines = [];
  const replies: boolean[] = [];
  try {
    await writeFile(input, PNG.sync.write(reference));
    for (const id of ["rgba", "rgb", "invalid"]) {
      const config = join(dir, id + ".json");
      await writeFile(
        config,
        JSON.stringify({
          context: { enable_mmap: true },
          generation: {
            width: id === "invalid" ? 2 : 1,
            height: 1,
            prompt: "restore",
            "sample.guidance.txt_cfg": 2.5,
          },
          references: [input, input],
          lora: { path: "adapter", multiplier: 0.65, is_high_noise: false },
          output: join(dir, id + ".png"),
        }),
      );
      lines.push(JSON.stringify({ id, config }));
    }
    await runNativeSession(api, lines, (response) => {
      replies.push(response.ok);
      if (response.id === "rgba") result.data = rgba.subarray(0, 3);
      if (response.id === "invalid")
        expect(response.error).toMatch(/dimensions/);
    });
    expect(replies).toEqual([true, true, false]);
    expect(PNG.sync.read(await readFile(join(dir, "rgba.png"))).data).toEqual(
      rgba,
    );
    expect(PNG.sync.read(await readFile(join(dir, "rgb.png"))).data).toEqual(
      Buffer.from([1, 2, 3, 255]),
    );
    expect(api.ctx_create).toHaveBeenCalledTimes(1);
    expect(api.ctx_free).toHaveBeenCalledTimes(1);
    expect(api.result_free).toHaveBeenCalledTimes(3);
    expect(api.tensor_free).toHaveBeenCalledTimes(6);
    expect(api.opt_free).toHaveBeenCalledTimes(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
