import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { digestEvidence, readEvidence, writeEvidence } from "../src/evidence.js";
import type { Evidence } from "../src/types.js";

const signer = privateKeyToAccount(`0x${"1".repeat(64)}`);

describe("evidence", () => {
  it("writes and verifies sanitized evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-evidence-"));
    const path = join(directory, "run.json");
    const result = await writeEvidence(baseEvidence(), signer, path);
    expect(result.evidence.integrity).toMatch(/^[0-9a-f]{64}$/);
    await expect(readEvidence(path)).resolves.toEqual(result.evidence);
    expect(await readFile(path, "utf8")).not.toContain("privateKey");
  });

  it("rejects modified evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-tamper-"));
    const path = join(directory, "run.json");
    await writeEvidence(baseEvidence(), signer, path);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.maxUsdc = "9";
    await writeFile(path, JSON.stringify(parsed));
    await expect(readEvidence(path)).rejects.toThrow("integrity check failed");
  });

  it("rejects internally inconsistent evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-inconsistent-"));
    const path = join(directory, "run.json");
    await writeEvidence({ ...baseEvidence(), maxUsdc: "0.0001" }, signer, path);
    await expect(readEvidence(path)).rejects.toThrow("terms are inconsistent");
  });

  it("rejects recomputed evidence without a matching payer signature", async () => {
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-forged-"));
    const path = join(directory, "run.json");
    await writeEvidence(baseEvidence(), signer, path);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    parsed.delivery.bodyHash = "f".repeat(64);
    const { integrity: _integrity, proof: _proof, ...unsigned } = parsed;
    const digest = digestEvidence(unsigned);
    parsed.integrity = digest;
    parsed.proof.digest = digest;
    await writeFile(path, JSON.stringify(parsed));
    await expect(readEvidence(path)).rejects.toThrow("Evidence signature is invalid");
  });
});

function baseEvidence(): Omit<Evidence, "integrity" | "proof"> {
  return {
    schema: "cultos.x402-seal.run.v1",
    version: "0.1.0",
    createdAt: "2026-09-14T18:30:00.000Z",
    request: { url: "https://example.com/service", method: "GET" },
    gate: {
      x402Version: 2,
      resourceUrl: "https://example.com/service",
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000",
      amountUsdc: "0.001",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 60,
      extensions: [],
    },
    payer: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
    authorizationNonce: `0x${"1".repeat(64)}`,
    maxUsdc: "0.001",
    settlement: {
      success: true,
      payer: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
      transaction: `0x${"a".repeat(64)}`,
      network: "eip155:8453",
      amount: "1000",
    },
    delivery: {
      status: 200,
      contentType: "application/json",
      bytes: 2,
      bodyHash: "0".repeat(64),
    },
    onchain: { verified: true, blockNumber: "1", transferMatched: true, authorizationMatched: true },
    verdict: "SEALED",
  };
}
