type ExpiringResults = {
  importPreview?: { expiresAt: number };
  retainedContextProposal?: { expiresAt: number };
  soundEffectPlan?: { expiresAt: number };
  letteringPlan?: { expiresAt: number };
};

export function expiredPlanResult<T extends ExpiringResults>(
  result: T,
  now: number,
) {
  if (result.importPreview && result.importPreview.expiresAt <= now) {
    const { importPreview: _preview, ...metadata } = result;
    return { ...metadata, importPreviewExpired: true };
  }
  const proposal = result.retainedContextProposal;
  if (proposal && proposal.expiresAt <= now)
    return { ...result, proposalExpired: true };
  if (result.soundEffectPlan && result.soundEffectPlan.expiresAt <= now) {
    const { soundEffectPlan: _sound, ...metadata } = result;
    return { ...metadata, proposalExpired: true };
  }
  if (result.letteringPlan && result.letteringPlan.expiresAt <= now) {
    const { letteringPlan: _lettering, ...metadata } = result;
    return { ...metadata, proposalExpired: true };
  }
  return undefined;
}
