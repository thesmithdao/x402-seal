import type { ClientEvmSigner } from "@x402/evm";
import type { SettleResponse } from "@x402/core/types";
import { inspectAttestations, inspectOffers } from "./attestation.js";
import { parseGate, parseUsdc } from "./challenge.js";
import { readEvidence, writeEvidence } from "./evidence.js";
import { DEFAULT_BASE_RPC, verifyOnchain } from "./onchain.js";
import { createPayment } from "./payment.js";
import { prepareRequest, requestOnce, sha256, type RequestOptions } from "./request.js";
import { SealError, exitCodes, type Evidence, type GateResult, type RunResult } from "./types.js";

export interface GateOptions extends RequestOptions {
  fetcher?: typeof fetch;
}

export interface InvokeOptions extends RequestOptions {
  maxUsdc: string;
  getSigner: () => ClientEvmSigner | Promise<ClientEvmSigner>;
  confirm: (gate: GateResult["record"]) => Promise<boolean>;
  rpcUrl?: string;
  output?: string;
  fetcher?: typeof fetch;
  onchainVerifier?: typeof verifyOnchain;
}

export async function gate(options: GateOptions): Promise<GateResult> {
  const request = await prepareRequest(options);
  const response = await requestOnce(request, {}, options.fetcher ?? fetch);
  return parseGate(response, request.url);
}

export async function invoke(options: InvokeOptions): Promise<RunResult> {
  const maxAtomic = parseUsdc(options.maxUsdc);
  const request = await prepareRequest(options);
  const unpaid = await requestOnce(request, {}, options.fetcher ?? fetch);
  const gateResult = parseGate(unpaid, request.url, maxAtomic);
  const offers = await inspectOffers(gateResult.paymentRequired, gateResult.selected);
  if (!offers.verified) {
    throw new SealError("POLICY", "Signed offer could not be verified", exitCodes.POLICY);
  }
  if (!await options.confirm(gateResult.record)) {
    throw new SealError("SIGNER", "Payment cancelled", exitCodes.SIGNER);
  }
  const signer = await options.getSigner();
  const material = await createPayment(
    gateResult.paymentRequired,
    gateResult.selected,
    options.maxUsdc,
    signer,
    request.builderCode,
  );
  const base = baseEvidence(request, gateResult, material.payer, material.authorizationNonce, options.maxUsdc);
  let paid;
  try {
    paid = await requestOnce(request, material.headers, options.fetcher ?? fetch);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Paid request result is unknown";
    return persist({ ...base, verdict: "UNKNOWN", boundary: "UNKNOWN", reason }, signer, options.output);
  }
  let settlement;
  try {
    settlement = material.httpClient.getPaymentSettleResponse(name => paid.headers.get(name));
  } catch {
    return persist({ ...base, verdict: "UNKNOWN", boundary: "UNKNOWN", reason: "Settlement response is missing or invalid" }, signer, options.output);
  }
  const settlementProblem = validateSettlement(settlement, material.payer, gateResult.selected.amount);
  const settlementRecord = recordSettlement(settlement);
  if (settlementProblem) {
    return persist({ ...base, settlement: settlementRecord, verdict: "REFUSED", boundary: "SETTLEMENT", reason: settlementProblem }, signer, options.output);
  }
  const response = new Response(null, { status: paid.status, headers: paid.headers });
  let attestation;
  try {
    attestation = await inspectAttestations(gateResult.paymentRequired, gateResult.selected, response, material.payer);
  } catch {
    return persist({ ...base, settlement: settlementRecord, verdict: "UNKNOWN", boundary: "UNKNOWN", reason: "Attestation response could not be verified" }, signer, options.output);
  }
  const onchainVerifier = options.onchainVerifier ?? verifyOnchain;
  const onchain = await onchainVerifier(settlementRecord, gateResult.record, material.payer, material.authorizationNonce, options.rpcUrl ?? DEFAULT_BASE_RPC);
  if (!onchain.verified) {
    const boundary = onchain.transferMatched === false ? "SETTLEMENT" : "UNKNOWN";
    return persist({
      ...base,
      settlement: settlementRecord,
      attestation,
      onchain,
      verdict: boundary === "UNKNOWN" ? "UNKNOWN" : "REFUSED",
      boundary,
      reason: onchain.reason ?? "Onchain verification failed",
    }, signer, options.output);
  }
  const delivery = deliveryRecord(paid);
  if (paid.status === 202) {
    return persist({ ...base, settlement: settlementRecord, delivery, attestation, onchain, verdict: "PENDING", boundary: "DELIVERY", reason: "Delivery is asynchronous" }, signer, options.output);
  }
  const deliveryProblem = validateDelivery(paid, delivery);
  if (deliveryProblem) {
    return persist({ ...base, settlement: settlementRecord, delivery, attestation, onchain, verdict: "REFUSED", boundary: "DELIVERY", reason: deliveryProblem }, signer, options.output);
  }
  if (attestation.receiptPresent && !attestation.receiptVerified) {
    return persist({ ...base, settlement: settlementRecord, delivery, attestation, onchain, verdict: "REFUSED", boundary: "DELIVERY", reason: "Signed receipt could not be verified" }, signer, options.output);
  }
  return persist({ ...base, settlement: settlementRecord, delivery, attestation, onchain, verdict: "SEALED" }, signer, options.output);
}

export async function witness(path: string, rpcUrl?: string): Promise<Evidence> {
  const evidence = await readEvidence(path);
  if (evidence.verdict === "SEALED" && evidence.settlement) {
    const result = await verifyOnchain(evidence.settlement, evidence.gate, evidence.payer, evidence.authorizationNonce, rpcUrl ?? DEFAULT_BASE_RPC);
    if (!result.verified) {
      throw new SealError(result.transferMatched === false ? "SETTLEMENT" : "UNKNOWN", result.reason ?? "Onchain verification failed", result.transferMatched === false ? exitCodes.SETTLEMENT : exitCodes.UNKNOWN);
    }
    return { ...evidence, onchain: result };
  }
  return evidence;
}

function baseEvidence(
  request: Awaited<ReturnType<typeof prepareRequest>>,
  gateResult: GateResult,
  payer: string,
  authorizationNonce: string,
  maxUsdc: string,
): Omit<Evidence, "integrity" | "proof" | "verdict"> {
  return {
    schema: "cultos.x402-seal.run.v1",
    version: "0.1.1",
    createdAt: new Date().toISOString(),
    request: {
      url: request.url,
      method: request.method,
      ...(request.bodyHash ? { bodyHash: request.bodyHash } : {}),
      ...(request.builderCode ? { builderCode: request.builderCode } : {}),
    },
    gate: gateResult.record,
    payer,
    authorizationNonce,
    maxUsdc,
  };
}

async function persist(evidence: Omit<Evidence, "integrity" | "proof">, signer: ClientEvmSigner, output?: string): Promise<RunResult> {
  return writeEvidence(evidence, signer, output);
}

function validateSettlement(settlement: SettleResponse, payer: string, amount: string): string | undefined {
  if (!settlement.success) return cleanReason(settlement.errorReason);
  if (settlement.network !== "eip155:8453") return "Settlement network does not match the quote";
  if (!/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)) return "Settlement transaction is invalid";
  if (settlement.payer && settlement.payer.toLowerCase() !== payer.toLowerCase()) return "Settlement payer does not match the signer";
  if (settlement.amount && settlement.amount !== amount) return "Settled amount does not match the quote";
  return undefined;
}

function recordSettlement(settlement: SettleResponse): NonNullable<Evidence["settlement"]> {
  return {
    success: settlement.success,
    transaction: settlement.transaction,
    network: settlement.network,
    ...(settlement.payer ? { payer: settlement.payer } : {}),
    ...(settlement.amount ? { amount: settlement.amount } : {}),
    ...(settlement.errorReason ? { errorReason: cleanReason(settlement.errorReason) } : {}),
  };
}

function cleanReason(value?: string): string {
  if (!value) return "Settlement failed";
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "Settlement failed";
}

function deliveryRecord(response: Awaited<ReturnType<typeof requestOnce>>): NonNullable<Evidence["delivery"]> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return {
    status: response.status,
    contentType,
    bytes: response.body.byteLength,
    bodyHash: sha256(response.body),
  };
}

function validateDelivery(response: Awaited<ReturnType<typeof requestOnce>>, delivery: NonNullable<Evidence["delivery"]>): string | undefined {
  if (response.status < 200 || response.status >= 300) return `Paid request returned ${response.status}`;
  if (delivery.contentType !== "application/json" && !delivery.contentType.endsWith("+json")) return "Paid response is not JSON";
  if (delivery.bytes === 0) return "Paid response is empty";
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body));
    if (value === null) return "Paid response is empty";
  } catch {
    return "Paid response contains invalid JSON";
  }
  return undefined;
}

export { parseUsdc, prepareRequest };
export type { Evidence, GateRecord, RunResult } from "./types.js";
