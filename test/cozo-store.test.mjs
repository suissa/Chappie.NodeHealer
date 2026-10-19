import test from "node:test";
import assert from "node:assert/strict";
import { CozoKnowledgeStore } from "../src/knowledge/cozo-store.mjs";

function fakeDb({ relations = [], applied = [], onRun } = {}) {
  const calls = [];
  return {
    calls,
    async run(query, params = {}) {
      calls.push({ query, params });
      if (onRun) return onRun(query, params, calls);
      if (query === "::relations") return { ok: true, headers: ["name"], rows: relations.map((name) => [name]) };
      if (query.includes("*nodehealer_migration")) return { ok: true, headers: ["version"], rows: applied.map((v) => [v]) };
      if (query.includes("reachable_")) return { ok: true, headers: ["node"], rows: [["solution:1"]] };
      if (query.includes("*failure_case")) return { ok: true, headers: ["case_id", "error_code"], rows: [["case:1", "ERESOLVE"]] };
      if (query.includes("*solution")) return { ok: true, headers: ["solution_id", "title"], rows: [["solution:1", "inspect safely"]] };
      return { ok: true, headers: ["status"], rows: [["OK"]] };
    },
    close() {}
  };
}

test("requires a Cozo-compatible query client", () => {
  assert.throws(() => new CozoKnowledgeStore(), /requires a CozoDb-compatible/);
});

test("initialization creates missing relations and records schema version", async () => {
  const db = fakeDb();
  const store = new CozoKnowledgeStore({ db, clock: () => "2026-10-19T00:00:00.000Z" });
  const result = await store.initialize();
  assert.equal(result.status, "initialized");
  assert.equal(result.version, 1);
  assert.ok(db.calls.some((call) => call.query === "::relations"));
  assert.ok(db.calls.some((call) => call.query.includes(":put nodehealer_migration")));
  assert.ok(db.calls.some((call) => call.query.startsWith(":create failure_case")));
  assert.equal((await store.initialize()).status, "already-initialized");
});

test("initialization skips existing relations and already applied migrations", async () => {
  const names = [
    "nodehealer_migration", "failure_case", "failure_signature", "evidence_fact",
    "hypothesis", "knowledge_edge", "solution", "solution_outcome", "heuristic_rule", "execution_audit"
  ];
  const db = fakeDb({ relations: names, applied: [1] });
  const store = new CozoKnowledgeStore({ db });
  const result = await store.initialize();
  assert.equal(result.version, 1);
  assert.equal(db.calls.filter((call) => call.query.startsWith(":create ")).length, 0);
});

test("writes values through query parameters and rejects missing keys", async () => {
  const db = fakeDb();
  const store = new CozoKnowledgeStore({ db });
  const result = await store.put("failure_case", {
    case_id: "case:1",
    error_code: "ERESOLVE",
    redacted_excerpt: "token=should-not-be-in-query"
  });
  assert.equal(result.status, "stored");
  const call = db.calls.at(-1);
  assert.ok(call.query.includes(":put failure_case"));
  assert.ok(!call.query.includes("should-not-be-in-query"));
  assert.equal(call.params.redacted_excerpt, "token=should-not-be-in-query");
  await assert.rejects(() => store.put("failure_case", { error_code: "ERESOLVE" }), /requires non-empty key field/);
});

test("relation names cannot be injected through the write API", async () => {
  const store = new CozoKnowledgeStore({ db: fakeDb() });
  await assert.rejects(() => store.put("failure_case } ::remove failure_case", { case_id: "x" }), /Unsupported NodeHealer relation/);
});

test("similar case lookup uses parameterized filters and bounded limits", async () => {
  const db = fakeDb();
  const store = new CozoKnowledgeStore({ db });
  const rows = await store.findSimilarCases({ errorCode: "ERESOLVE", tool: "npm", excludeCaseId: "current-case", limit: 10000 });
  assert.equal(rows[0].case_id, "case:1");
  const call = db.calls.at(-1);
  assert.ok(call.query.includes(":limit 100"));
  assert.equal(call.params.error_code, "ERESOLVE");
  assert.equal(call.params.exclude_case_id, "current-case");
  assert.ok(!call.query.includes("ERESOLVE"));
});

test("causal reachability query binds the start node and bounds depth", async () => {
  const db = fakeDb();
  const store = new CozoKnowledgeStore({ db });
  const rows = await store.inferReachableNodes("case:1", { maxDepth: 50 });
  assert.equal(rows[0].node, "solution:1");
  const call = db.calls.at(-1);
  assert.equal(call.params.start, "case:1");
  assert.ok(call.query.includes("reachable_9"));
  assert.ok(call.query.includes(":limit 100"));
});

test("solution lookup and verified outcome invariant are enforced", async () => {
  const db = fakeDb();
  const store = new CozoKnowledgeStore({ db });
  const solutions = await store.findSolutionsForHypothesis("hypothesis:1");
  assert.equal(solutions[0].solution_id, "solution:1");
  await assert.rejects(() => store.recordOutcome({
    outcome_id: "outcome:1", solution_id: "solution:1",
    result: "verified-success", verified: false
  }), /must carry verified=true/);
  await store.recordOutcome({
    outcome_id: "outcome:2", solution_id: "solution:1",
    result: "verified-success", verified: true
  });
});

test("closes native database resources", async () => {
  let closed = false;
  const db = fakeDb();
  db.close = () => { closed = true; };
  const store = new CozoKnowledgeStore({ db });
  await store.close();
  assert.equal(closed, true);
});
