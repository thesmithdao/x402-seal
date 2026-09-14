import { getAddress, isAddress } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { SealError, exitCodes, type GateRecord, type GateResult, type ResponseSnapshot } from "./types.js";

export const BASE_NETWORK = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const parser = new x402HTTPClient(new x402Client());

export function parseGate(snapshot: ResponseSnapshot, requestUrl: string, maxAtomic?: bigint): GateResult {
  if (snapshot.status !== 402) {
    throw new SealError("CHALLENGE", `Expected 402, received ${snapshot.status}`, exitCodes.CHALLENGE);
  }
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = parser.getPaymentRequiredResponse(name => snapshot.headers.get(name));
  } catch {
    throw new SealError("CHALLENGE", "Malformed x402 payment challenge", exitCodes.CHALLENGE);
  }
  if (paymentRequired.x402Version !== 2) {
    throw new SealError("POLICY", `Unsupported x402 version ${paymentRequired.x402Version}`, exitCodes.POLICY);
  }
  if (!sameResource(paymentRequired.resource.url, requestUrl)) {
    throw new SealError("POLICY", "Challenge resource does not match the request", exitCodes.POLICY);
  }
  const compatible = paymentRequired.accepts.filter(isCompatible);
  if (compatible.length === 0) {
    throw new SealError("POLICY", "No exact Base USDC EIP-3009 option", exitCodes.POLICY);
  }
  const affordable = maxAtomic === undefined ? compatible : compatible.filter(item => BigInt(item.amount) <= maxAtomic);
  if (affordable.length === 0) {
    throw new SealError("POLICY", "Quoted price exceeds --max-usdc", exitCodes.POLICY);
  }
  const selected = [...affordable].sort((a, b) => compareAmount(a.amount, b.amount))[0];
  if (!selected) {
    throw new SealError("POLICY", "No compatible payment option", exitCodes.POLICY);
  }
  const extensions = Object.keys(paymentRequired.extensions ?? {}).sort();
  const appCode = readAppCode(paymentRequired.extensions?.["builder-code"]);
  const record: GateRecord = {
    x402Version: 2,
    resourceUrl: paymentRequired.resource.url,
    ...(paymentRequired.resource.serviceName ? { serviceName: paymentRequired.resource.serviceName } : {}),
    ...(paymentRequired.resource.description ? { description: paymentRequired.resource.description } : {}),
    scheme: selected.scheme,
    network: selected.network,
    asset: getAddress(selected.asset),
    amount: selected.amount,
    amountUsdc: formatUsdc(selected.amount),
    payTo: getAddress(selected.payTo),
    maxTimeoutSeconds: selected.maxTimeoutSeconds,
    extensions,
    ...(appCode ? { appCode } : {}),
  };
  return { paymentRequired, selected, record };
}

export function parseUsdc(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new SealError("REQUEST", "--max-usdc must be a positive decimal with at most 6 places", exitCodes.REQUEST);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (units <= 0n) {
    throw new SealError("REQUEST", "--max-usdc must be greater than zero", exitCodes.REQUEST);
  }
  return units;
}

export function formatUsdc(amount: string): string {
  const units = BigInt(amount);
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function sameRequirement(left: PaymentRequirements, right: PaymentRequirements): boolean {
  return left.scheme === right.scheme
    && left.network === right.network
    && left.asset.toLowerCase() === right.asset.toLowerCase()
    && left.amount === right.amount
    && left.payTo.toLowerCase() === right.payTo.toLowerCase()
    && left.maxTimeoutSeconds === right.maxTimeoutSeconds
    && transferMethod(left) === transferMethod(right);
}

function isCompatible(requirement: PaymentRequirements): boolean {
  if (requirement.scheme !== "exact" || requirement.network !== BASE_NETWORK) return false;
  if (!isAddress(requirement.asset) || requirement.asset.toLowerCase() !== BASE_USDC.toLowerCase()) return false;
  if (!isAddress(requirement.payTo)) return false;
  if (!/^[1-9]\d*$/.test(requirement.amount)) return false;
  if (!Number.isInteger(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds <= 0) return false;
  if (transferMethod(requirement) !== "eip3009") return false;
  const flow = requirement.extra?.paymentFlow;
  return flow === undefined || flow === "authorization";
}

function transferMethod(requirement: PaymentRequirements): string {
  const value = requirement.extra?.assetTransferMethod;
  return typeof value === "string" ? value : "eip3009";
}

function compareAmount(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameResource(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = "";
    b.hash = "";
    if (a.origin !== b.origin || a.pathname !== b.pathname) return false;
    return b.search === "" || a.search === b.search;
  } catch {
    return false;
  }
}

function readAppCode(extension: unknown): string | undefined {
  if (!extension || typeof extension !== "object" || Array.isArray(extension)) return undefined;
  const info = (extension as Record<string, unknown>).info;
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const code = (info as Record<string, unknown>).a;
  return typeof code === "string" ? code : undefined;
}
