/**
 * CozoDB-backed knowledge store for NodeHealer.
 *
 * The store accepts a CozoDb-compatible object ({ run(query, params), close? })
 * so domain logic and tests do not depend on native bindings. It never executes
 * repair commands; its only side effects are knowledge-store queries.
 */

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `:create failure_case {
        case_id: String =>
        observed_at: String, source: String, tool: String, tool_version: String,
        runtime_version: String, platform: String, error_code: String,
        signature_id: String, environment_fingerprint: String,
        manifest_fingerprint: String, lockfile_fingerprint: String,
        redacted_excerpt: String, raw_log_hash: String, schema_version: Int
      }`,
      `:create failure_signature {
        signature_id: String =>
        family: String, normalized_pattern: String, parser_id: String,
        parser_version: String, specificity: Int, active: Bool
      }`,
      `:create evidence_fact {
        fact_id: String =>
        case_id: String, kind: String, subject: String, predicate: String,
        object: String, source_span: String, extractor_id: String,
        extractor_version: String, confidence: Float, polarity: String,
        observed_at: String
      }`,
      `:create hypothesis {
        hypothesis_id: String =>
        case_id: String, category: String, cause: String, confidence: Float,
        status: String, rule_version: String, created_at: String
      }`,
      `:create knowledge_edge {
        from_id: String, edge_type: String, to_id: String =>
        confidence: Float, provenance_id: String, rule_version: String,
        created_at: String
      }`,
      `:create solution {
        solution_id: String =>
        hypothesis_id: String, title: String, kind: String, action_spec_json: String,
        preconditions_json: String, postconditions_json: String,
        verification_json: String, rollback_json: String, risk_class: String,
        requires_approval: Bool, policy_version: String, active: Bool, created_at: String
      }`,
      `:create solution_outcome {
        outcome_id: String =>
        solution_id: String, case_id: String, result: String, verified: Bool,
        environment_fingerprint: String, verification_ref: String, revert_ref: String,
        duration_ms: Int, recorded_at: String
      }`,
      `:create heuristic_rule {
        rule_id: String =>
        version: String, stage: String, definition_json: String, fixtures_ref: String,
        precision: Float, recall: Float, enabled: Bool, updated_at: String
      }`,
      `:create execution_audit {
        execution_id: String =>
        case_id: String, solution_id: String, command_fingerprint: String,
        environment_fingerprint: String, approval_ref: String, status: String,
        exit_code: Int, verification_ref: String, started_at: String, ended_at: String
      }`,
      `:create nodehealer_migration {
        version: Int =>
        name: String, applied_at: String
      }`
    ]
  }
];

const RELATION_FIELDS = Object.freeze({
  failure_case: [
    "case_id", "observed_at", "source", "tool", "tool_version", "runtime_version",
    "platform", "error_code", "signature_id", "environment_fingerprint",
    "manifest_fingerprint", "lockfile_fingerprint", "redacted_excerpt", "raw_log_hash",
    "schema_version"
  ],
  failure_signature: [
    "signature_id", "family", "normalized_pattern", "parser_id", "parser_version",
    "specificity", "active"
  ],
  evidence_fact: [
    "fact_id", "case_id", "kind", "subject", "predicate", "object", "source_span",
    "extractor_id", "extractor_version", "confidence", "polarity", "observed_at"
  ],
  hypothesis: [
    "hypothesis_id", "case_id", "category", "cause", "confidence", "status",
    "rule_version", "created_at"
  ],
  knowledge_edge: [
    "from_id", "edge_type", "to_id", "confidence", "provenance_id", "rule_version", "created_at"
  ],
  solution: [
    "solution_id", "hypothesis_id", "title", "kind", "action_spec_json",
    "preconditions_json", "postconditions_json", "verification_json", "rollback_json",
    "risk_class", "requires_approval", "policy_version", "active", "created_at"
  ],
  solution_outcome: [
    "outcome_id", "solution_id", "case_id", "result", "verified",
    "environment_fingerprint", "verification_ref", "revert_ref", "duration_ms", "recorded_at"
  ],
  heuristic_rule: [
    "rule_id", "version", "stage", "definition_json", "fixtures_ref",
    "precision", "recall", "enabled", "updated_at"
  ],
  execution_audit: [
    "execution_id", "case_id", "solution_id", "command_fingerprint",
    "environment_fingerprint", "approval_ref", "status", "exit_code",
    "verification_ref", "started_at", "ended_at"
  ]
});

const DEFAULTS = Object.freeze({
  source: "", tool: "node", tool_version: "", runtime_version: "", platform: "",
  error_code: "", signature_id: "", environment_fingerprint: "",
  manifest_fingerprint: "", lockfile_fingerprint: "", redacted_excerpt: "",
  raw_log_hash: "", schema_version: 1, observed_at: "",
  family: "", normalized_pattern: "", parser_id: "", parser_version: "",
  specificity: 0, active: true, kind: "", subject: "", predicate: "", object: "",
  source_span: "", extractor_id: "", extractor_version: "", confidence: 0,
  polarity: "positive", case_id: "", category: "", cause: "", status: "proposed",
  rule_version: "1", created_at: "", from_id: "", edge_type: "", to_id: "",
  provenance_id: "", title: "", action_spec_json: "{}", preconditions_json: "[]",
  postconditions_json: "[]", verification_json: "[]", rollback_json: "[]",
  risk_class: "unknown", requires_approval: true, hypothesis_id: "", solution_id: "",
  result: "inconclusive", verified: false, verification_ref: "", revert_ref: "",
  duration_ms: 0, recorded_at: "", version: "", stage: "", definition_json: "{}",
  fixtures_ref: "", precision: 0, recall: 0, enabled: false, execution_id: "",
  command_fingerprint: "", approval_ref: "", exit_code: 0, started_at: "", ended_at: ""
});

function normalizeResult(result) {
  if (result?.ok === false) {
    const error = new Error(result.display ?? result.message ?? "CozoDB query failed");
    error.code = "COZODB_QUERY_FAILED";
    throw error;
  }
  const headers = Array.isArray(result?.headers)
    ? result.headers.map((header) => typeof header === "string" ? header : header.name)
    : [];
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows.map((row) => {
    if (!Array.isArray(row)) return row;
    return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
  });
}

function asValue(value, field) {
  if (value !== undefined && value !== null) return value;
  if (field === "active") return false;
  if (field === "requires_approval") return true;
  if (field === "verified" || field === "enabled") return false;
  if (["specificity", "schema_version", "duration_ms", "exit_code"].includes(field)) return 0;
  if (["confidence", "precision", "recall"].includes(field)) return 0;
  return "";
}

export class CozoKnowledgeStore {
  constructor({ db, clock = () => new Date().toISOString() } = {}) {
    if (!db || typeof db.run !== "function") {
      throw new TypeError("CozoKnowledgeStore requires a CozoDb-compatible { run(query, params) } instance.");
    }
    this.db = db;
    this.clock = clock;
    this.initialized = false;
  }

  async query(query, params = {}) {
    return normalizeResult(await this.db.run(query, params));
  }

  async initialize() {
    if (this.initialized) return { status: "already-initialized" };
    const relations = await this.query("::relations");
    const existing = new Set(relations.map((row) => row.name ?? row.relation ?? Object.values(row)[0]));
    // Create the migration ledger first so an interrupted initialization can resume.
    const ledgerStatement = MIGRATIONS[0].statements.at(-1);
    if (!existing.has("nodehealer_migration")) {
      await this.query(ledgerStatement);
      existing.add("nodehealer_migration");
    }
    const applied = await this.query(
      "?[version] := *nodehealer_migration{version}\n:limit 1000"
    );
    const appliedVersions = new Set(applied.map((row) => Number(row.version)));
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      for (const statement of migration.statements.slice(0, -1)) {
        const relationName = statement.match(/^:create\s+([a-z_][a-z0-9_]*)/i)?.[1];
        if (!relationName) throw new Error("Invalid static CozoDB migration statement.");
        if (!existing.has(relationName)) {
          await this.query(statement);
          existing.add(relationName);
        }
      }
      await this.query(
        "?[version, name, applied_at] <- [[$version, $name, $applied_at]]\n:put nodehealer_migration {version}",
        { version: migration.version, name: `nodehealer-schema-v${migration.version}`, applied_at: this.clock() }
      );
    }
    this.initialized = true;
    return { status: "initialized", version: Math.max(...MIGRATIONS.map((item) => item.version)) };
  }

  async put(relation, input) {
    const fields = RELATION_FIELDS[relation];
    if (!fields) throw new TypeError(`Unsupported NodeHealer relation: ${relation}`);
    const keyFields = {
      failure_case: ["case_id"], failure_signature: ["signature_id"], evidence_fact: ["fact_id"],
      hypothesis: ["hypothesis_id"], knowledge_edge: ["from_id", "edge_type", "to_id"],
      solution: ["solution_id"], solution_outcome: ["outcome_id"], heuristic_rule: ["rule_id"],
      execution_audit: ["execution_id"]
    }[relation];
    for (const key of keyFields) {
      if (input?.[key] === undefined || input?.[key] === null || input[key] === "") {
        throw new TypeError(`${relation} requires non-empty key field "${key}".`);
      }
    }
    const params = Object.fromEntries(fields.map((field) => [field, asValue(input[field] ?? (
      field === "observed_at" || field === "created_at" || field === "recorded_at" ||
      field === "updated_at" || field === "started_at" ? this.clock() : undefined
    ), field)]));
    const columns = fields.join(", ");
    const parameterRow = fields.map((field) => `$${field}`).join(", ");
    const keySpec = keyFields.join(", ");
    await this.query(`?[ ${columns} ] <- [[${parameterRow}]]\n:put ${relation} { ${keySpec} }`, params);
    return { status: "stored", relation, key: Object.fromEntries(keyFields.map((key) => [key, params[key]])) };
  }

  async recordFailure(input) {
    const stored = await this.put("failure_case", input);
    for (const fact of input.evidenceFacts ?? []) {
      await this.put("evidence_fact", { ...fact, case_id: input.case_id });
    }
    for (const hypothesis of input.hypotheses ?? []) {
      await this.put("hypothesis", { ...hypothesis, case_id: input.case_id });
    }
    return stored;
  }

  async findSimilarCases({ signatureId, errorCode, tool = "node", limit = 20 } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    if (signatureId) {
      return this.query(
        `?[case_id, observed_at, tool, tool_version, runtime_version, error_code, signature_id, environment_fingerprint, redacted_excerpt] := *failure_case{case_id, observed_at, tool, tool_version, runtime_version, error_code, signature_id, environment_fingerprint, redacted_excerpt}, signature_id == $signature_id\n:order -observed_at\n:limit ${boundedLimit}`,
        { signature_id: signatureId }
      );
    }
    if (errorCode) {
      return this.query(
        `?[case_id, observed_at, tool, tool_version, runtime_version, error_code, signature_id, environment_fingerprint, redacted_excerpt] := *failure_case{case_id, observed_at, tool, tool_version, runtime_version, error_code, signature_id, environment_fingerprint, redacted_excerpt}, error_code == $error_code, tool == $tool\n:order -observed_at\n:limit ${boundedLimit}`,
        { error_code: errorCode, tool }
      );
    }
    return [];
  }

  async inferReachableNodes(startNodeId, { edgeTypes, maxDepth = 5, limit = 100 } = {}) {
    if (!startNodeId) throw new TypeError("startNodeId is required.");
    const depth = Math.max(1, Math.min(10, Math.floor(Number(maxDepth) || 5)));
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    // Cozo's recursive rules perform graph closure inside the database. Depth is
    // bounded by policy via unrolled, parameterized rule layers.
    const rules = ["reachable_0[node] := *knowledge_edge{from_id: $start, to_id: node}"];
    for (let level = 1; level < depth; level++) {
      rules.push(`reachable_${level}[node] := reachable_${level - 1}[middle], *knowledge_edge{from_id: middle, to_id: node}`);
    }
    const allReachable = Array.from({ length: depth }, (_, i) => `?[node] := reachable_${i}[node]`).join("\n");
    const query = `${rules.join("\n")}\n${allReachable}\n:limit ${boundedLimit}`;
    const params = { start: startNodeId };
    return this.query(query, params);
  }

  async findSolutionsForHypothesis(hypothesisId, { limit = 20 } = {}) {
    if (!hypothesisId) throw new TypeError("hypothesisId is required.");
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)));
    return this.query(
      `?[solution_id, title, kind, action_spec_json, preconditions_json, postconditions_json, verification_json, rollback_json, risk_class, requires_approval, policy_version] := *solution{solution_id, hypothesis_id, title, kind, action_spec_json, preconditions_json, postconditions_json, verification_json, rollback_json, risk_class, requires_approval, policy_version, active}, hypothesis_id == $hypothesis_id, active == true\n:order -title\n:limit ${boundedLimit}`,
      { hypothesis_id: hypothesisId }
    );
  }

  async recordOutcome(outcome) {
    if (outcome.verified !== true && outcome.result === "verified-success") {
      throw new TypeError("A verified-success outcome must carry verified=true.");
    }
    return this.put("solution_outcome", outcome);
  }

  async close() {
    if (typeof this.db.close === "function") this.db.close();
    this.initialized = false;
  }
}

export async function openCozoKnowledgeStore({
  engine = "rocksdb",
  path = "nodehealer.cozo",
  options = {},
  CozoDb
} = {}) {
  let Constructor = CozoDb;
  if (!Constructor) {
    try {
      ({ CozoDb: Constructor } = await import("cozo-node"));
    } catch (cause) {
      const error = new Error("CozoDB native binding is unavailable. Install cozo-node for the current platform or inject a CozoDb-compatible instance.");
      error.cause = cause;
      throw error;
    }
  }
  const db = new Constructor(engine, path, options);
  return new CozoKnowledgeStore({ db });
}
