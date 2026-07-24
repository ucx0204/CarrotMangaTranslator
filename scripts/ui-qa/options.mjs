import { join } from "node:path";

/**
 * @typedef {"stable" | "mac-alpha"} BuildChannel
 * @typedef {{
 *   buildChannel: BuildChannel;
 *   entry: string;
 *   height: number;
 *   keepProfile: boolean;
 *   output: string;
 *   serve: boolean;
 *   url: string | null;
 *   waitMs: number;
 *   width: number;
 * }} UiQaOptions
 */

/**
 * @param {string[]} args
 * @param {string} root
 * @returns {UiQaOptions}
 */
export function parseArgs(args, root) {
  /** @type {UiQaOptions} */
  const parsed = {
    buildChannel: "mac-alpha",
    entry: "index.html",
    height: 900,
    keepProfile: false,
    output: join(root, ".tmp", "ui-qa-capture.png"),
    serve: false,
    url: null,
    waitMs: 700,
    width: 1440,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--keep-profile") {
      parsed.keepProfile = true;
      continue;
    }
    if (arg === "--serve") {
      parsed.serve = true;
      continue;
    }
    const value = requireValue(args, ++index, arg);
    applyValuedOption(parsed, arg, value);
  }
  if (!parsed.serve && !parsed.url) {
    throw new Error("Pass --url <local URL> or --entry <renderer HTML entry>.");
  }
  return parsed;
}

/**
 * @param {UiQaOptions} parsed
 * @param {string} flag
 * @param {string} value
 */
function applyValuedOption(parsed, flag, value) {
  if (flag === "--build-channel") {
    parsed.buildChannel = parseBuildChannel(value);
  } else if (flag === "--entry") {
    parsed.entry = value;
    parsed.serve = true;
  } else if (flag === "--height") {
    parsed.height = positiveNumber(value, flag);
  } else if (flag === "--output") {
    parsed.output = value;
  } else if (flag === "--url") {
    parsed.url = value;
  } else if (flag === "--wait") {
    parsed.waitMs = nonNegativeNumber(value, flag);
  } else if (flag === "--width") {
    parsed.width = positiveNumber(value, flag);
  } else {
    throw new Error(`Unknown argument: ${flag}`);
  }
}

/**
 * @param {string[]} args
 * @param {number} index
 * @param {string} flag
 */
function requireValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

/** @param {string} value @returns {BuildChannel} */
function parseBuildChannel(value) {
  if (value === "stable" || value === "mac-alpha") return value;
  throw new Error("--build-channel must be either stable or mac-alpha.");
}

/** @param {string} value @param {string} flag */
function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number.`);
  }
  return Math.round(number);
}

/** @param {string} value @param {string} flag */
function nonNegativeNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${flag} must be zero or greater.`);
  }
  return Math.round(number);
}

function printHelp() {
  process.stdout.write(`Local Chromium UI QA\n\n`);
  process.stdout.write(
    `npm run qa:ui -- --entry qa.html --output C:\\tmp\\ui.png [options]\n`,
  );
  process.stdout.write(`npm run qa:ui -- --url http://127.0.0.1:5173/\n\n`);
  process.stdout.write(
    `  --build-channel   QA bridge channel (stable or mac-alpha)\n`,
  );
  process.stdout.write(
    `  --entry <file>     Start Vite and open this renderer entry\n`,
  );
  process.stdout.write(
    `  --serve            Start Vite with the default renderer entry\n`,
  );
  process.stdout.write(
    `  --url <url>        Open an already-running local page\n`,
  );
  process.stdout.write(
    `  --width/--height   Viewport size (1440x900 by default)\n`,
  );
  process.stdout.write(
    `  --wait <ms>        Time to wait after page load before capture\n`,
  );
  process.stdout.write(`  --output <file>    PNG path (defaults to .tmp)\n`);
  process.stdout.write(
    `  --keep-profile     Preserve the Chromium QA profile\n`,
  );
}
