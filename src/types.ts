import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";

export type Method = "GET" | "POST";

export type Boundary =
  | "REQUEST"
  | "CHALLENGE"
  | "POLICY"
  | "SIGNER"
  | "SETTLEMENT"
  | "DELIVERY"
  | "UNKNOWN";

export type Verdict = "READY" | "SEALED" | "PENDING" | "REFUSED" | "UNKNOWN";

export interface RequestSpec {
  url: string;
  method: Method;
  body?: string;
  bodyHash?: string;
  builderCode?: string;
  timeoutMs: number;
}

export interface ResponseSnapshot {
  status: number;
  url: string;
  headers: Headers;
  body: Uint8Array;
}

export interface GateResult {
  paymentRequired: PaymentRequired;
  selected: PaymentRequirements;
  record: GateRecord;
}

export interface GateRecord {
  x402Version: number;
  resourceUrl: string;
  serviceName?: string;
  description?: string;
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  amountUsdc: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extensions: string[];
  appCode?: string;
}

export interface OnchainRecord {
  verified: boolean;
  blockNumber?: string;
  transferMatched?: boolean;
  authorizationMatched?: boolean;
  reason?: string;
}

export interface SettlementRecord {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  amount?: string;
  errorReason?: string;
}

export interface EvidenceProof {
  scheme: "eip712";
  signer: string;
  digest: string;
  signature: string;
}

export interface AttestationRecord {
  offers: number;
  offerVerified: boolean;
  receiptPresent: boolean;
  receiptVerified: boolean;
  signerAuthorizationVerified: false;
  offer?: unknown;
  receipt?: unknown;
}

export interface Evidence {
  schema: "cultos.x402-seal.run.v1";
  version: string;
  createdAt: string;
  request: {
    url: string;
    method: Method;
    bodyHash?: string;
    builderCode?: string;
  };
  gate: GateRecord;
  payer: string;
  authorizationNonce: string;
  maxUsdc: string;
  settlement?: SettlementRecord;
  delivery?: {
    status: number;
    contentType: string;
    bytes: number;
    bodyHash: string;
  };
  attestation?: AttestationRecord;
  onchain?: OnchainRecord;
  verdict: Verdict;
  boundary?: Boundary;
  reason?: string;
  proof: EvidenceProof;
  integrity: string;
}

export interface RunResult {
  evidence: Evidence;
  path: string;
}

export class SealError extends Error {
  readonly boundary: Boundary;
  readonly exitCode: number;

  constructor(boundary: Boundary, message: string, exitCode: number) {
    super(message);
    this.name = "SealError";
    this.boundary = boundary;
    this.exitCode = exitCode;
  }
}

export const exitCodes: Record<Boundary, number> = {
  REQUEST: 2,
  CHALLENGE: 3,
  POLICY: 4,
  SIGNER: 5,
  SETTLEMENT: 6,
  DELIVERY: 7,
  UNKNOWN: 8,
};
