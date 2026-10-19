import test from "node:test";
import assert from "node:assert/strict";
import { CozoHttpClient, CozoKnowledgeStore, openCozoKnowledgeStore } from "../src/knowledge/cozo-store.mjs";

test("HTTP client sends parameterized CozoScript to the official query endpoint", async () => {
  let request;
  const client = new CozoHttpClient({
    endpoint: "http://127.0.0.1:9070/text-query",
    authToken: "test-token",
    timeoutMs: 2000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ ok: true, headers: ["value"], rows: [[42]] }) };
    }
  });
  const result = await client.run("?[value] <- [[$value]]", { value: 42 });
  assert.equal(request.url, "http://127.0.0.1:9070/text-query");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-cozo-auth"], "test-token");
  assert.deepEqual(JSON.parse(request.options.body), {
    script: "?[value] <- [[$value]]",
    params: { value: 42 }
  });
  assert.deepEqual(result.rows, [[42]]);
});

test("HTTP client rejects non-HTTP endpoints and embedded credentials", () => {
  assert.throws(() => new CozoHttpClient({ endpoint: "file:///tmp/cozo" }), /http or https/);
  assert.throws(() => new CozoHttpClient({ endpoint: "http://user:pass@localhost:9070/text-query" }), /Do not embed credentials/);
});

test("HTTP errors and Cozo query errors are surfaced without swallowing diagnostics", async () => {
  const httpClient = new CozoHttpClient({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ message: "database unavailable" }) })
  });
  await assert.rejects(() => httpClient.run("::relations"), /database unavailable/);

  const queryClient = new CozoHttpClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, display: "invalid CozoScript" }) })
  });
  const store = new CozoKnowledgeStore({ db: queryClient });
  await assert.rejects(() => store.query("invalid"), /invalid CozoScript/);
});

test("factory defaults to HTTP and rejects unknown transports", async () => {
  const store = await openCozoKnowledgeStore({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, headers: ["name"], rows: [] }) })
  });
  assert.equal((await store.query("::relations")).length, 0);
  await assert.rejects(() => openCozoKnowledgeStore({ transport: "unknown" }), /transport must be/);
});

test("live CozoDB server integration runs when COZO_URL is configured", {
  skip: !process.env.COZO_URL ? "Set COZO_URL to a trusted CozoDB /text-query endpoint to run live integration." : false
}, async () => {
  const store = await openCozoKnowledgeStore({
    endpoint: process.env.COZO_URL,
    authToken: process.env.COZO_AUTH_TOKEN,
    timeoutMs: 10000
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await store.initialize();
    const signatureId = `integration:${suffix}`;
    const caseId = `integration-case:${suffix}`;
    await store.put("failure_signature", {
      signature_id: signatureId, family: "integration", normalized_pattern: "integration case",
      parser_id: "live-test", parser_version: "1", specificity: 1, active: true
    });
    await store.recordFailure({
      case_id: caseId, observed_at: new Date().toISOString(), tool: "npm",
      error_code: "EINTEGRATION", signature_id: signatureId,
      redacted_excerpt: "synthetic integration test", raw_log_hash: suffix
    });
    const cases = await store.findSimilarCases({ signatureId, excludeCaseId: "not-this-case" });
    assert.ok(cases.some((row) => row.case_id === caseId));
  } finally {
    await store.close();
  }
});
