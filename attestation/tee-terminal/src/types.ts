// ─── TEE Terminal Types ────────────────────────────────────────────────────

export interface SessionKeyPair {
  publicKey: Buffer;  // X25519 SPKI DER
  privateKey: Buffer; // X25519 PKCS8 DER
}

export interface TeeSession {
  id: string;
  serverPublicKey: Buffer;
  clientPublicKey?: Buffer;
  sessionKey?: Buffer;     // AES-256 key derived via HKDF(ECDH_shared)
  userSolanaPubkey?: string;
  startTime: number;
  paramsHash?: Buffer;     // SHA-256(sessionId + userPubkey + startTime)
  attestationAddress?: string;
  isActive: boolean;
}

export interface EncryptedMessage {
  nonce: string;      // base64 12-byte GCM nonce
  ciphertext: string; // base64 AES-256-GCM ciphertext
  authTag: string;    // base64 16-byte GCM auth tag
  seq: number;
}

export type WireMessageType =
  | 'handshake'
  | 'hello'
  | 'ready'
  | 'command'
  | 'response'
  | 'error'
  | 'close'
  | 'ping'
  | 'pong';

export interface WireMessage {
  type: WireMessageType;
  sessionId?: string;
  seq?: number;
  payload?: string | EncryptedMessage;
  error?: string;
}

export interface HandshakePayload {
  serverPublicKey: string; // base64 X25519 SPKI DER
  sessionId: string;
}

export interface HelloPayload {
  clientPublicKey: string; // base64 X25519 SPKI DER
  solanaPubkey: string;    // base58 Solana pubkey of user
}

export interface ReadyPayload {
  attestationAddress: string; // base58 on-chain attestation PDA
  credentialAddress: string;
  schemaAddress: string;
  serverVersion: string;
  demoMode: boolean;
}

// ─── Command Routing ────────────────────────────────────────────────────────

export type RouteTarget = 'ai' | 'shell' | 'agent' | 'system';

export interface ParsedCommand {
  target: RouteTarget;
  provider?: 'claude' | 'openai' | 'local';
  model?: string;
  agentId?: string;
  content: string;
  raw: string;
}

export interface CommandResult {
  output: string;
  exitCode?: number;
  inferenceId?: string;
  attestationAddress?: string;
  promptHash?: string;
  responseHash?: string;
  durationMs?: number;
  demoMode?: boolean;
  /** Model id reported by the completion the server actually called. */
  modelId?: string;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface TeeConfig {
  port: number;
  solanaRpcUrl: string;
  network: 'mainnet-beta' | 'devnet' | 'localnet' | 'demo';
  sasProgram: string;
  credentialAddress?: string;
  teeSessionSchemaAddress?: string;
  signerPrivateKeyBytes?: Uint8Array;
  claudeApiKey?: string;
  openaiApiKey?: string;
  demoMode: boolean;
}
