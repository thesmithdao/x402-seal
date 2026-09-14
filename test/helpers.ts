import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";

export async function fixture(): Promise<PaymentRequired> {
  const path = fileURLToPath(new URL("./fixtures/payment-required.json", import.meta.url));
  return JSON.parse(await readFile(path, "utf8")) as PaymentRequired;
}

export function challenge(value: PaymentRequired): Response {
  return new Response("{}", {
    status: 402,
    headers: {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader(value),
    },
  });
}

export function delivery(overrides: Partial<SettleResponse> = {}): Response {
  const settlement: SettleResponse = {
    success: true,
    payer: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
    transaction: `0x${"a".repeat(64)}`,
    network: "eip155:8453",
    amount: "1000",
    ...overrides,
  };
  return new Response('{"result":"ok"}', {
    status: 200,
    headers: {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement),
    },
  });
}
