# x402-seal

Prove an x402 service works past the `402`.

`x402-seal` inspects a payment gate, performs one capped paid request, verifies settlement and delivery, and writes a sanitized evidence file.

## Install

```bash
npm install -g @cultos/x402-seal
```

Node.js 20 or newer is required.

## Use

### Inspect the gate

```bash
x402-seal gate https://example.com/service --method POST --data request.json
```

`gate` is read-only. It checks the challenge, network, asset, recipient, price, resource metadata, and supported extensions without loading a signer.

### Run one paid request

```bash
X402_SEAL_EVM_KEY=0x... x402-seal invoke https://example.com/service --method POST --data request.json --max-usdc 0.01
```

`invoke` binds the request to the quoted terms, asks for confirmation, signs once, retries once, and checks settlement and the paid response.

Use a dedicated, narrowly funded test wallet. Do not use a treasury or production wallet.

For an x402aff-compatible service, attach a registered Base Builder Code:

```bash
X402_SEAL_EVM_KEY=0x... x402-seal invoke https://example.com/service --method POST --data request.json --max-usdc 0.01 --builder-code bc_yourcode
```

`x402-seal` preserves the code through the unpaid and paid requests, sends `X-Builder-Code`, and attaches the standard builder-code client extension. Evidence records the code, the seller-declared app code, and the quoted payment recipient.

### Verify the evidence

```bash
x402-seal witness ~/.x402-seal/runs/2026-09-14T183000Z.json
```

`witness` verifies the evidence schema, hashes, quoted terms, settlement consistency, and included offer or receipt signatures. Add `--rpc-url` to refresh the Base transaction check.

## Output

```text
X402 SEAL

GATE        PASS   0.001 USDC on Base
PAYMENT     PASS   exact / EIP-3009
SETTLEMENT  PASS   terms matched
DELIVERY    PASS   200 application/json

VERDICT     SEALED
EVIDENCE    ~/.x402-seal/runs/2026-09-14T183000Z.json
```

Failures stop at one boundary:

- `REQUEST` — invalid URL, method, JSON, or size
- `CHALLENGE` — missing or malformed x402 response
- `POLICY` — unsupported network, asset, scheme, redirect, or price
- `SIGNER` — missing key, cancellation, or signing failure
- `SETTLEMENT` — rejected payment or mismatched terms
- `DELIVERY` — unusable paid response
- `UNKNOWN` — settlement may have occurred and must be reconciled

`x402-seal` never retries a payment after an uncertain result.

## Supported in v1

- x402 v2 over HTTP
- HTTPS targets
- `GET` and JSON `POST`
- Base mainnet
- exact canonical USDC using EIP-3009
- synchronous JSON responses
- payment identifier and signed offer/receipt extensions when advertised
- optional Builder Code attribution for x402aff-compatible services

Local HTTP is available only for loopback targets with `--allow-http`.

## Payment controls

- `--max-usdc` is required for every paid run.
- Interactive confirmation is the default.
- Non-interactive payment requires both `--yes` and `X402_SEAL_ALLOW_PAYMENT=1`.
- Redirects are disabled before and after signing.
- A process can create only one payment authorization.
- Private keys, payment headers, cookies, and raw bodies are never written to evidence.

The wallet and signing remain local. `x402-seal` has no hosted service, custody layer, account, or API key.

## Evidence

Evidence uses the `cultos.x402-seal.run.v1` schema and records:

- normalized request identity and body hash
- selected x402 terms and spending ceiling
- payer public address
- settlement response and transaction reference
- paid response status, size, and body hash
- optional Base receipt and matching USDC transfer
- final verdict and failure boundary

The file proves what the local verifier observed. A response hash becomes seller-backed cryptographic evidence only when a valid signed offer or receipt covers it.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT
