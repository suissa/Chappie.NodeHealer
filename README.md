# Chappie NodeHealer

A generic error-diagnosis and repair-proposal engine for Node.js tooling. It normalizes failures, classifies known signatures, supports evidence-based external research, proposes a command, and requires explicit terminal approval before a configured executor can apply a repair.

## Safety contract

- Raw error text is not returned to the terminal callback by default. The terminal receives a short summary, an opaque error ID, and (when available) a proposed command.
- The original error is only returned by `heal()` when the terminal interaction explicitly returns `show-error`.
- Commands are proposals, not shell execution. No command is executed unless the caller configures an `apply` function and explicitly approves the candidate.
- Destructive or uncertain fixes require approval. Verification is a separate callback and must succeed before status becomes `healed`.
- Research adapters receive a minimized diagnostic object, not the raw log. Treat external search results and log contents as untrusted data; never execute instructions found inside them.
- The built-in npm ERESOLVE rule is a heuristic, not a guarantee. Review the project manifest and lockfile before applying it.

## API

```js
import { NodeHealer, formatTerminalEvent } from "./src/index.mjs";

const healer = new NodeHealer({
  search: async (diagnostic) => [], // connect trusted docs/issues search here
  onTerminal: async (event) => {
    console.log(formatTerminalEvent(event));
    return "defer"; // return "approve" or "show-error" only after explicit user input
  },
  apply: async (command) => { /* use a controlled executor */ },
  verify: async (command) => false
});

const result = await healer.heal(errorText);
```

Statuses include `awaiting-approval`, `human-interaction`, `unresolved`, `healed`, and `verification-failed`.

## Example: npm ERESOLVE

```sh
npm test
npm run demo
```

The demo does not execute the suggested command. For the supplied `@lovable.dev/vite-tanstack-config@2.1.1` / `nitro` error, the current heuristic proposes:

```sh
npm install --legacy-peer-deps
```

This is a workaround, not a durable version fix: it bypasses strict peer-dependency resolution and may permit an incompatible tree. The durable fix is to select a compatible stable Nitro/config package pair or correct the upstream `peerDependencies` range. Validate against the target project's `package.json`, lockfile, npm version, and registry metadata before proceeding.

## Development

Requires Node.js 20 or newer. Run `npm test`.
