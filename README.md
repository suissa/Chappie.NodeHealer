# Chappie NodeHealer

A generic Node.js error-diagnosis and repair-proposal engine. It normalizes failures, extracts structured evidence, detects known semantic causes, and proposes evidence-backed actions. It does not execute shell commands unless the caller configures an executor and a user explicitly approves a candidate.

## Safety contract

- Terminal callbacks receive a summary and error ID rather than the raw log by default.
- The original error is returned by `heal()` only after the terminal interaction explicitly returns `show-error`.
- Commands are proposals, not shell execution. No command runs without a configured `apply` function and explicit approval.
- Uncertain or potentially incompatible changes require approval. Verification is separate and must succeed before status becomes `healed`.
- Research adapters receive minimized diagnostics. Treat logs and external search results as untrusted input.
- SemVer range evaluation delegates to the `semver` package and supports complete npm-style ranges. Invalid inputs remain unsupported rather than guessed.

## API

```js
import { NodeHealer, formatTerminalEvent } from "./src/index.mjs";

const healer = new NodeHealer({
  search: async (diagnostic) => [],
  onTerminal: async (event) => {
    console.log(formatTerminalEvent(event));
    return "defer"; // return "approve" or "show-error" only after explicit user input
  },
  apply: async (command) => { /* use a controlled executor */ },
  verify: async (command) => false
});

const result = await healer.heal(errorText);

// To choose the explicitly labelled workaround instead of the first candidate:
// await healer.heal(errorText, { candidateId: "npm-legacy-peer-deps-workaround" });
```

## Semantic ERESOLVE analysis

For npm peer dependency errors, NodeHealer extracts the resolving package, found package/version, peer range, whether the peer is optional, the declaring package, and any conflicting peer version.

It delegates SemVer parsing and range evaluation to the `semver` library instead of maintaining a partial parser. Full npm-style ranges (including caret, tilde, comparator sets and unions) are validated. For `>=3.0.260429-beta`, a candidate `3.0.260603-beta` is excluded by the prerelease gate because its `major.minor.patch` tuple differs from the comparator's prerelease tuple, even though the date-like components appear later. A stable release such as `3.0.260603` is not excluded by that gate. Invalid ranges and versions are marked unsupported instead of guessed.

When this cause is detected, candidates are ordered by risk:
1. Read-only investigation: `npm view nitro versions --json`.
2. Temporary workaround: `npm install --legacy-peer-deps`.

The second command bypasses strict peer dependency resolution and may install an incompatible dependency tree. It is not a durable fix. The durable resolution is to select a verified compatible stable version or correct the upstream `peerDependencies` range if the package supports the intended prereleases. Review the project's manifest and lockfile before changing versions. Neither command is executed by the built-in heuristic. Callers can select a candidate with `heal(error, { candidateId })`; invalid candidate IDs are rejected without executing anything.

## CozoDB knowledge store

The optional CozoDB adapter persists redacted failure cases, extracted evidence, signatures, root-cause hypotheses, causal edges, solution candidates, verification outcomes, and execution audit metadata. It retrieves similar failures and computes bounded graph reachability inside CozoDB. Knowledge retrieval is context for diagnosis; it never grants permission to execute a candidate.

Install the native binding when you want embedded persistence:

```sh
npm install
```

Example using a persistent RocksDB-backed Cozo instance:

```js
import { NodeHealer } from "./src/index.mjs";
import { openCozoKnowledgeStore } from "./src/knowledge/cozo-store.mjs";

const knowledgeStore = await openCozoKnowledgeStore({
  engine: "rocksdb",
  path: "./.nodehealer/knowledge.db"
});
await knowledgeStore.initialize();

const healer = new NodeHealer({
  knowledgeStore,
  onTerminal: async (event) => {
    // Render a concise summary and request explicit approval in your UI/terminal.
    console.log(event.summary);
    return "defer";
  }
});

try {
  const diagnosis = await healer.diagnose(errorText);
  console.log(diagnosis.knowledge.status, diagnosis.knowledge.similarCases.length);
} finally {
  await knowledgeStore.close();
}
```

You can also inject an existing CozoDb-compatible object ({ `run(query, params)` }) for tests or a managed database. The adapter uses bound parameters for values, a static relation allowlist, bounded result sizes, and a versioned migration ledger. Raw logs and secrets should not be stored; only the redacted excerpt and a fingerprint are persisted. If the database is unavailable, NodeHealer reports `knowledge.status = "unavailable"` and continues conservative local diagnosis without relaxing approval rules.

The schema reference is `src/knowledge/schema.cozo`; the adapter currently applies schema version 1. The test suite includes deterministic fake-client tests and a native integration test that runs when `cozo-node` can load on the current platform; otherwise that integration test is explicitly skipped. A persistent RocksDB deployment should still be exercised in the target environment before production use.

## Development and CI

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run demo
```

GitHub Actions runs the test suite on Node.js 20, 22, and 24 for pushes to `main` and `feat/**`, and on pull requests.
