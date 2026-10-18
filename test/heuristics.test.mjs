import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCORING_POLICY,
  estimateHistoricalSuccess,
  scoreCandidate,
  selectCandidate,
  authorizeExecution
} from "../src/knowledge/heuristics.mjs";

const strongCandidate = {
  candidateId: "candidate-a",
  evidenceCoverage: 1,
  signatureMatch: 1,
  causalCompatibility: 0.9,
  historicalSuccess: 0.8,
  environmentCompatibility: 1,
  reversibility: 0.8,
  riskPenalty: 0,
  riskClass: "targeted-change",
  requiresApproval: true
};

test("historical success is smoothed toward 0.5 when evidence is sparse", () => {
  assert.equal(estimateHistoricalSuccess(0, 0), 0.5);
  assert.equal(estimateHistoricalSuccess(8, 10), 10 / 14);
  assert.equal(estimateHistoricalSuccess(100, 2), 2 / 3);
});

test("score is bounded, explainable, and carries policy version", () => {
  const scored = scoreCandidate(strongCandidate);
  assert.equal(scored.candidateId, "candidate-a");
  assert.ok(scored.score >= 0 && scored.score <= 100);
  assert.equal(scored.policyVersion, DEFAULT_SCORING_POLICY.version);
  assert.equal(scored.requiresApproval, true);
  assert.ok(scored.weighted.evidence > 0);
});

test("selection requires preconditions and returns approval-gated selection", () => {
  const scored = scoreCandidate(strongCandidate);
  assert.equal(selectCandidate([scored]).status, "needs-human");
  const result = selectCandidate([scored], {
    preconditionsByCandidate: { "candidate-a": true }
  });
  assert.equal(result.status, "selected-for-approval");
  assert.equal(result.selected.candidateId, "candidate-a");
});

test("near-tied candidates are not selected automatically", () => {
  const first = scoreCandidate(strongCandidate);
  const second = { ...first, candidateId: "candidate-b", score: first.score - 2 };
  const result = selectCandidate([first, second], {
    preconditionsByCandidate: { "candidate-a": true, "candidate-b": true }
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.selected, null);
});

test("execution remains disabled without policy enablement and approval", () => {
  const scored = scoreCandidate(strongCandidate);
  assert.equal(authorizeExecution(scored, null, { enabled: true }).allowed, false);
  assert.equal(authorizeExecution(scored, {
    candidateId: scored.candidateId,
    commandFingerprint: "cmd-hash"
  }, {
    enabled: true,
    commandFingerprint: "cmd-hash"
  }).allowed, true);
});

test("approval cannot authorize a different candidate or command", () => {
  const scored = scoreCandidate(strongCandidate);
  assert.equal(authorizeExecution(scored, {
    candidateId: "different",
    commandFingerprint: "cmd-hash"
  }, { enabled: true, commandFingerprint: "cmd-hash" }).reason, "approval-candidate-mismatch");
  assert.equal(authorizeExecution(scored, {
    candidateId: scored.candidateId,
    commandFingerprint: "stale-command"
  }, { enabled: true, commandFingerprint: "cmd-hash" }).reason, "approval-command-mismatch");
});
