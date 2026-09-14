import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { prepareRequest, requestOnce } from "../src/request.js";

describe("request boundary", () => {
  it("normalizes a bounded JSON request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "x402-seal-request-"));
    const path = join(directory, "request.json");
    await writeFile(path, '{"value":1}');
    const request = await prepareRequest({
      url: "https://example.com/service#fragment",
      method: "post",
      dataPath: path,
      builderCode: "bc_fixture",
    });
    expect(request.url).toBe("https://example.com/service");
    expect(request.method).toBe("POST");
    expect(request.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["http://example.com", "HTTPS is required"],
    ["https://user:pass@example.com", "URL credentials are not allowed"],
  ])("rejects unsafe target %s", async (url, message) => {
    await expect(prepareRequest({ url })).rejects.toThrow(message);
  });

  it("allows explicit loopback HTTP", async () => {
    const request = await prepareRequest({ url: "http://127.0.0.1:3000/service", allowHttp: true });
    expect(request.url).toBe("http://127.0.0.1:3000/service");
  });

  it("rejects redirects", async () => {
    const request = await prepareRequest({ url: "https://example.com/service" });
    const fetcher = async () => new Response(null, { status: 302, headers: { location: "https://other.example" } });
    await expect(requestOnce(request, {}, fetcher as typeof fetch)).rejects.toThrow("Redirects are not allowed");
  });

  it("rejects oversized delivery", async () => {
    const request = await prepareRequest({ url: "https://example.com/service" });
    const fetcher = async () => new Response(new Uint8Array(1_048_577), { status: 200 });
    await expect(requestOnce(request, {}, fetcher as typeof fetch)).rejects.toThrow("Response body exceeds 1 MiB");
  });
});
