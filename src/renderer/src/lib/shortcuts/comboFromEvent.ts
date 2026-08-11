/**
 * Normalizes a keyboard event into a canonical combo string used by the
 * shortcut registry, e.g. "ctrl+shift+b", "delete", "1", "?", "ctrl+,".
 *
 * Conventions:
 * - Ctrl and Meta (Cmd) are unified under the "ctrl" token.
 * - Modifier order is always ctrl, alt, shift, then the main key.
 * - Letter keys use their physical `KeyA`…`KeyZ` code so shortcuts keep
 *   working while a Korean or other non-Latin input method is active.
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

type WheelComboEventLike = {
  deltaX: number;
  deltaY: number;
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

  const parts = modifierTokens(event, false);

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

/**
 * Normalizes a vertical wheel gesture into the same canonical combo namespace
 * as keyboard shortcuts. Up/down describe the user's wheel direction, while
 * Ctrl and Meta (Cmd) share the platform-neutral `ctrl` token.
 */
export function comboFromWheelEvent(event: WheelComboEventLike): string | null {
  const delta = resolveWheelGestureDelta(event);
  if (!delta) {
    return null;
  }
  return [
    ...modifierTokens(event, true),
    delta < 0 ? "wheelup" : "wheeldown",
  ].join("+");
}

function resolveWheelGestureDelta(event: WheelComboEventLike): number {
  if (event.deltaY && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
    return event.deltaY;
  }
  // Chromium can translate Shift+physical-wheel into horizontal delta. Treat
  // that platform form as the same Shift+wheel gesture.
  return event.shiftKey ? event.deltaX : 0;
}

function modifierTokens(
  event: Pick<ComboEventLike, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  includeShift: boolean,
): string[] {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push("ctrl");
  }
  if (event.altKey) {
    parts.push("alt");
  }
  if (includeShift && event.shiftKey) {
    parts.push("shift");
  }
  return parts;
}

function normalizeKeyboardKey(event: ComboEventLike): string {
  const letter = /^Key([A-Z])$/.exec(event.code ?? "")?.[1];
  if (letter) {
    return letter;
  }
  if (event.code === "NumpadAdd") {
    return "NumpadAdd";
  }
  return event.key;
}

const NAMED_KEY_LABELS: Record<string, string> = {
  add: "+",
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
  pagedown: "Page Down",
  pageup: "Page Up",
  tab: "Tab",
  wheeldown: "Wheel ↓",
  wheelup: "Wheel ↑",
  " ": "Space",
};

/** Render a combo string into display tokens for <kbd> elements. */
export function formatCombo(
  combo: string,
  platform: string = currentNavigatorPlatform(),
): string[] {
  if (!combo) {
    return [];
  }
  return splitComboTokens(combo).map((token) => {
    if (token === "ctrl") {
      return isMacShortcutPlatform(platform) ? "⌘" : "Ctrl";
    }
    const named = NAMED_KEY_LABELS[token];
    if (named) {
      return named;
    }
    return token.length === 1 ? token.toUpperCase() : token;
  });
}

function splitComboTokens(combo: string): string[] {
  const tokens: string[] = [];
  let mainKey = combo;
  for (const modifier of ["ctrl", "alt", "shift"] as const) {
    const prefix = `${modifier}+`;
    if (mainKey.startsWith(prefix)) {
      tokens.push(modifier);
      mainKey = mainKey.slice(prefix.length);
    }
  }
  if (mainKey) tokens.push(mainKey);
  return tokens;
}

export function formatShortcutTextForPlatform(
  value: string,
  platform: string = currentNavigatorPlatform(),
): string {
  return isMacShortcutPlatform(platform)
    ? value.replaceAll("Ctrl", "Cmd")
    : value;
}

function isMacShortcutPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function currentNavigatorPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}
