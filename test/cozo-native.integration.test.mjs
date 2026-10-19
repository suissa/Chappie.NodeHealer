import test from "node:test";
import assert from "node:assert/strict";
import { CozoKnowledgeStore } from "../src/knowledge/cozo-store.mjs";

let CozoDb;
let nativeLoadError;
try {
  ({ CozoDb } = await import("cozo-node"));
} catch (error) {
  nativeLoadError = error;
}

test("native CozoDB applies schema, stores evidence, and infers graph reachability", {
  skip: !CozoDb ? `cozo-node native binding unavailable: ${nativeLoadError?.message ?? "not installed"}` : false
}, async () => {
  const db = new CozoDb("mem", "nodehealer-native-test", {});
  const store = new CozoKnowledgeStore({ db });
  try {
    const initialized = await store.initialize();
    assert.equal(initialized.status, "initialized");

    await store.put("failure_signature", {
      signature_id: "ERESOLVE:dependency-resolution",
      family: "dependency-resolution",
      normalized_pattern: "npm could not resolve dependency",
      parser_id: "integration-test",
      parser_version: "1",
      specificity: 90,
      active: true
    });
    await store.recordFailure({
      case_id: "case:historical",
      observed_at: "2026-10-18T00:00:00.000Z",
      tool: "npm",
      error_code: "ERESOLVE",
      signature_id: "ERESOLVE:dependency-resolution",
      redacted_excerpt: "redacted test failure",
      raw_log_hash: "hash-historical"
    });
    await store.recordFailure({
      case_id: "case:current",
      observed_at: "2026-10-19T00:00:00.000Z",
      tool: "npm",
      error_code: "ERESOLVE",
      signature_id: "ERESOLVE:dependency-resolution",
      redacted_excerpt: "redacted current failure",
      raw_log_hash: "hash-current",
      hypotheses: [{
        hypothesis_id: "hypothesis:current",
        category: "dependency-resolution",
        cause: "peer dependency constraint mismatch",
        confidence: 0.9,
        status: "proposed",
        rule_version: "integration-v1",
        created_at: "2026-10-19T00:00:00.000Z"
      }]
    });
    await store.put("knowledge_edge", {
      from_id: "case:current",
      edge_type: "suggests",
      to_id: "hypothesis:current",
      confidence: 0.9,
      provenance_id: "case:current",
      rule_version: "integration-v1",
      created_at: "2026-10-19T00:00:00.000Z"
    });

    const similar = await store.findSimilarCases({
      signatureId: "ERESOLVE:dependency-resolution",
      excludeCaseId: "case:current"
    });
    assert.equal(similar.length, 1);
    assert.equal(similar[0].case_id, "case:historical");

    const reachable = await store.inferReachableNodes("case:current", { maxDepth: 3 });
    assert.ok(reachable.some((row) => row.node === "hypothesis:current"));
  } finally {
    await store.close();
  }
});
