import test from "node:test";
import assert from "node:assert/strict";
import { NodeHealer, normalizeError, proposeRepairs } from "../src/index.mjs";

const fixture = `npm error code ERESOLVE
npm error ERESOLVE could not resolve
npm error While resolving: @lovable.dev/vite-tanstack-config@2.1.1
npm error Found: nitro@3.0.260603-beta
npm error Could not resolve dependency:
npm error peerOptional nitro@">=3.0.260429-beta" from @lovable.dev/vite-tanstack-config@2.1.1
npm error Conflicting peer dependency: nitro@3.0.260429-beta
npm error Fix the upstream dependency conflict, or retry this command with --force or --legacy-peer-deps to accept an incorrect dependency resolution.`;

test("classifies npm ERESOLVE without executing a command", () => {
  const error = normalizeError(fixture);
  assert.equal(error.code, "ERESOLVE");
  assert.equal(error.category, "dependency-resolution");
  const repairs = proposeRepairs(error);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].command, "npm install --save-dev nitro@3.0.260603-beta @lovable.dev/vite-tanstack-config@2.1.1");
  assert.equal(repairs[0].requiresApproval, true);
});

test("does not expose raw error while awaiting approval", async () => {
  const healer = new NodeHealer({ onTerminal: async () => "defer" });
  const result = await healer.heal(fixture);
  assert.equal(result.status, "awaiting-approval");
  assert.equal(result.rawError, undefined);
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
  const healer = new NodeHealer({ apply: async () => { applied = true; }, verify: async () => true, onTerminal: async () => "defer" });
  const result = await healer.heal(fixture, { autoApply: true });
  assert.equal(result.status, "awaiting-approval");
  assert.equal(applied, false);
});
