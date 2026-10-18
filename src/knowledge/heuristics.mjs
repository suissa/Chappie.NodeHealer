/**
 * Pure, explainable ranking primitives for NodeHealer.
 * This module does not access CozoDB, the filesystem, or a shell.
 */

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export const DEFAULT_SCORING_POLICY = Object.freeze({
  version: "nodehealer-score-v1",
  weights: Object.freeze({
    evidence: 0.30,
    signature: 0.25,
    causal: 0.15,
    history: 0.15,
    environment: 0.10,
    reversibility: 0.05
  }),
  minimumScore: 65,
  minimumEvidence: 0.6,
  minimumMargin: 8
});

/** Smoothed verified-success estimate; sparse history trends toward 0.5. */
export function estimateHistoricalSuccess(successes, verifiedTrials) {
  const trials = Math.max(0, Math.floor(Number(verifiedTrials) || 0));
  const wins = Math.max(0, Math.min(trials, Math.floor(Number(successes) || 0)));
  return (wins + 2) / (trials + 4);
}

/** Scores a candidate but never grants execution permission. */
export function scoreCandidate(candidate, policy = DEFAULT_SCORING_POLICY) {
  const components = {
    evidence: clamp01(candidate.evidenceCoverage),
    signature: clamp01(candidate.signatureMatch),
    causal: clamp01(candidate.causalCompatibility),
    history: clamp01(candidate.historicalSuccess ?? 0.5),
    environment: clamp01(candidate.environmentCompatibility),
    reversibility: clamp01(candidate.reversibility)
  };
  const weighted = Object.fromEntries(
    Object.entries(policy.weights).map(([key, weight]) => [key, components[key] * weight])
  );
  const riskPenalty = Math.max(0, Math.min(100, Number(candidate.riskPenalty) || 0));
  const score = Math.max(0, Math.min(100,
    100 * Object.values(weighted).reduce((sum, value) => sum + value, 0) - riskPenalty
  ));
  return {
    candidateId: candidate.candidateId,
    score: Number(score.toFixed(2)),
    components,
    weighted,
    riskPenalty,
    policyVersion: policy.version,
    requiresApproval: candidate.requiresApproval !== false || candidate.riskClass !== "read-only",
    riskClass: candidate.riskClass ?? "unknown"
  };
}

/** Selects only if evidence, score, ambiguity, and preconditions pass. */
export function selectCandidate(scoredCandidates, {
  policy = DEFAULT_SCORING_POLICY,
  preconditionsByCandidate = {}
} = {}) {
  const eligible = scoredCandidates
    .filter((item) => item && item.score >= policy.minimumScore)
    .filter((item) => (item.components?.evidence ?? 0) >= policy.minimumEvidence)
    .filter((item) => preconditionsByCandidate[item.candidateId] === true)
    .sort((a, b) => b.score - a.score);

  if (eligible.length === 0) {
    return { status: "needs-human", selected: null, reason: "No candidate passed the evidence, score, and precondition gates." };
  }
  if (eligible.length > 1 && eligible[0].score - eligible[1].score < policy.minimumMargin) {
    return { status: "ambiguous", selected: null, candidates: eligible, reason: "Top candidates are too close to select safely." };
  }
  return {
    status: "selected-for-approval",
    selected: eligible[0],
    candidates: eligible,
    reason: "Candidate passed ranking gates; execution still requires separate authorization."
  };
}

/** Explicit policy boundary: scoring alone can never authorize execution. */
export function authorizeExecution(candidate, approval = null, policy = {}) {
  if (!candidate) return { allowed: false, reason: "missing-candidate" };
  if (candidate.riskClass !== "read-only" && !approval) {
    return { allowed: false, reason: "explicit-approval-required" };
  }
  if (candidate.requiresApproval !== false && !approval) {
    return { allowed: false, reason: "explicit-approval-required" };
  }
  if (policy.enabled !== true) return { allowed: false, reason: "execution-disabled-by-policy" };
  if (approval && approval.candidateId !== candidate.candidateId) {
    return { allowed: false, reason: "approval-candidate-mismatch" };
  }
  if (approval && policy.commandFingerprint && approval.commandFingerprint !== policy.commandFingerprint) {
    return { allowed: false, reason: "approval-command-mismatch" };
  }
  return { allowed: true, reason: "policy-and-approval-checks-passed" };
}
