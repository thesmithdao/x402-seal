import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAddress } from "viem";
import { BASE_NETWORK, BASE_USDC, formatUsdc, parseUsdc } from "./challenge.js";
import { sha256 } from "./request.js";
import { verifyStoredAttestations } from "./attestation.js";
import { SealError, exitCodes, type Evidence } from "./types.js";

const evidenceLimit = 262_144;

export async function writeEvidence(evidence: Omit<Evidence, "integrity">, output?: string): Promise<{ evidence: Evidence; path: string }> {
  const complete: Evidence = { ...evidence, integrity: digestEvidence(evidence) };
  const path = output ? resolve(output) : await defaultEvidencePath(evidence.createdAt);
  await ensureDirectory(dirname(path));
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(complete, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return { evidence: complete, path };
}

export async function readEvidence(path: string): Promise<Evidence> {
  const buffer = await readFile(resolve(path));
  if (buffer.byteLength > evidenceLimit) {
    throw new SealError("REQUEST", "Evidence file exceeds 256 KiB", exitCodes.REQUEST);
  }
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new SealError("REQUEST", "Evidence file is not valid JSON", exitCodes.REQUEST);
  }
  if (!isEvidence(value)) {
    throw new SealError("REQUEST", "Evidence schema is invalid", exitCodes.REQUEST);
  }
  const { integrity, ...unsigned } = value;
  if (digestEvidence(unsigned) !== integrity) {
    throw new SealError("REQUEST", "Evidence integrity check failed", exitCodes.REQUEST);
  }
  try {
    validateConsistency(value);
  } catch (error) {
    if (error instanceof SealError) throw error;
    invalid();
  }
  if (value.attestation && !await verifyStoredAttestations(value.attestation)) {
    throw new SealError("REQUEST", "Stored attestation signature is invalid", exitCodes.REQUEST);
  }
  return value;
}

export function digestEvidence(value: unknown): string {
  return sha256(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

async function defaultEvidencePath(createdAt: string): Promise<string> {
  const root = join(homedir(), ".x402-seal");
  await ensureDirectory(root);
  const runs = join(root, "runs");
  await ensureDirectory(runs);
  return join(runs, `${createdAt.replaceAll(":", "").replaceAll(".", "-")}.json`);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SealError("REQUEST", "Evidence directory is not trusted", exitCodes.REQUEST);
    }
  } catch (error) {
    if (error instanceof SealError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: false, mode: 0o700 });
  }
}

function isEvidence(value: unknown): value is Evidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.schema !== "cultos.x402-seal.run.v1") return false;
  if (typeof item.version !== "string" || typeof item.createdAt !== "string") return false;
  if (typeof item.integrity !== "string" || !/^[0-9a-f]{64}$/.test(item.integrity)) return false;
  if (!item.request || typeof item.request !== "object" || Array.isArray(item.request)) return false;
  if (!item.gate || typeof item.gate !== "object" || Array.isArray(item.gate)) return false;
  if (typeof item.payer !== "string" || typeof item.maxUsdc !== "string") return false;
  return item.verdict === "SEALED" || item.verdict === "PENDING" || item.verdict === "REFUSED" || item.verdict === "UNKNOWN";
}

function validateConsistency(evidence: Evidence): void {
  if (!Number.isFinite(Date.parse(evidence.createdAt))) invalid();
  if (!/^https:\/\//.test(evidence.request.url)) invalid();
  if (evidence.request.bodyHash && !/^[0-9a-f]{64}$/.test(evidence.request.bodyHash)) invalid();
  if (evidence.gate.x402Version !== 2 || evidence.gate.scheme !== "exact" || evidence.gate.network !== BASE_NETWORK) invalid();
  if (evidence.gate.asset.toLowerCase() !== BASE_USDC.toLowerCase()) invalid();
  if (!isAddress(evidence.gate.payTo) || !/^[1-9]\d*$/.test(evidence.gate.amount)) invalid();
  if (formatUsdc(evidence.gate.amount) !== evidence.gate.amountUsdc) invalid();
  if (parseUsdc(evidence.maxUsdc) < BigInt(evidence.gate.amount)) invalid();
  if (!isAddress(evidence.payer)) invalid();
  if (evidence.verdict === "SEALED") {
    if (!evidence.settlement?.success || !evidence.delivery) invalid();
    if (evidence.delivery.status < 200 || evidence.delivery.status >= 300 || evidence.delivery.status === 202) invalid();
    if (evidence.delivery.bytes <= 0 || !/^[0-9a-f]{64}$/.test(evidence.delivery.bodyHash)) invalid();
    if (evidence.delivery.contentType !== "application/json" && !evidence.delivery.contentType.endsWith("+json")) invalid();
  }
  if (evidence.settlement) {
    if (evidence.settlement.network !== BASE_NETWORK) invalid();
    if (evidence.settlement.success && !/^0x[0-9a-fA-F]{64}$/.test(evidence.settlement.transaction)) invalid();
    if (evidence.settlement.payer && evidence.settlement.payer.toLowerCase() !== evidence.payer.toLowerCase()) invalid();
    if (evidence.settlement.amount && evidence.settlement.amount !== evidence.gate.amount) invalid();
  }
  if (evidence.onchain?.verified && evidence.onchain.transferMatched !== true) invalid();
}

function invalid(): never {
  throw new SealError("REQUEST", "Evidence terms are inconsistent", exitCodes.REQUEST);
}
