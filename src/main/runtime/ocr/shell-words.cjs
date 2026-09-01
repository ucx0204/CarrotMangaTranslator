// @ts-check

/** @typedef {{ current: string; quote: string; escaped: boolean }} ShellTokenState */

/** @param {unknown} value @returns {string[]} */
function splitShellLikeEnv(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  /** @type {string[]} */
  const parts = [];
  /** @type {ShellTokenState} */
  const state = { current: "", quote: "", escaped: false };
  for (const char of raw) {
    consumeShellCharacter(state, parts, char);
  }
  if (state.escaped) {
    state.current += "\\";
  }
  pushShellToken(state, parts);
  return parts;
}

/** @param {ShellTokenState} state @param {string[]} parts @param {string} char */
function consumeShellCharacter(state, parts, char) {
  if (state.escaped) {
    state.current += char;
    state.escaped = false;
    return;
  }
  if (char === "\\") {
    state.escaped = true;
    return;
  }
  if (state.quote) {
    consumeQuotedCharacter(state, char);
    return;
  }
  if (char === '"' || char === "'") {
    state.quote = char;
    return;
  }
  if (/\s/.test(char)) {
    pushShellToken(state, parts);
    return;
  }
  state.current += char;
}

/** @param {ShellTokenState} state @param {string} char */
function consumeQuotedCharacter(state, char) {
  if (char === state.quote) {
    state.quote = "";
  } else {
    state.current += char;
  }
}

/** @param {ShellTokenState} state @param {string[]} parts */
function pushShellToken(state, parts) {
  if (state.current) {
    parts.push(state.current);
    state.current = "";
  }
}

module.exports = { splitShellLikeEnv };
