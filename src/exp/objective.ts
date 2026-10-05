/**
 * Tuning objective. Held-out agreement is intentionally not a parameter.
 * The gatekeeper is the only caller that scores the held-out split.
 */
export function tuningScore(winRate: number, devAgreement: number, devWeight = 1): number {
  return winRate + devWeight * devAgreement;
}
