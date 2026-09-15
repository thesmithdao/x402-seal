import type { Evidence, GateRecord, SealError } from "./types.js";

export function printGate(record: GateRecord, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ verdict: "READY", gate: record }, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    "X402 SEAL",
    "",
    row("GATE", "PASS", `${record.amountUsdc} USDC on Base`),
    row("PAYMENT", "READY", "exact / EIP-3009"),
    "",
    row("VERDICT", "READY", "safe to invoke"),
    "",
  ].join("\n"));
}

export function printEvidence(evidence: Evidence, path: string, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...evidence, evidence: path }, null, 2)}\n`);
    return;
  }
  const settlement = evidence.onchain?.verified ? "PASS" : evidence.verdict === "UNKNOWN" ? "UNKNOWN" : "FAIL";
  const delivery = evidence.delivery ? `${evidence.delivery.status} ${evidence.delivery.contentType}` : evidence.verdict === "PENDING" ? "pending" : "unavailable";
  process.stdout.write([
    "X402 SEAL",
    "",
    row("GATE", "PASS", `${evidence.gate.amountUsdc} USDC on Base`),
    row("PAYMENT", "PASS", "exact / EIP-3009"),
    row("SETTLEMENT", settlement, evidence.onchain?.verified ? "Base transfer matched" : "not independently confirmed"),
    row("DELIVERY", evidence.verdict === "SEALED" ? "PASS" : evidence.verdict === "PENDING" ? "PENDING" : "FAIL", delivery),
    "",
    row("VERDICT", evidence.verdict, evidence.reason ?? ""),
    row("EVIDENCE", path, ""),
    "",
  ].join("\n"));
}

export function printWitness(evidence: Evidence, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ valid: true, schema: evidence.schema, verdict: evidence.verdict }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`X402 SEAL\n\nWITNESS     PASS   payer signature and Base settlement\nVERDICT     ${evidence.verdict}\n`);
}

export function printFailure(error: SealError, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ verdict: error.boundary === "UNKNOWN" ? "UNKNOWN" : "REFUSED", boundary: error.boundary, reason: error.message })}\n`);
    return;
  }
  process.stderr.write(`X402 SEAL\n\n${error.boundary.padEnd(12)} FAIL   ${error.message}\nVERDICT     ${error.boundary === "UNKNOWN" ? "UNKNOWN" : "REFUSED"}\n`);
}

function row(label: string, state: string, detail: string): string {
  return `${label.padEnd(12)}${state.padEnd(7)}${detail}`.trimEnd();
}
