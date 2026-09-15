import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { BUILDER_CODE_PATTERN } from "@x402/extensions/builder-code";
import { SealError, exitCodes, type Method, type RequestSpec, type ResponseSnapshot } from "./types.js";

const requestLimit = 65_536;
const responseLimit = 1_048_576;

export interface RequestOptions {
  url: string;
  method?: string;
  dataPath?: string;
  builderCode?: string;
  allowHttp?: boolean;
  timeoutMs?: number;
}

export async function prepareRequest(options: RequestOptions): Promise<RequestSpec> {
  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    throw new SealError("REQUEST", "Invalid target URL", exitCodes.REQUEST);
  }
  if (target.username || target.password) {
    throw new SealError("REQUEST", "URL credentials are not allowed", exitCodes.REQUEST);
  }
  if (target.protocol !== "https:") {
    const loopback = target.protocol === "http:" && isLoopback(target.hostname);
    if (!loopback || !options.allowHttp) {
      throw new SealError("REQUEST", "HTTPS is required", exitCodes.REQUEST);
    }
  }
  target.hash = "";
  const method = normalizeMethod(options.method);
  if (options.builderCode && !BUILDER_CODE_PATTERN.test(options.builderCode)) {
    throw new SealError("REQUEST", "Invalid Builder Code", exitCodes.REQUEST);
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new SealError("REQUEST", "Timeout must be between 1000 and 300000 ms", exitCodes.REQUEST);
  }
  if (method === "GET" && options.dataPath) {
    throw new SealError("REQUEST", "GET requests cannot include --data", exitCodes.REQUEST);
  }
  let body: string | undefined;
  let bodyHash: string | undefined;
  if (options.dataPath) {
    const buffer = await readFile(options.dataPath);
    if (buffer.byteLength > requestLimit) {
      throw new SealError("REQUEST", "Request body exceeds 64 KiB", exitCodes.REQUEST);
    }
    body = buffer.toString("utf8");
    try {
      JSON.parse(body);
    } catch {
      throw new SealError("REQUEST", "Request body is not valid JSON", exitCodes.REQUEST);
    }
    bodyHash = sha256(buffer);
  }
  return {
    url: target.toString(),
    method,
    ...(body === undefined ? {} : { body }),
    ...(bodyHash === undefined ? {} : { bodyHash }),
    ...(options.builderCode === undefined ? {} : { builderCode: options.builderCode }),
    timeoutMs,
  };
}

export async function requestOnce(
  spec: RequestSpec,
  paymentHeaders: Record<string, string> = {},
  fetcher: typeof fetch = fetch,
): Promise<ResponseSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  const headers = new Headers({ Accept: "application/json" });
  if (spec.body !== undefined) headers.set("Content-Type", "application/json");
  if (spec.builderCode) headers.set("X-Builder-Code", spec.builderCode);
  for (const [name, value] of Object.entries(paymentHeaders)) headers.set(name, value);
  let response: Response;
  try {
    response = await fetcher(spec.url, {
      method: spec.method,
      headers,
      ...(spec.body === undefined ? {} : { body: spec.body }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new SealError("POLICY", "Redirects are not allowed", exitCodes.POLICY);
    }
    const paymentRequired = response.headers.get("PAYMENT-REQUIRED") ?? response.headers.get("X-PAYMENT-REQUIRED");
    const paymentResponse = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
    if ((paymentRequired?.length ?? 0) > requestLimit || (paymentResponse?.length ?? 0) > requestLimit) {
      throw new SealError("CHALLENGE", "Payment header exceeds 64 KiB", exitCodes.CHALLENGE);
    }
    const body = await readBody(response, responseLimit);
    return { status: response.status, url: response.url || spec.url, headers: response.headers, body };
  } catch (error) {
    if (error instanceof SealError) throw error;
    const message = error instanceof Error && error.name === "AbortError" ? "Request timed out" : "Request failed";
    throw new SealError("UNKNOWN", message, exitCodes.UNKNOWN);
  } finally {
    clearTimeout(timer);
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeMethod(value?: string): Method {
  const method = (value ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new SealError("REQUEST", "Only GET and POST are supported", exitCodes.REQUEST);
  }
  return method;
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const normalized = hostname.replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

async function readBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SealError("DELIVERY", "Response body exceeds 1 MiB", exitCodes.DELIVERY);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
