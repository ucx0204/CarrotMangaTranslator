/** Both workspace approval and the waiting job validate the same unique page scope. */
export function indexRedactionConfirmationPages<T extends { id: string }>(
  pages: readonly T[],
  expectedCount: number,
): Map<string, T> {
  const indexed = new Map(pages.map((page) => [page.id, page]));
  if (indexed.size !== pages.length || indexed.size !== expectedCount)
    throw new Error("확인할 페이지 목록이 다릅니다.");
  return indexed;
}
