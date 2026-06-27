/**
 * Normalizes a keyboard event into a canonical combo string used by the
 * shortcut registry, e.g. "ctrl+shift+b", "delete", "1", "?", "ctrl+,".
 *
 * Conventions:
 * - Ctrl and Meta (Cmd) are unified under the "ctrl" token.
 * - Modifier order is always ctrl, alt, shift, then the main key.
 * - Letters/digits are lowercased and CapsLock-insensitive; Shift adds a
 *   "shift" token (so Shift+T → "shift+t").
 * - Symbol characters that already encode Shift on the layout (e.g. "?", ",")
 *   are kept verbatim without an extra "shift" token.
 * - Named keys (ArrowLeft, Delete, Enter, …) are lowercased.
 */

type ComboEventLike = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "OS",
  "AltGraph",
  "CapsLock",
  "Dead",
]);

export function comboFromEvent(event: ComboEventLike): string | null {
  const key = normalizeKeyboardKey(event);
  if (!key || MODIFIER_KEYS.has(key)) {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push("ctrl");
  }
  if (event.altKey) {
    parts.push("alt");
  }

  const isSingleChar = key.length === 1;
  const isAlnum = isSingleChar && /^[a-z0-9]$/i.test(key);

  let main: string;
  if (isSingleChar && !isAlnum) {
    // Symbol char already encodes Shift on the keyboard layout.
    main = key;
  } else {
    main = key.toLowerCase();
    if (event.shiftKey) {
      parts.push("shift");
    }
  }

  parts.push(main);
  return parts.join("+");
}

function normalizeKeyboardKey(event: ComboEventLike): string {
  if (event.code === "NumpadAdd") {
    return "NumpadAdd";
  }
  return event.key;
}

const NAMED_KEY_LABELS: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  delete: "Del",
  backspace: "Backspace",
  enter: "Enter",
  escape: "Esc",
  numpadadd: "+",
  tab: "Tab",
  " ": "Space",
};

/** Render a combo string into display tokens for <kbd> elements. */
export function formatCombo(combo: string): string[] {
  if (!combo) {
    return [];
  }
  return combo.split("+").map((token) => {
    const named = NAMED_KEY_LABELS[token];
    if (named) {
      return named;
    }
    return token.length === 1 ? token.toUpperCase() : token;
  });
}
