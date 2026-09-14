import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  decodeSignedOffers,
  extractJWSHeader,
  extractOffersFromPaymentRequired,
  extractReceiptFromResponse,
  findAcceptsObjectFromSignedOffer,
  isEIP712SignedOffer,
  isEIP712SignedReceipt,
  isJWSSignedOffer,
  isJWSSignedReceipt,
  verifyOfferSignatureEIP712,
  verifyOfferSignatureJWS,
  verifyReceiptMatchesOffer,
  verifyReceiptSignatureEIP712,
  verifyReceiptSignatureJWS,
  type SignedOffer,
  type SignedReceipt,
} from "@x402/extensions/offer-receipt";
import { sameRequirement } from "./challenge.js";
import type { AttestationRecord } from "./types.js";

export async function inspectAttestations(
  paymentRequired: PaymentRequired,
  selected: PaymentRequirements,
  response: Response,
  payer: string,
): Promise<AttestationRecord> {
  const offerResult = await inspectOffers(paymentRequired, selected);
  const accepted = offerResult.offer ? decodeSignedOffers([offerResult.offer])[0] : undefined;
  const receipt = extractReceiptFromResponse(response);
  const receiptSignature = receipt ? await verifyReceipt(receipt) : false;
  const receiptVerified = Boolean(receipt && accepted && receiptSignature && verifyReceiptMatchesOffer(receipt, accepted, [payer]));
  return {
    offers: offerResult.count,
    offerVerified: offerResult.verified,
    receiptPresent: Boolean(receipt),
    receiptVerified,
    signerAuthorizationVerified: false,
    ...(accepted ? { offer: accepted.signedOffer } : {}),
    ...(receipt ? { receipt } : {}),
  };
}

export async function inspectOffers(
  paymentRequired: PaymentRequired,
  selected: PaymentRequirements,
): Promise<{ count: number; verified: boolean; offer?: SignedOffer }> {
  try {
    const offers = extractOffersFromPaymentRequired(paymentRequired);
    const accepted = decodeSignedOffers(offers).find(item => {
      const requirement = findAcceptsObjectFromSignedOffer(item, paymentRequired.accepts);
      return requirement ? sameRequirement(requirement, selected) : false;
    });
    if (offers.length === 0) return { count: 0, verified: true };
    if (!accepted) return { count: offers.length, verified: false };
    return { count: offers.length, verified: await verifyOffer(accepted.signedOffer), offer: accepted.signedOffer };
  } catch {
    return { count: 1, verified: false };
  }
}

export async function verifyStoredAttestations(record: AttestationRecord): Promise<boolean> {
  const offer = record.offer as SignedOffer | undefined;
  const receipt = record.receipt as SignedReceipt | undefined;
  if (offer && !await verifyOffer(offer)) return false;
  if (receipt && !await verifyReceipt(receipt)) return false;
  return true;
}

async function verifyOffer(offer: SignedOffer): Promise<boolean> {
  try {
    if (isEIP712SignedOffer(offer)) {
      await verifyOfferSignatureEIP712(offer);
      return true;
    }
    if (isJWSSignedOffer(offer)) {
      extractJWSHeader(offer.signature);
      await verifyOfferSignatureJWS(offer);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function verifyReceipt(receipt: SignedReceipt): Promise<boolean> {
  try {
    if (isEIP712SignedReceipt(receipt)) {
      await verifyReceiptSignatureEIP712(receipt);
      return true;
    }
    if (isJWSSignedReceipt(receipt)) {
      extractJWSHeader(receipt.signature);
      await verifyReceiptSignatureJWS(receipt);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
