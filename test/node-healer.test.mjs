import test from "node:test";
import assert from "node:assert/strict";
import { NodeHealer, analyzeSemverRange, normalizeError, proposeRepairs } from "../src/index.mjs";

const fixture = `npm error code ERESOLVE
npm error ERESOLVE could not resolve
npm error While resolving: @lovable.dev/vite-tanstack-config@2.1.1
npm error Found: nitro@3.0.260603-beta
npm error Could not resolve dependency:
npm error peerOptional nitro@">=3.0.260429-beta" from @lovable.dev/vite-tanstack-config@2.1.1
npm error Conflicting peer dependency: nitro@3.0.260429-beta
npm error Fix the upstream dependency conflict, or retry this command with --force or --legacy-peer-deps to accept an incorrect dependency resolution.`;

test("parses ERESOLVE fields and identifies prerelease exclusion", () => {
  const error = normalizeError(fixture);
  assert.equal(error.code, "ERESOLVE");
  assert.equal(error.category, "dependency-resolution");
  assert.deepEqual(error.dependencyEvidence.resolvingPackage, {
    name: "@lovable.dev/vite-tanstack-config",
    version: "2.1.1"
  });
  assert.deepEqual(error.dependencyEvidence.found, {
    name: "nitro",
    version: "3.0.260603-beta"
  });
  assert.deepEqual(error.dependencyEvidence.peerDependency, {
    optional: true,
    name: "nitro",
    range: ">=3.0.260429-beta",
    declaredBy: { name: "@lovable.dev/vite-tanstack-config", version: "2.1.1" }
  });
  assert.equal(error.dependencyEvidence.semverAnalysis.prereleaseExcluded, true);
  assert.equal(error.dependencyEvidence.semverAnalysis.compatible, false);
});

test("SemVer prerelease rule excludes a prerelease from a different base version", () => {
  const result = analyzeSemverRange(">=3.0.260429-beta", "3.0.260603-beta");
  assert.equal(result.supported, true);
  assert.equal(result.compatible, false);
  assert.equal(result.prereleaseExcluded, true);
  assert.match(result.reason, /prereleases/i);
});

test("SemVer comparator admits a prerelease from the same base version", () => {
  const result = analyzeSemverRange(">=3.0.260429-beta", "3.0.260429-rc.1");
  assert.equal(result.compatible, true);
  assert.equal(result.prereleaseExcluded, false);
});

test("stable release is not excluded by prerelease gating", () => {
  const result = analyzeSemverRange(">=3.0.260429-beta", "3.0.260603");
  assert.equal(result.compatible, true);
  assert.equal(result.prereleaseExcluded, false);
});

test("complete npm SemVer ranges are evaluated without guessing", () => {
  assert.equal(analyzeSemverRange("^3.0.0 || >=4.0.0", "3.2.0").compatible, true);
  assert.equal(analyzeSemverRange("^3.0.0 || >=4.0.0", "4.1.0").compatible, true);
  assert.equal(analyzeSemverRange("^3.0.0 || >=4.0.0", "5.0.0-beta.1").compatible, false);
  assert.equal(analyzeSemverRange("not-a-range", "3.0.0").supported, false);
  assert.equal(analyzeSemverRange("^3.0.0", "not-a-version").supported, false);
});

test("proposes investigation before the risky workaround", () => {
  const repairs = proposeRepairs(normalizeError(fixture));
  assert.equal(repairs.length, 2);
  assert.equal(repairs[0].command, "npm view nitro versions --json");
  assert.equal(repairs[0].kind, "read-only-investigation");
  assert.equal(repairs[1].command, "npm install --legacy-peer-deps");
  assert.equal(repairs[1].kind, "workaround");
  assert.equal(repairs[0].requiresApproval, true);
  assert.equal(repairs[1].requiresApproval, true);
});

test("does not expose raw error while awaiting approval", async () => {
  const healer = new NodeHealer({ onTerminal: async () => "defer" });
  const result = await healer.heal(fixture);
  assert.equal(result.status, "awaiting-approval");
  assert.equal(result.rawError, undefined);
  assert.equal(result.diagnosis.error.dependencyEvidence.semverAnalysis.prereleaseExcluded, true);
});

test("reveals raw error only after explicit terminal interaction", async () => {
  const healer = new NodeHealer({ onTerminal: async () => "show-error" });
  const result = await healer.heal(fixture);
  assert.equal(result.status, "human-interaction");
  assert.equal(result.rawError, fixture);
});

test("unknown errors remain unresolved rather than inventing a fix", async () => {
  const healer = new NodeHealer({ onTerminal: async () => "defer" });
  const result = await healer.heal("unexpected failure without known signature");
  assert.equal(result.status, "unresolved");
  assert.equal(result.diagnosis.candidates.length, 0);
});

test("never silently applies a candidate that requires approval", async () => {
  let applied = false;
  const healer = new NodeHealer({
    apply: async () => { applied = true; },
    verify: async () => true,
    onTerminal: async () => "defer"
  });
  const result = await healer.heal(fixture, { autoApply: true });
  assert.equal(result.status, "awaiting-approval");
  assert.equal(applied, false);
});

test("developer can explicitly select the workaround candidate", async () => {
  let appliedCommand;
  let terminalEvent;
  const healer = new NodeHealer({
    onTerminal: async (event) => {
      terminalEvent = event;
      return "approve";
    },
    apply: async (command) => {
      appliedCommand = command;
      return { exitCode: 0 };
    },
    verify: async () => true
  });
  const result = await healer.heal(fixture, {
    candidateId: "npm-legacy-peer-deps-workaround"
  });
  assert.equal(terminalEvent.candidateId, "npm-legacy-peer-deps-workaround");
  assert.equal(appliedCommand, "npm install --legacy-peer-deps");
  assert.equal(result.status, "healed");
});

test("invalid candidate IDs never execute commands", async () => {
  let applied = false;
  const healer = new NodeHealer({
    onTerminal: async () => "approve",
    apply: async () => { applied = true; },
    verify: async () => true
  });
  const result = await healer.heal(fixture, { candidateId: "not-a-real-candidate" });
  assert.equal(result.status, "invalid-candidate");
  assert.equal(applied, false);
});
