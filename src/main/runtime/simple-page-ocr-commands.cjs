const path = require("node:path");

const {
  quoteCommandArg,
  renderCommandTemplate
} = require("./simple-page-shell-utils.cjs");
const {
  resolveBootstrapPython,
  resolveOcrDevice
} = require("./simple-page-ocr-runtime-config.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");

function buildOcrBboxCommand(options = {}, provider, outputPath, runtime = null) {
  const template = String(options.ocrBboxCommand ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_CMD", options) ?? "").trim();
  const image = options.imagePath;
  const replacements = {
    image: quoteCommandArg(image),
    output: quoteCommandArg(outputPath)
  };

  if (template) {
    return renderCommandTemplate(template, replacements);
  }

  if (provider === "paddleocr-vl") {
    const python = quoteCommandArg(resolveOcrRuntimePythonPath(runtime, options));
    const scriptPath = quoteCommandArg(path.join(__dirname, "paddleocr-vl-bboxes.py"));
    return `${python} -u ${scriptPath} --image ${quoteCommandArg(image)} --output ${quoteCommandArg(outputPath)} --device ${quoteCommandArg(resolveOcrDevice(options))}`;
  }

  throw new Error("OCR bbox provider requires MANGA_TRANSLATOR_OCR_BBOX_CMD.");
}

function buildOcrBboxBatchCommand(options = {}, batchPath, runtime = null, progressPath = null) {
  const python = quoteCommandArg(resolveOcrRuntimePythonPath(runtime, options));
  const scriptPath = quoteCommandArg(path.join(__dirname, "paddleocr-vl-bboxes.py"));
  const progressArg = progressPath ? ` --progress ${quoteCommandArg(progressPath)}` : "";
  return `${python} -u ${scriptPath} --batch ${quoteCommandArg(batchPath)}${progressArg} --device ${quoteCommandArg(resolveOcrDevice(options))}`;
}

function resolveOcrRuntimePythonPath(runtime = null, options = {}) {
  if (runtime?.pythonPath) {
    return runtime.pythonPath;
  }
  const pythonPath = resolveBootstrapPython(options);
  if (pythonPath) {
    return pythonPath;
  }
  throw new Error("PaddleOCR-VL bbox provider needs an isolated Python runtime.");
}

module.exports = {
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
  resolveOcrRuntimePythonPath
};
