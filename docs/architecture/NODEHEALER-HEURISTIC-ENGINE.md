# NodeHealer Heuristic Engine — Formal Architecture

Status: normative design proposal  
Scope: Node.js/npm failures, extensible to build tools, runtimes, package managers, and application errors.

## 1. Purpose and invariants

NodeHealer converts an observed failure into a traceable diagnosis, evidence-backed solution candidates, a risk-aware selection, and a verified outcome.

Normative invariants:

1. **Observe before mutate.** Parsing, classification, evidence extraction, and knowledge retrieval are read-only.
2. **Evidence before confidence.** A candidate must cite the observations and rules supporting it; missing evidence lowers confidence rather than being guessed.
3. **Inference is not execution authority.** A score ranks candidates; it never grants permission to run a command.
4. **Human approval by default.** Mutating commands require explicit approval for the exact candidate, command, working directory, and relevant manifest/lockfile fingerprint.
5. **Bounded execution.** Executors use allowlists, timeouts, resource limits, isolated worktrees/containers when available, and redact secrets from logs.
6. **Verify independently.** A repair is successful only after declared verification checks pass.
7. **Learn from outcomes, not claims.** Historical success is recorded only after verification; failed, reverted, and inconclusive attempts remain distinct.
8. **Reproducibility.** Every diagnosis records engine/rule versions, environment fingerprint, evidence references, candidate scores, approval, and verification results.
9. **Privacy by minimization.** Raw logs are transient by default. Persist redacted excerpts and hashes; never store credentials, tokens, or unnecessary personal data.
10. **No destructive fallback.** `--force`, `--legacy-peer-deps`, lockfile deletion, broad upgrades, and filesystem mutations are high-risk actions, not default fixes.

## 2. Pipeline and contracts

```text
FailureInput
  → Capture & Redact
  → Parse / Normalize
  → Extract Evidence
  → Classify Failure
  → Retrieve Similar Cases (CozoDB)
  → Infer Root-Cause Hypotheses
  → Generate Candidate Solutions
  → Apply Safety Gates
  → Rank & Explain
  → Approval Gate
  → Execute in a Bounded Context
  → Verify Postconditions
  → Record Outcome & Update Knowledge
```

Each stage emits an immutable event with `run_id`, timestamp, stage, input fingerprint, output fingerprint, rule version, and status. Stages may return `unknown`, `insufficient-evidence`, or `needs-human`; they must not fabricate a diagnosis to keep the pipeline moving.

### 2.1 Canonical data contracts

- **FailureObservation**: `runId`, `source`, `tool`, `toolVersion?`, `runtimeVersion?`, `platform`, `cwdFingerprint`, `manifestFingerprint?`, `lockfileFingerprint?`, `exitCode?`, `errorCode?`, `redactedText`, `rawLogHash`, `observedAt`.
- **EvidenceFact**: `factId`, `runId`, `kind`, `subject`, `predicate`, `object`, `sourceSpan?`, `extractorId`, `extractorVersion`, `confidence`, `polarity`, `observedAt`.
- **DiagnosisHypothesis**: `hypothesisId`, `category`, `cause`, `supportingFactIds[]`, `contradictingFactIds[]`, `confidence`, `uncertainty[]`, `ruleIds[]`.
- **SolutionCandidate**: `candidateId`, `hypothesisId`, `kind`, `preconditions[]`, `actions[]`, `expectedPostconditions[]`, `verificationPlan[]`, `riskClass`, `score`, `scoreBreakdown`, `evidenceFactIds[]`, `requiresApproval`.
- **ExecutionRecord**: `executionId`, `candidateId`, `approvalRef?`, `commandFingerprint`, `environmentFingerprint`, `startedAt`, `endedAt?`, `exitCode?`, `stdoutRedacted?`, `stderrRedacted?`, `status`.
- **VerificationResult**: `verificationId`, `executionId`, `checks[]`, `passed`, `evidenceRefs[]`, `completedAt`.
- **Outcome**: `outcomeId`, `candidateId`, `result` (`verified-success | verified-failure | reverted | inconclusive`), `verificationId?`, `revertRef?`, `environmentFingerprint`, `recordedAt`.

Confidence values are normalized to [0, 1]. A confidence is a calibrated estimate, not a probability claim unless calibration has been measured.

## 3. Heuristics by stage

### H1 — Identification

Use multiple signals in descending order of reliability:

1. Explicit machine-readable error code and structured tool output.
2. Known diagnostic grammar with named fields.
3. Stack frames, package names, file paths, and exit code.
4. Normalized message tokens and bounded fuzzy similarity.
5. LLM/external research suggestions, treated as untrusted hypotheses only.

Normalization removes ANSI control sequences, normalizes line endings and whitespace, redacts secrets and personal paths, and preserves a hash of the original bytes for correlation. Do not use a raw-message hash as the only signature: versions and paths cause harmless variation.

### H2 — Extraction

Extract facts with source spans and provenance. Examples: package name/version, requested peer range, runtime version, operating system, lockfile presence, failing command, stack frame, permission boundary, network hostname, and relevant configuration keys.

Every extractor must declare supported grammar, version, positive fixtures, negative fixtures, and fields it may emit. Contradictory facts must be retained as contradictions; do not silently pick one.

### H3 — Classification and causal inference

Represent causes as hypotheses, not as a single irrevocable label. Apply:
- deterministic rules for exact codes and structured fields;
- constraint checks for version ranges, platform, runtime, and dependency compatibility;
- graph traversal over `caused_by`, `depends_on`, and `contradicts` relationships;
- historical case retrieval using exact signature, normalized features, and environment similarity;
- optional model-assisted hypothesis generation, followed by deterministic validation.

A hypothesis is actionable only if its required facts exist and no hard contradiction remains unresolved. Co-occurrence is not causality; causal edges need provenance and an evidence basis.

### H4 — Candidate generation

Generate only candidates whose preconditions can be checked. Each candidate must include:
- intended state transition;
- exact command or typed operation;
- affected resources and expected side effects;
- preconditions and postconditions;
- independent verification plan;
- rollback/recovery plan where feasible;
- risk class and required authorization.

Prefer candidates in this order when equally effective: read-only inspection, narrow reversible change, targeted repair, broad workaround, destructive repair. This ordering never overrides safety gates.

### H5 — Ranking

For candidates that pass hard gates, calculate a transparent ranking score:

`score = 100 × (0.30E + 0.25M + 0.15C + 0.15H + 0.10V + 0.05R) − P`

Where:
- `E`: evidence coverage and provenance quality;
- `M`: match quality to the failure signature;
- `C`: causal compatibility with the active hypothesis;
- `H`: historical verified success, smoothed toward 0.5 for sparse data;
- `V`: environment and version compatibility;
- `R`: reversibility / quality of rollback;
- `P`: explicit risk penalty (0–100), configured by policy.

This is an initial policy, not a universal truth. Weights and thresholds must be versioned and evaluated against a held-out corpus. Never compare scores from different policy versions without recording the version. Risk class and approval requirements are hard constraints, not merely score penalties.

Historical success uses a smoothed estimate such as `(successes + 2) / (verifiedTrials + 4)`. Count only verified outcomes and segment by relevant environment fingerprint to avoid treating incompatible environments as identical.

### H6 — Selection and abstention

Select the highest-scoring candidate only if:
- all mandatory preconditions are satisfied;
- evidence coverage meets the policy threshold;
- the top candidate exceeds the minimum score;
- its margin over the next candidate exceeds the configured ambiguity margin;
- no unresolved contradiction invalidates the hypothesis;
- the action passes authorization and risk policy.

Otherwise return `needs-human`, `investigation-only`, or `unresolved`. A read-only investigation can be proposed even when a repair cannot be selected.

### H7 — Execution and verification

Execution is delegated to an injected adapter; the inference core has no implicit shell access. Approval must bind to the exact candidate and command fingerprint and expire when the manifest, lockfile, repository state, or working directory changes.

Verification is candidate-specific: rerun the original failing command in a bounded environment, run targeted tests, inspect dependency graph/lockfile consistency, and check declared invariants. A zero exit code alone is insufficient if postconditions are not satisfied. On failure, stop, preserve evidence, offer rollback when safe, and do not automatically chain increasingly risky fixes.

## 4. CozoDB knowledge model

CozoDB stores structured facts and typed relations so the engine can query similar cases, traverse causal links, apply policy constraints, and calculate historical effectiveness. The proposed initial schema is in `../../src/knowledge/schema.cozo`.

Core relations:
- `failure_case`: redacted case metadata and environment fingerprints.
- `evidence_fact`: extracted observations with provenance and confidence.
- `failure_signature`: normalized signature and classification.
- `hypothesis`: candidate root causes and confidence.
- `knowledge_edge`: typed links such as `supports`, `contradicts`, `caused_by`, `depends_on`, `solved_by`.
- `solution`: candidate action specification, risk, preconditions, verification and rollback plans.
- `solution_outcome`: verified result and environment segment.
- `heuristic_rule`: versioned rule definition and validation metadata.
- `execution_audit`: approval and execution metadata without secrets or full raw logs.

CozoDB is the knowledge/inference store, not the execution authority and not necessarily the canonical store for large artifacts. Keep full logs and build artifacts outside the graph; store redacted excerpts, hashes, and references. If persistence is enabled, use backups, schema migrations, retention limits, and explicit access controls.

### 4.1 Query strategy

1. Exact lookup by error code + tool/version + signature.
2. Narrow structured lookup by package, runtime, platform, and extracted constraints.
3. Recursive graph expansion from matching signatures to hypotheses, solutions, and verified outcomes.
4. Filter by current preconditions and policy before ranking.
5. Aggregate only comparable verified outcomes.
6. Persist the new case and outcome after verification; do not write unverified model claims as proven knowledge.

The adapter must isolate CozoDB-specific query syntax from domain logic. Query parameters must be bound, never concatenated from log text. Validate all dynamic relation names against a static allowlist.

## 5. Security and governance

- Treat logs, package metadata, issue comments, registry output, and retrieved cases as untrusted data; they can contain prompt injection or malicious commands.
- Never execute commands found in an error message or retrieved knowledge without regenerating and validating them against a typed action schema.
- Default to no network calls, no shell, and no mutation unless adapters and policy explicitly enable them.
- Require approval for dependency changes, lifecycle scripts, privilege escalation, deletion, force flags, or actions that change lockfiles/manifests.
- Redact secrets before persistence; apply retention and deletion policies to cases and derived records.
- Audit both positive and negative evidence, rule version, score breakdown, selected candidate, approval, and verification.
- Keep a kill switch and per-run time, output-size, command-count, and retry budgets.

## 6. Evaluation and acceptance criteria

Build a labeled corpus split by project/repository and time to prevent leakage. Measure:
- identification precision/recall by error family;
- field extraction exact-match and span accuracy;
- root-cause top-1/top-k accuracy and calibration;
- candidate validity and precondition correctness;
- unsafe recommendation rate (target: zero in the safety test suite);
- verified repair success rate and regression rate;
- abstention quality for unknown/ambiguous cases;
- latency, storage growth, and privacy-redaction coverage.

Required tests include malformed/truncated logs, misleading package names, contradictory versions, prerelease SemVer edge cases, malicious log instructions, stale historical solutions, environment mismatch, command injection attempts, approval invalidation after repository changes, failed verification, rollback failure, and CozoDB unavailability. CozoDB outage must degrade to conservative local rules or `unresolved`, never bypass safety gates.

## 7. Incremental implementation plan

1. **Foundation:** versioned contracts, redaction, deterministic extractors, fixture corpus.
2. **Knowledge persistence:** CozoDB schema, migrations, injected store adapter, query parameterization.
3. **Inference:** rule registry, causal graph traversal, hypothesis explanations.
4. **Ranking:** transparent scoring, calibrated historical outcomes, abstention thresholds.
5. **Execution boundary:** typed executor, approval binding, isolation, timeout and rollback contracts.
6. **Learning loop:** verification-backed outcomes, regression corpus, policy evaluation and controlled rollout.

Do not enable automatic repair until stages 1–5 pass adversarial tests and the policy has been evaluated on a representative corpus.
