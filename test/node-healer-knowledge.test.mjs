import test from "node:test";
import assert from "node:assert/strict";
import { NodeHealer } from "../src/index.mjs";

const errorFixture = `npm error code ERESOLVE
npm error While resolving: @example/app@1.0.0
npm error Found: nitro@3.0.260603-beta
npm error peerOptional nitro@">=3.0.260429-beta" from @example/config@2.0.0`;

function fakeKnowledgeStore({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async initialize() { calls.push(["initialize"]); if (fail) throw new Error("database offline"); },
    async put(relation, value) { calls.push(["put", relation, value]); return { status: "stored" }; },
    async recordFailure(value) { calls.push(["recordFailure", value]); },
    async findSimilarCases(query) { calls.push(["findSimilarCases", query]); return [{ case_id: "previous-case" }]; },
    async inferReachableNodes(id, options) { calls.push(["inferReachableNodes", id, options]); return [{ node: "hypothesis:prior" }]; }
  };
}

test("diagnosis persists redacted case evidence and retrieves graph context", async () => {
  const store = fakeKnowledgeStore();
  const healer = new NodeHealer({ knowledgeStore: store });
  const result = await healer.diagnose(errorFixture);
  assert.equal(result.knowledge.status, "available");
  assert.equal(result.knowledge.similarCases[0].case_id, "previous-case");
  assert.equal(result.knowledge.reachableNodes[0].node, "hypothesis:prior");
  assert.ok(store.calls.some(([kind, relation]) => kind === "put" && relation === "failure_signature"));
  const record = store.calls.find(([kind]) => kind === "recordFailure")[1];
  assert.equal(record.error_code, "ERESOLVE");
  assert.ok(record.redacted_excerpt.includes("ERESOLVE"));
  assert.ok(record.evidenceFacts.some((fact) => fact.kind === "constraint"));
  assert.ok(store.calls.some(([kind, relation]) => kind === "put" && relation === "knowledge_edge"));
  // Retrieved knowledge is context only; it does not inject executable candidates.
  assert.ok(result.candidates.every((candidate) => typeof candidate.command === "string"));
});

test("CozoDB outage degrades to local diagnosis without bypassing approval", async () => {
  const store = fakeKnowledgeStore({ fail: true });
  const healer = new NodeHealer({ knowledgeStore: store, onTerminal: async () => "defer" });
  const result = await healer.heal(errorFixture, { autoApply: true });
  assert.equal(result.diagnosis.knowledge.status, "unavailable");
  assert.equal(result.status, "awaiting-approval");
});

test("knowledge store is optional for backwards-compatible local diagnosis", async () => {
  const healer = new NodeHealer();
  const result = await healer.diagnose(errorFixture);
  assert.equal(result.knowledge.status, "disabled");
  assert.ok(result.candidates.length > 0);
});
