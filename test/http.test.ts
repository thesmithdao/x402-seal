import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { invoke } from "../src/index.js";
import { fixture } from "./helpers.js";

it("runs the paid lifecycle over local HTTP", async () => {
  const paymentRequired = await fixture();
  const account = privateKeyToAccount(`0x${"4".repeat(64)}`);
  let paidCalls = 0;
  const server = createServer((request, response) => {
    if (!request.headers["payment-signature"]) {
      response.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      });
      response.end("{}");
      return;
    }
    paidCalls += 1;
    response.writeHead(200, {
      "content-type": "application/json",
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true,
        payer: account.address,
        transaction: `0x${"b".repeat(64)}`,
        network: "eip155:8453",
        amount: "1000",
      }),
    });
    response.end('{"result":"ok"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
    paymentRequired.resource.url = `http://127.0.0.1:${address.port}/service`;
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-http-"));
    const result = await invoke({
      url: paymentRequired.resource.url,
      allowHttp: true,
      maxUsdc: "0.001",
      getSigner: () => account,
      confirm: async () => true,
      output: join(directory, "evidence.json"),
      onchainVerifier: async () => ({ verified: true, blockNumber: "1", transferMatched: true, authorizationMatched: true }),
    });
    expect(result.evidence.verdict).toBe("SEALED");
    expect(paidCalls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
