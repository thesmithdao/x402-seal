import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { describe, expect, it } from "vitest";
import { BASE_USDC } from "../src/challenge.js";
import { inspectReceiptLogs } from "../src/onchain.js";
import type { GateRecord } from "../src/types.js";

const payer = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const recipient = "0x1111111111111111111111111111111111111111";
const nonce = `0x${"1".repeat(64)}` as `0x${string}`;
const otherNonce = `0x${"2".repeat(64)}` as `0x${string}`;
const authorizationEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const gate: GateRecord = {
  x402Version: 2,
  resourceUrl: "https://example.com/service",
  scheme: "exact",
  network: "eip155:8453",
  asset: BASE_USDC,
  amount: "1000",
  amountUsdc: "0.001",
  payTo: recipient,
  maxTimeoutSeconds: 60,
  extensions: [],
};

function logs(authorizationNonce: `0x${string}` = nonce, amount = 1000n) {
  return [
    {
      address: BASE_USDC,
      topics: encodeEventTopics({ abi: [authorizationEvent], eventName: "AuthorizationUsed", args: { authorizer: payer, nonce: authorizationNonce } }) as readonly `0x${string}`[],
      data: "0x" as const,
    },
    {
      address: BASE_USDC,
      topics: encodeEventTopics({ abi: [transferEvent], eventName: "Transfer", args: { from: payer, to: recipient } }) as readonly `0x${string}`[],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    },
  ];
}

describe("Base settlement evidence", () => {
  it("matches the exact authorization and transfer", () => {
    expect(inspectReceiptLogs(logs(), gate, payer, nonce)).toEqual({
      verified: true,
      authorizationMatched: true,
      transferMatched: true,
    });
  });

  it("rejects an unrelated transaction with the same transfer terms", () => {
    const result = inspectReceiptLogs(logs(otherNonce), gate, payer, nonce);
    expect(result.verified).toBe(false);
    expect(result.authorizationMatched).toBe(false);
    expect(result.transferMatched).toBe(true);
  });

  it("rejects the right authorization with the wrong amount", () => {
    const result = inspectReceiptLogs(logs(nonce, 2000n), gate, payer, nonce);
    expect(result.verified).toBe(false);
    expect(result.authorizationMatched).toBe(true);
    expect(result.transferMatched).toBe(false);
  });
});
