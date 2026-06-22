export function assertSafeStoreId(value: string, message: string): void {
  if (!isSafeStoreId(value)) {
    throw new Error(message);
  }
}

function isSafeStoreId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}
