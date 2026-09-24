/** Preserve both failures after an admitted native child has been given its physical cleanup wait. */
export async function failAfterCompositeNativeCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
): Promise<never> {
  try {
    await cleanup();
  } catch (failure) {
    throw new AggregateError(
      [error, failure],
      "Native composite child cleanup failed.",
      { cause: failure },
    );
  }
  throw error;
}
