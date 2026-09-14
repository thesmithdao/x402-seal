#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { privateKeyToAccount } from "viem/accounts";
import { gate, invoke, witness } from "./index.js";
import { printEvidence, printFailure, printGate, printWitness } from "./output.js";
import { SealError, exitCodes, type GateRecord } from "./types.js";

interface CliOptions {
  command: string;
  target?: string;
  method?: string;
  dataPath?: string;
  maxUsdc?: string;
  builderCode?: string;
  timeoutMs?: number;
  rpcUrl?: string;
  output?: string;
  allowHttp: boolean;
  json: boolean;
  yes: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(help);
    return;
  }
  if (options.command === "version") {
    process.stdout.write("0.1.0\n");
    return;
  }
  if (!options.target) throw new SealError("REQUEST", "Target is required", exitCodes.REQUEST);
  if (options.command === "gate") {
    const result = await gate({
      url: options.target,
      ...(options.method ? { method: options.method } : {}),
      ...(options.dataPath ? { dataPath: options.dataPath } : {}),
      ...(options.builderCode ? { builderCode: options.builderCode } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      allowHttp: options.allowHttp,
    });
    printGate(result.record, options.json);
    return;
  }
  if (options.command === "invoke") {
    if (!options.maxUsdc) throw new SealError("REQUEST", "--max-usdc is required", exitCodes.REQUEST);
    const result = await invoke({
      url: options.target,
      ...(options.method ? { method: options.method } : {}),
      ...(options.dataPath ? { dataPath: options.dataPath } : {}),
      ...(options.builderCode ? { builderCode: options.builderCode } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
      ...(options.output ? { output: options.output } : {}),
      allowHttp: options.allowHttp,
      maxUsdc: options.maxUsdc,
      getSigner: () => loadSigner(),
      confirm: record => confirmPayment(record, options.yes),
    });
    printEvidence(result.evidence, result.path, options.json);
    if (result.evidence.verdict !== "SEALED") process.exitCode = result.evidence.boundary ? exitCodes[result.evidence.boundary] : 1;
    return;
  }
  if (options.command === "witness") {
    const evidence = await witness(options.target, options.rpcUrl);
    printWitness(evidence, options.json);
    return;
  }
  throw new SealError("REQUEST", `Unknown command: ${options.command}`, exitCodes.REQUEST);
}

function loadSigner() {
  const key = process.env.X402_SEAL_EVM_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new SealError("SIGNER", "Set X402_SEAL_EVM_KEY to a dedicated test-wallet key", exitCodes.SIGNER);
  }
  return privateKeyToAccount(key as `0x${string}`);
}

async function confirmPayment(record: GateRecord, yes: boolean): Promise<boolean> {
  if (yes) {
    if (process.env.X402_SEAL_ALLOW_PAYMENT !== "1") {
      throw new SealError("SIGNER", "Non-interactive payment requires X402_SEAL_ALLOW_PAYMENT=1", exitCodes.SIGNER);
    }
    return true;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new SealError("SIGNER", "Interactive confirmation requires a terminal", exitCodes.SIGNER);
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`Invoke ${record.amountUsdc} USDC to ${record.payTo} on Base? [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return defaults("help");
  if (argv.includes("--version") || argv.includes("-v")) return defaults("version");
  const command = argv[0] ?? "help";
  const result = defaults(command);
  let index = 1;
  while (index < argv.length) {
    const value = argv[index];
    if (!value) break;
    if (!value.startsWith("-") && !result.target) {
      result.target = value;
      index += 1;
      continue;
    }
    if (value === "--allow-http") result.allowHttp = true;
    else if (value === "--json") result.json = true;
    else if (value === "--yes") result.yes = true;
    else if (value === "--method") result.method = take(argv, ++index, value);
    else if (value === "--data") result.dataPath = take(argv, ++index, value);
    else if (value === "--max-usdc") result.maxUsdc = take(argv, ++index, value);
    else if (value === "--builder-code") result.builderCode = take(argv, ++index, value);
    else if (value === "--rpc-url") result.rpcUrl = validateRpc(take(argv, ++index, value));
    else if (value === "--output") result.output = take(argv, ++index, value);
    else if (value === "--timeout-ms") result.timeoutMs = parseTimeout(take(argv, ++index, value));
    else throw new SealError("REQUEST", `Unknown option: ${value}`, exitCodes.REQUEST);
    index += 1;
  }
  return result;
}

function defaults(command: string): CliOptions {
  return { command, allowHttp: false, json: false, yes: false };
}

function take(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new SealError("REQUEST", `${name} requires a value`, exitCodes.REQUEST);
  return value;
}

function parseTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new SealError("REQUEST", "--timeout-ms must be an integer", exitCodes.REQUEST);
  return parsed;
}

function validateRpc(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new SealError("REQUEST", "--rpc-url must be an HTTPS URL", exitCodes.REQUEST);
  }
}

const help = `x402-seal

Usage:
  x402-seal gate <url> [options]
  x402-seal invoke <url> --max-usdc <amount> [options]
  x402-seal witness <evidence.json> [--rpc-url <url>]

Options:
  --method <GET|POST>
  --data <json-file>
  --builder-code <code>
  --max-usdc <amount>
  --rpc-url <url>
  --timeout-ms <ms>
  --output <path>
  --allow-http
  --json
  --yes
`;

main().catch(error => {
  const failure = error instanceof SealError
    ? error
    : new SealError("UNKNOWN", "Unexpected failure", exitCodes.UNKNOWN);
  printFailure(failure, process.argv.includes("--json"));
  process.exitCode = failure.exitCode;
});
