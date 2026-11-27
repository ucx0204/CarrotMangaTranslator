// Dedicated child for the pinned stable-diffusion.cpp C API. The parent
// watches this PID and can release the device even during a blocking C call.
const fs = require("node:fs");
const { dirname } = require("node:path");
const { createInterface } = require("node:readline");
const koffi = require(process.env.CARROT_QWEN_KOFFI || "koffi");
const { PNG } = require(process.env.CARROT_QWEN_PNG || "pngjs");
/** @typedef {Record<string, string | boolean | number>} Options */
/** @typedef {{width:number, height:number}} Size */
/** @typedef {{path:string, multiplier:number, is_high_noise:boolean}} Lora */
/** @typedef {ReturnType<typeof bindLibrary>} Api */
/** @param {string} path */
function bindLibrary(path) {
  process.chdir(dirname(path));
  const lib = koffi.load(path);
  koffi.struct("sd_lora_t", {
    is_high_noise: "bool",
    multiplier: "float",
    path: "str",
  });
  return Object.fromEntries(
    [
      "void *sd_ctx_opt_create()",
      "void *sd_img_gen_opt_create()",
      "void sd_opt_free(void *)",
      "const char *sd_get_last_error()",
      "int sd_opt_set_bool(void *, const char *, bool)",
      "int sd_opt_set_string(void *, const char *, const char *)",
      "int sd_opt_set_int(void *, const char *, int64_t)",
      "int sd_opt_set_float(void *, const char *, double)",
      "int sd_opt_set_tensors(void *, const char *, void **, size_t)",
      "int sd_opt_set_loras(void *, const char *, sd_lora_t *, size_t)",
      "int sd_ctx_create(void *, _Out_ void **)",
      "void sd_ctx_free(void *)",
      "void *sd_tensor_create(int, size_t, int64_t *, void *, size_t)",
      "void sd_tensor_free(void *)",
      "int64_t sd_tensor_dim(void *, size_t)",
      "size_t sd_tensor_byte_size(void *)",
      "void *sd_tensor_data(void *)",
      "int sd_generate_image(void *, void *, _Out_ void **)",
      "void *sd_result_get_image(void *, size_t)",
      "void sd_result_free(void *)",
    ].map((signature) => {
      const name = signature.slice(
        signature.indexOf("sd_") + 3,
        signature.indexOf("("),
      );
      return [name, lib.func(signature)];
    }),
  );
}

/** @param {Api} api @param {number} status */
function check(api, status) {
  if (status !== 0) {
    const detail = api.get_last_error();
    throw new Error(
      status === 6
        ? `Out of memory: ${detail}`
        : detail || `sd status ${status}`,
    );
  }
}

/** @template T
 * @param {Api} api
 * @param {() => unknown} create
 * @param {Options} fields
 * @param {(options: unknown) => T} operation
 */
function withOptions(api, create, fields, operation) {
  const options = create();
  if (!options) throw new Error("Could not allocate Qwen options");
  try {
    for (const [key, value] of Object.entries(fields)) {
      const set =
        typeof value === "string"
          ? api.opt_set_string
          : typeof value === "boolean"
            ? api.opt_set_bool
            : key === "sample.guidance.txt_cfg"
              ? api.opt_set_float
              : api.opt_set_int;
      check(api, set(options, key, value));
    }
    return operation(options);
  } finally {
    api.opt_free(options);
  }
}

/** @param {Api} api @param {Options} fields */
function loadModel(api, fields) {
  return withOptions(api, api.ctx_opt_create, fields, (options) => {
    const result = [null];
    check(api, api.ctx_create(options, result));
    return result[0];
  });
}

/** @param {Api} api @param {string} path */
function referenceTensor(api, path) {
  const { width, height, data } = PNG.sync.read(fs.readFileSync(path));
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let p = 0, i = 0; i < rgb.length; p += 4, i += 3) {
    rgb[i] = data[p];
    rgb[i + 1] = data[p + 1];
    rgb[i + 2] = data[p + 2];
  }
  const tensor = api.tensor_create(1, 3, [3, width, height], rgb, rgb.length);
  if (!tensor)
    throw new Error(api.get_last_error() || "Invalid Qwen reference image");
  return tensor;
}

/** @param {Api} api @param {unknown} result @param {Size} size @param {string} output */
function writeResult(api, result, { width, height }, output) {
  const tensor = api.result_get_image(result, 0);
  const channels = tensor ? Number(api.tensor_dim(tensor, 0)) : 0;
  if (
    (channels !== 3 && channels !== 4) ||
    Number(api.tensor_dim(tensor, 1)) !== width ||
    Number(api.tensor_dim(tensor, 2)) !== height ||
    Number(api.tensor_byte_size(tensor)) !== width * height * channels
  )
    throw new Error(
      `Invalid Qwen output dimensions: expected ${width}x${height} RGB, received ${tensor ? [0, 1, 2].map((axis) => api.tensor_dim(tensor, axis)).join("x") : "no image"}`,
    );
  const data = Buffer.from(
    koffi.decode(api.tensor_data(tensor), "uint8_t", width * height * channels),
  );
  fs.writeFileSync(
    output,
    PNG.sync.write(
      { width, height, data },
      {
        colorType: channels === 4 ? 6 : 2,
        inputColorType: channels === 4 ? 6 : 2,
        inputHasAlpha: channels === 4,
      },
    ),
  );
}

/** @param {Api} api @param {unknown} context
 * @param {{generation:Options & Size, references:string[], lora?:Lora, output:string}} config
 */
function generate(api, context, { generation, references, lora, output }) {
  withOptions(api, api.img_gen_opt_create, generation, (options) => {
    const inputs = [];
    try {
      for (const path of references) inputs.push(referenceTensor(api, path));
      check(
        api,
        api.opt_set_tensors(options, "ref_images", inputs, inputs.length),
      );
    } finally {
      for (const input of inputs) api.tensor_free(input);
    }
    if (lora) check(api, api.opt_set_loras(options, "loras", [lora], 1));
    const result = [null];
    check(api, api.generate_image(context, options, result));
    try {
      writeResult(api, result[0], generation, output);
    } finally {
      api.result_free(result[0]);
    }
  });
}

/** @param {Api} api @param {AsyncIterable<string> | Iterable<string>} lines
 * @param {(response:{id:string, ok:boolean, error?:string})=>void} reply */
async function runNativeSession(api, lines, reply) {
  let context;
  try {
    for await (const line of lines) {
      const request = JSON.parse(line);
      if (request.type === "shutdown") break;
      try {
        const config = JSON.parse(fs.readFileSync(request.config, "utf8"));
        context ??= loadModel(api, config.context);
        generate(api, context, config);
        reply({ id: request.id, ok: true });
      } catch (error) {
        reply({ id: request.id, ok: false, error: String(error) });
        break;
      }
    }
  } finally {
    if (context) api.ctx_free(context);
  }
}

module.exports = { runNativeSession };
if (require.main === module) {
  const library = process.env.CARROT_QWEN_NATIVE_LIBRARY;
  if (!library) throw new Error("Missing Qwen native runtime library");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  runNativeSession(bindLibrary(library), lines, (response) => {
    process.stdout.write("\n" + JSON.stringify(response) + "\n");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
