import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { invoke } from "../src/index.js";
import { challenge, delivery, fixture } from "./helpers.js";

describe("paid lifecycle", () => {
  it("signs once, pays once, and seals useful delivery", async () => {
    const paymentRequired = await fixture();
    const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
    let signatures = 0;
    const signer = {
      address: account.address,
      signTypedData: async (parameters: Parameters<typeof account.signTypedData>[0]) => {
        signatures += 1;
        return account.signTypedData(parameters);
      },
    };
    const calls: Array<{ headers: Headers }> = [];
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ headers });
      if (calls.length === 1) return challenge(paymentRequired);
      return delivery({ payer: account.address });
    };
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-invoke-"));
    const result = await invoke({
      url: paymentRequired.resource.url,
      method: "POST",
      builderCode: "bc_buyer",
      maxUsdc: "0.001",
      getSigner: () => signer,
      confirm: async () => true,
      output: join(directory, "evidence.json"),
      fetcher: fetcher as typeof fetch,
    });
    expect(result.evidence.verdict).toBe("SEALED");
    expect(calls).toHaveLength(2);
    expect(signatures).toBe(1);
    expect(calls[0]?.headers.get("X-Builder-Code")).toBe("bc_buyer");
    expect(calls[1]?.headers.get("X-Builder-Code")).toBe("bc_buyer");
    const header = calls[1]?.headers.get("PAYMENT-SIGNATURE");
    expect(header).toBeTruthy();
    const payload = decodePaymentSignatureHeader(header!);
    expect((payload.extensions?.["builder-code"] as { info: { s: string[] } }).info.s).toContain("bc_buyer");
    expect(payload.extensions?.["payment-identifier"]).toBeTruthy();
  });

  it("does not sign or pay after cancellation", async () => {
    const paymentRequired = await fixture();
    const account = privateKeyToAccount(`0x${"2".repeat(64)}`);
    let calls = 0;
    let signatures = 0;
    const fetcher = async () => {
      calls += 1;
      return challenge(paymentRequired);
    };
    await expect(invoke({
      url: paymentRequired.resource.url,
      maxUsdc: "0.001",
      getSigner: () => ({
        address: account.address,
        signTypedData: async parameters => {
          signatures += 1;
          return account.signTypedData(parameters);
        },
      }),
      confirm: async () => false,
      fetcher: fetcher as typeof fetch,
    })).rejects.toThrow("Payment cancelled");
    expect(calls).toBe(1);
    expect(signatures).toBe(0);
  });

  it("records unknown without a second payment", async () => {
    const paymentRequired = await fixture();
    const account = privateKeyToAccount(`0x${"3".repeat(64)}`);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) return challenge(paymentRequired);
      throw new Error("connection lost");
    };
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-unknown-"));
    const result = await invoke({
      url: paymentRequired.resource.url,
      maxUsdc: "0.001",
      getSigner: () => account,
      confirm: async () => true,
      output: join(directory, "evidence.json"),
      fetcher: fetcher as typeof fetch,
    });
    expect(result.evidence.verdict).toBe("UNKNOWN");
    expect(calls).toBe(2);
  });
});
