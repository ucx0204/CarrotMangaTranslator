export function sanitizeTitle(title: string, fallback: string): string {
  const trimmed = title.trim();
  return trimmed || fallback;
}

export function makeUniqueTitleInList(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }

  let index = 1;
  while (used.has(`${desired} (${index})`)) {
    index += 1;
  }
  const next = `${desired} (${index})`;
  used.add(next);
  return next;
}
