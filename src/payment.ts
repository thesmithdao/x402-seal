import { randomUUID } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme, isEIP3009Payload, type ClientEvmSigner, type ExactEvmPayloadV2 } from "@x402/evm";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import { sameRequirement } from "./challenge.js";
import { SealError, exitCodes } from "./types.js";

export interface PaymentMaterial {
  headers: Record<string, string>;
  payload: PaymentPayload;
  payer: string;
  authorizationNonce: string;
  httpClient: x402HTTPClient;
}

export async function createPayment(
  paymentRequired: PaymentRequired,
  selected: PaymentRequirements,
  maxUsdc: string,
  signer: ClientEvmSigner,
  builderCode?: string,
): Promise<PaymentMaterial> {
  const client = new x402Client((version, requirements) => {
    if (version !== 2) throw new Error("Unsupported x402 version");
    const match = requirements.find(item => sameRequirement(item, selected));
    if (!match) throw new Error("Quoted payment option changed");
    return match;
  });
  client.register("eip155:8453", new ExactEvmScheme(signer));
  client.setSpendControls({ maxAmountPerPayment: `$${maxUsdc}` });
  if (builderCode) client.registerExtension(new BuilderCodeClientExtension(builderCode));
  const httpClient = new x402HTTPClient(client);
  let payload: PaymentPayload;
  try {
    payload = await httpClient.createPaymentPayload(paymentRequired);
    if (paymentRequired.extensions?.["payment-identifier"]) {
      payload.extensions = appendPaymentIdentifierToExtensions(payload.extensions ?? {}, `seal_${randomUUID().replaceAll("-", "")}`);
    }
  } catch {
    throw new SealError("SIGNER", "Payment authorization could not be created", exitCodes.SIGNER);
  }
  if (!sameRequirement(payload.accepted, selected)) {
    throw new SealError("POLICY", "Signed payment terms do not match the quote", exitCodes.POLICY);
  }
  const exactPayload = payload.payload as ExactEvmPayloadV2;
  if (!isEIP3009Payload(exactPayload)) {
    throw new SealError("POLICY", "Payment authorization is not EIP-3009", exitCodes.POLICY);
  }
  return {
    headers: httpClient.encodePaymentSignatureHeader(payload),
    payload,
    payer: signer.address,
    authorizationNonce: exactPayload.authorization.nonce,
    httpClient,
  };
}
