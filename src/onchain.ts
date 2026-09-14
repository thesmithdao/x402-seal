import { base } from "viem/chains";
import { createPublicClient, decodeEventLog, getAddress, http, parseAbiItem } from "viem";
import { BASE_NETWORK, BASE_USDC } from "./challenge.js";
import type { GateRecord, OnchainRecord, SettlementRecord } from "./types.js";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function verifyOnchain(
  settlement: SettlementRecord,
  gate: GateRecord,
  payer: string,
  rpcUrl: string,
): Promise<OnchainRecord> {
  if (settlement.network !== BASE_NETWORK || !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction)) {
    return { verified: false, reason: "Settlement transaction is invalid" };
  }
  try {
    const client = createPublicClient({ chain: base, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
    const receipt = await client.getTransactionReceipt({ hash: settlement.transaction as `0x${string}` });
    if (receipt.status !== "success") return { verified: false, blockNumber: receipt.blockNumber.toString(), reason: "Transaction failed" };
    const payerAddress = getAddress(payer);
    const recipient = getAddress(gate.payTo);
    const transferMatched = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== BASE_USDC.toLowerCase()) return false;
      try {
        const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
        return decoded.eventName === "Transfer"
          && getAddress(decoded.args.from) === payerAddress
          && getAddress(decoded.args.to) === recipient
          && decoded.args.value === BigInt(gate.amount);
      } catch {
        return false;
      }
    });
    return {
      verified: transferMatched,
      blockNumber: receipt.blockNumber.toString(),
      transferMatched,
      ...(transferMatched ? {} : { reason: "Matching USDC transfer not found" }),
    };
  } catch {
    return { verified: false, reason: "Base transaction could not be verified" };
  }
}
