import { describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { parseGate, parseUsdc } from "../src/challenge.js";
import { fixture } from "./helpers.js";

describe("payment gate", () => {
  it("selects canonical Base USDC", async () => {
    const paymentRequired = await fixture();
    const result = parseGate(snapshot(paymentRequired), paymentRequired.resource.url, parseUsdc("0.001"));
    expect(result.record.amountUsdc).toBe("0.001");
    expect(result.record.appCode).toBe("bc_fixture");
  });

  it("refuses a quote above the ceiling", async () => {
    const paymentRequired = await fixture();
    expect(() => parseGate(snapshot(paymentRequired), paymentRequired.resource.url, parseUsdc("0.0001"))).toThrow("exceeds --max-usdc");
  });

  it.each([
    ["network", "eip155:84532"],
    ["scheme", "upto"],
    ["asset", "0x2222222222222222222222222222222222222222"],
  ])("refuses unsupported %s", async (field, value) => {
    const paymentRequired = await fixture();
    paymentRequired.accepts[0] = { ...paymentRequired.accepts[0]!, [field]: value };
    expect(() => parseGate(snapshot(paymentRequired), paymentRequired.resource.url)).toThrow("No exact Base USDC EIP-3009 option");
  });

  it("refuses a mismatched resource", async () => {
    const paymentRequired = await fixture();
    expect(() => parseGate(snapshot(paymentRequired), "https://example.com/other")).toThrow("does not match");
  });

  it("allows a server query when the requested route has none", async () => {
    const paymentRequired = await fixture();
    paymentRequired.resource.url = "https://example.com/service?path=service";
    expect(parseGate(snapshot(paymentRequired), "https://example.com/service").record.resourceUrl).toContain("?path=service");
  });

  it("binds a caller-supplied query exactly", async () => {
    const paymentRequired = await fixture();
    paymentRequired.resource.url = "https://example.com/service?mode=other";
    expect(() => parseGate(snapshot(paymentRequired), "https://example.com/service?mode=paid")).toThrow("does not match");
  });
});

function snapshot(paymentRequired: PaymentRequired) {
  return {
    status: 402,
    url: paymentRequired.resource.url,
    headers: new Headers({ "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) }),
    body: new Uint8Array(),
  };
}
