# clawd-attestation

Public, MIT-licensed tree of the [Solana Attestation Service](https://github.com/solana-foundation/solana-attestation-service) plus the CLAWD TEE terminal.

The on-chain program, clients, and integration tests come from the Solana Foundation project and stay under that project's MIT license. Solana Foundation authorship is credited in [`LICENSE`](LICENSE). This repository is https://github.com/Solizardking/clawd-attestation.

Demo mode is the default. It needs no API key, no wallet, and no env file.

## Install and demo

Clone this repository and, from its root, run:

```bash
npm run tee:install
npm run tee:demo
```

`npm run tee:install` installs the TEE terminal dependencies. `npm run tee:demo` builds the shipped terminal and runs `tee-terminal/tests/session.test.cjs`. That test completes a demo-mode handshake with no API key, encrypts `!help`, and checks that the decrypted command result contains `CLAWD TEE Terminal Commands`.

## What you get

| Path | Purpose |
| --- | --- |
| `program/` | On-chain Solana Attestation Service program |
| `idl/` | Generated IDL |
| `clients/typescript/` | Generated TypeScript client |
| `clients/rust/` | Generated Rust client |
| `integration_tests/` | Program test harness |
| `tee-terminal/` | Encrypted TEE terminal (X25519 ECDH, AES-256-GCM) |
| `inference/` | Optional private-inference helpers |
| `agent-router/` | Optional capability router |
| `formal_verification/` | Lean proof workspace for the program |
| `examples/` | SAS flow examples |

Program id: `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`

## Optional live configuration

Live Solana writes and model-provider calls are off unless you opt in. Copy the placeholder example and edit it on your machine:

```bash
cp .env.example .env
```

`.env` is gitignored. The committed example contains empty secrets only. Leave `TEE_DEMO_MODE=true` to keep the terminal in demo mode. Set `TEE_DEMO_MODE=false` only when you have your own RPC URL, credential, schema, and signer.

`npm run tee:server` starts the WebSocket terminal on `ws://127.0.0.1:8443`. `npm run tee:cli` connects to it. Both run in demo mode when no env file is present.

## Solana Attestation Service

Generate the IDL (requires [Shank](https://github.com/metaplex-foundation/shank)):

```bash
npm install
npm run generate-idl
```

Generate clients:

```bash
npm run generate-clients
```

Run the program integration tests when the Solana BPF toolchain is installed, from this repository root:

```bash
cargo-build-sbf && SBF_OUT_DIR=$(pwd)/target/sbpf-solana-solana/release cargo test
```

Build the in-repo Lean workspace:

```bash
npm run qedgen:build
```

## License

MIT. See [`LICENSE`](LICENSE). Upstream copyright 2025 Solana Foundation. CLAWD additions copyright 2026 x402agent. The license is the same MIT grant as https://github.com/solana-foundation/solana-attestation-service.
