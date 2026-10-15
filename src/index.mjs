import { createHash } from "node:crypto";

const redact = (text) => String(text)
  .replace(/(?:\/home\/[^\s/:]+|\/Users\/[^\s/:]+)\/(?:[^\s]+)?/g, "<redacted-path>")
  .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, "<redacted-secret>")
  .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");

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
  if (e.category === "dependency-resolution" && /@lovable\.dev\/vite-tanstack-config@2\.1\.1/.test(e.raw ?? e.sanitizedEvidence ?? "")) {
    return [{
      id: "npm-refresh-peer-resolution",
      confidence: "medium",
      rationale: "O npm pode excluir prereleases de versões diferentes da versão-base do comparador, mesmo quando parecem maiores. O caminho durável é usar uma versão estável compatível ou corrigir a faixa peerDependencies do pacote upstream. Este comando é apenas um workaround para confirmar a instalação; ele ignora a validação estrita de peers e exige aprovação explícita.",
      command: "npm install --legacy-peer-deps",
      destructive: false,
      requiresApproval: true,
      verification: "npm ls nitro @lovable.dev/vite-tanstack-config"
    }];
  }
  if (e.category === "dependency-resolution") return [{
    id: "inspect-peer-conflict",
    confidence: "low",
    rationale: "Inspecione as versões declaradas, os peerDependencies e o lockfile antes de alterar a árvore.",
    command: "npm ls",
    destructive: false,
    requiresApproval: true,
    verification: "npm ls"
  }];
  if (e.category === "runtime-version") return [{
    id: "inspect-runtime-requirements",
    confidence: "low",
    rationale: "Compare engines do package.json com as versões locais antes de trocar o runtime.",
    command: "node --version && npm --version",
    destructive: false,
    requiresApproval: true,
    verification: "node --version && npm --version"
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
    const researched = await this.search({ code: error.code, category: error.category, summary: error.summary, packages: error.packages });
    return { error: { id: error.id, code: error.code, category: error.category, summary: error.summary, fingerprint: error.fingerprint }, candidates: [...local, ...researched] };
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
