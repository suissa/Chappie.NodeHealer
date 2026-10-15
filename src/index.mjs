import { createHash } from "node:crypto";

const redact = (text) => String(text)
  .replace(/(?:\/home\/[^\s/:]+|\/Users\/[^\s/:]+)\/(?:[^\s]+)?/g, "<redacted-path>")
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, "<redacted-secret>")
  .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");

function parseVersion(version) {
  const match = String(version ?? "").trim().replace(/^v/, "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], prerelease: match[4] ? match[4].split(".") : [] };
}

function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return +x < +y ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Intentionally handles only simple comparator ranges (currently >=, >, =, and exact
 * versions). Complex ranges are reported as unknown rather than guessed.
 */
export function analyzeSemverRange(range, version) {
  const candidate = parseVersion(version);
  const match = String(range ?? "").trim().match(/^(>=|>|=)?\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/);
  if (!candidate || !match) return { supported: false, compatible: null, prereleaseExcluded: false, reason: "Faixa SemVer complexa ou versão inválida; requer o resolvedor SemVer real." };
  const operator = match[1] || "=";
  const comparatorText = match[2].replace(/^v/, "");
  const comparator = parseVersion(comparatorText);
  const order = compareVersions(candidate, comparator);
  const comparatorAllowsPrerelease = candidate.major === comparator.major &&
    candidate.minor === comparator.minor &&
    candidate.patch === comparator.patch && comparator.prerelease.length > 0;
  const prereleaseExcluded = candidate.prerelease.length > 0 && !comparatorAllowsPrerelease;
  let compatible = operator === ">=" ? order >= 0 : operator === ">" ? order > 0 : order === 0;
  if (prereleaseExcluded) compatible = false;
  return {
    supported: true,
    compatible,
    prereleaseExcluded,
    reason: prereleaseExcluded
      ? "SemVer exclui prereleases de outra versão-base quando nenhum comparador da faixa menciona um prerelease dessa mesma versão-base."
      : compatible ? "A versão satisfaz o comparador simples analisado." : "A versão não satisfaz o comparador simples analisado."
  };
}

function extractDependencyEvidence(text) {
  const resolving = text.match(/While resolving:\s*([^\s]+)@([^\s]+)/i);
  const found = text.match(/Found:\s*([^\s@]+(?:\/[^\s@]+)?)@([^\s]+)/i);
  const peer = text.match(/peer(Optional)?\s+(@[^/\s]+\/[^@\s]+|[^@\s]+)\s+["']?([^"'\s]+)["']?\s+from\s+(@[^/\s]+\/[^@\s]+|[^@\s]+)@([^\s]+)/i);
  const conflicting = text.match(/Conflicting peer dependency:\s*([^\s@]+(?:\/[^\s@]+)?)@([^\s]+)/i);
  const dependencyName = peer?.[2] ?? conflicting?.[1] ?? found?.[1] ?? null;
  const requiredRange = peer?.[3] ?? null;
  const foundName = found?.[1] ?? null;
  const foundVersion = found?.[2] ?? null;
  const semver = requiredRange && foundVersion ? analyzeSemverRange(requiredRange, foundVersion) : null;
  return {
    resolvingPackage: resolving ? { name: resolving[1], version: resolving[2] } : null,
    found: found ? { name: found[1], version: found[2] } : null,
    peerDependency: peer ? {
      optional: Boolean(peer[1]),
      name: peer[2],
      range: peer[3],
      declaredBy: { name: peer[4], version: peer[5] }
    } : null,
    conflictingPeer: conflicting ? { name: conflicting[1], version: conflicting[2] } : null,
    semverAnalysis: semver ? { ...semver, dependency: dependencyName, observedVersion: foundVersion, requiredRange } : null
  };
}

export function normalizeError(input) {
  const raw = input instanceof Error ? `${input.name}: ${input.message}\n${input.stack ?? ""}` : String(input ?? "");
  const text = raw.replace(/\r\n/g, "\n").trim();
  const npmCode = text.match(/npm error code (E[A-Z0-9]+)/)?.[1] ?? text.match(/\b(ERESOLVE|ENOTFOUND|ECONNRESET|ETIMEDOUT|EACCES|ENOENT)\b/)?.[1] ?? null;
  const packageNames = [...new Set(text.match(/(?:@[-a-zA-Z0-9._]+\/)?[a-zA-Z0-9._-]+(?=@|@\d|\s|$)/g) ?? [])]
    .filter((name) => name.length < 120 && !["npm", "error", "node_modules", "dev"].includes(name));
  return {
    id: createHash("sha256").update(text).digest("hex").slice(0, 16),
    code: npmCode,
    category: classify(text, npmCode),
    summary: summarize(text, npmCode),
    packages: packageNames,
    dependencyEvidence: extractDependencyEvidence(text),
    fingerprint: createHash("sha256").update(`${npmCode ?? "UNKNOWN"}:\n${text.replace(/\d{4}-\d{2}-\d{2}T[\d:.Z-]+/g, "<timestamp>")}`).digest("hex"),
    sanitizedEvidence: redact(text).slice(0, 12000),
    raw: text
  };
}

function classify(text, code) {
  if (code === "ERESOLVE" || /could not resolve dependency|peer dependency/i.test(text)) return "dependency-resolution";
  if (/unsupported engine|requires node|EBADENGINE/i.test(text)) return "runtime-version";
  if (/command not found|is not recognized/i.test(text)) return "missing-command";
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(text)) return "network";
  if (/EACCES|permission denied/i.test(text)) return "permissions";
  if (/ENOENT|no such file or directory/i.test(text)) return "missing-file";
  return "unknown";
}
function summarize(text, code) {
  if (code === "ERESOLVE") return "O npm não conseguiu resolver a árvore de dependências.";
  if (/EBADENGINE|unsupported engine/i.test(text)) return "A versão do Node.js ou npm não atende aos requisitos do projeto.";
  if (/EACCES|permission denied/i.test(text)) return "A operação encontrou uma restrição de permissão.";
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(text)) return "A operação falhou durante uma conexão de rede.";
  return "Erro detectado; causa e correção ainda precisam ser verificadas.";
}

export function proposeRepairs(error) {
  const e = typeof error === "string" ? normalizeError(error) : error;
  const evidence = e.dependencyEvidence;
  if (e.category === "dependency-resolution" && evidence?.semverAnalysis?.prereleaseExcluded) {
    const packageName = evidence.peerDependency?.name;
    const safePackageName = typeof packageName === "string" && /^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/i.test(packageName) ? packageName : null;
    const inspectCommand = safePackageName ? \`npm view \${safePackageName} versions --json\` : "npm ls";
    return [
      {
        id: "inspect-compatible-stable-versions",
        confidence: "high",
        rationale: `A dependência ${evidence.peerDependency?.name ?? evidence.semverAnalysis.dependency} declara a faixa ${evidence.semverAnalysis.requiredRange}, mas a versão observada ${evidence.semverAnalysis.observedVersion} é prerelease de outra versão-base. ${evidence.semverAnalysis.reason} Verifique versões estáveis disponíveis e a declaração upstream antes de alterar o lockfile.`,
        command: inspectCommand,
        destructive: false,
        requiresApproval: true,
        verification: "npm ls nitro @lovable.dev/vite-tanstack-config",
        kind: "read-only-investigation"
      },
      {
        id: "npm-legacy-peer-deps-workaround",
        confidence: "medium",
        rationale: "Contorno temporário: desativa a resolução estrita de peer dependencies; pode instalar uma árvore incompatível. Use somente se aceitar esse risco.",
        command: "npm install --legacy-peer-deps",
        destructive: false,
        requiresApproval: true,
        verification: "npm ls nitro @lovable.dev/vite-tanstack-config",
        kind: "workaround"
      }
    ];
  }
  if (e.category === "dependency-resolution") return [{
    id: "inspect-peer-conflict",
    confidence: "low",
    rationale: "Inspecione as versões declaradas, os peerDependencies e o lockfile antes de alterar a árvore.",
    command: "npm ls",
    destructive: false,
    requiresApproval: true,
    verification: "npm ls",
    kind: "read-only-investigation"
  }];
  if (e.category === "runtime-version") return [{
    id: "inspect-runtime-requirements",
    confidence: "low",
    rationale: "Compare engines do package.json com as versões locais antes de trocar o runtime.",
    command: "node --version && npm --version",
    destructive: false,
    requiresApproval: true,
    verification: "node --version && npm --version",
    kind: "read-only-investigation"
  }];
  return [];
}

export class NodeHealer {
  constructor({ search = async () => [], apply = async () => { throw new Error("No repair executor configured"); }, verify = async () => false, onTerminal = async () => "defer" } = {}) {
    this.search = search;
    this.apply = apply;
    this.verify = verify;
    this.onTerminal = onTerminal;
  }

  async diagnose(input) {
    const error = normalizeError(input);
    const local = proposeRepairs(error);
    const researched = await this.search({ code: error.code, category: error.category, summary: error.summary, packages: error.packages, dependencyEvidence: error.dependencyEvidence });
    return { error: { id: error.id, code: error.code, category: error.category, summary: error.summary, fingerprint: error.fingerprint, dependencyEvidence: error.dependencyEvidence }, candidates: [...local, ...researched] };
  }

  async heal(input, { autoApply = false } = {}) {
    const diagnosis = await this.diagnose(input);
    if (!diagnosis.candidates.length) {
      const choice = await this.onTerminal({ status: "needs-human", summary: diagnosis.error.summary, errorId: diagnosis.error.id });
      return { status: choice === "show-error" ? "human-interaction" : "unresolved", diagnosis, rawError: choice === "show-error" ? String(input) : undefined };
    }
    const candidate = diagnosis.candidates[0];
    if (!autoApply || candidate.requiresApproval || candidate.destructive) {
      const choice = await this.onTerminal({ status: "repair-proposed", summary: diagnosis.error.summary, command: candidate.command, rationale: candidate.rationale, errorId: diagnosis.error.id });
      if (choice !== "approve") return { status: choice === "show-error" ? "human-interaction" : "awaiting-approval", diagnosis, rawError: choice === "show-error" ? String(input) : undefined };
    }
    const applied = await this.apply(candidate.command, { candidate, diagnosis });
    const verified = await this.verify(candidate.verification, { candidate, diagnosis, applied });
    return { status: verified ? "healed" : "verification-failed", diagnosis, command: candidate.command, verification: candidate.verification };
  }
}

export function formatTerminalEvent(event) {
  if (event.status === "repair-proposed") return [
    "NodeHealer identificou uma possível correção.",
    `Causa: ${event.summary}`,
    `Comando sugerido: ${event.command}`,
    `Justificativa: ${event.rationale}`,
    "Digite 'aprovar' para autorizar, 'erro' para exibir o log original ou 'adiar'."
  ].join("\n");
  return `NodeHealer: ${event.summary}\nID: ${event.errorId}\nDigite 'erro' para exibir o log original ou 'adiar'.`;
}
