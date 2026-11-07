import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  generateX25519KeyPair,
  deriveSessionKey,
  computeParamsHash,
  sha256,
  encrypt,
} from './crypto';
import type { TeeSession, SessionKeyPair, TeeConfig, ReadyPayload } from './types';

// ─── Session Attestation Data Serialization ────────────────────────────────--
// Schema: [String, Pubkey, U64, ProofHash, Bool]

function serializeSessionAttestation(
  sessionId: string,
  sessionPubkeyBytes: Uint8Array,
  startTime: bigint,
  paramsHash: Buffer,
  isActive: boolean,
): Buffer {
  const idBytes = Buffer.from(sessionId, 'utf8');
  const idLen = Buffer.allocUnsafe(4);
  idLen.writeUInt32LE(idBytes.length, 0);
  const tsBytes = Buffer.allocUnsafe(8);
  tsBytes.writeBigUInt64LE(startTime, 0);
  return Buffer.concat([
    idLen, idBytes,
    Buffer.from(sessionPubkeyBytes),
    tsBytes,
    paramsHash.slice(0, 32),
    Buffer.from([isActive ? 1 : 0]),
  ]);
}

// ─── Demo-mode PDA ────────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function demoAttestation(sessionId: string, userPubkey: string): string {
  const hash = sha256(`tee:${sessionId}:${userPubkey}`);
  let num = BigInt('0x' + hash.toString('hex'));
  let result = '';
  while (num > 0n) { result = B58[Number(num % 58n)] + result; num /= 58n; }
  return result.padStart(44, '1');
}

// ─── Session Manager ──────────────────────────────────────────────────────────

export class TeeSessionManager {
  private sessions = new Map<string, TeeSession>();
  private serverKeyPair: SessionKeyPair;
  private config: TeeConfig;

  constructor(config: TeeConfig) {
    this.config = config;
    this.serverKeyPair = generateX25519KeyPair();
  }

  get serverPublicKeyBase64(): string {
    return this.serverKeyPair.publicKey.toString('base64');
  }

  createSession(): { sessionId: string; serverPublicKey: string } {
    const sessionId = uuidv4();
    const session: TeeSession = {
      id: sessionId,
      serverPublicKey: this.serverKeyPair.publicKey,
      startTime: Date.now(),
      isActive: false,
    };
    this.sessions.set(sessionId, session);
    return { sessionId, serverPublicKey: this.serverPublicKeyBase64 };
  }

  async completeHandshake(
    sessionId: string,
    clientPublicKey: Buffer,
    userSolanaPubkey: string,
  ): Promise<TeeSession & { readyPayload: ReadyPayload }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    const sessionKey = deriveSessionKey(
      this.serverKeyPair.privateKey,
      clientPublicKey,
      sessionId,
    );
    const paramsHash = computeParamsHash(sessionId, userSolanaPubkey, session.startTime);

    session.clientPublicKey = clientPublicKey;
    session.sessionKey = sessionKey;
    session.userSolanaPubkey = userSolanaPubkey;
    session.paramsHash = paramsHash;
    session.isActive = false;

    let attestationAddress: string;
    try {
      attestationAddress = await this.attestSessionOnChain(session);
    } catch (error) {
      sessionKey.fill(0);
      session.sessionKey = undefined;
      throw error;
    }
    session.isActive = true;
    session.attestationAddress = attestationAddress;

    const readyPayload: ReadyPayload = {
      attestationAddress,
      credentialAddress: this.config.credentialAddress ?? 'demo-credential',
      schemaAddress: this.config.teeSessionSchemaAddress ?? 'demo-schema',
      serverVersion: '0.1.0',
      demoMode: this.config.demoMode,
    };

    this.sessions.set(sessionId, session);
    return { ...session, readyPayload };
  }

  private async attestSessionOnChain(session: TeeSession): Promise<string> {
    if (this.config.demoMode) {
      return demoAttestation(session.id, session.userSolanaPubkey ?? 'unknown');
    }
    if (!this.config.credentialAddress || !this.config.teeSessionSchemaAddress || !this.config.signerPrivateKeyBytes) {
      throw new Error('Live TEE attestation requires credential, session schema, and signer configuration');
    }
    try {
      const { createSolanaRpc, address, pipe, createTransactionMessage,
        setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
        appendTransactionMessageInstruction, signTransactionMessageWithSigners,
        createKeyPairSignerFromBytes, sendAndConfirmTransactionFactory } =
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('@solana/kit');
      const rpc = createSolanaRpc(this.config.solanaRpcUrl);
      const signer = await createKeyPairSignerFromBytes(this.config.signerPrivateKeyBytes!);
      const nonce = BigInt(Math.floor(session.startTime / 1000));

      // Extract raw X25519 pubkey bytes from SPKI DER (last 32 bytes)
      const sessionPubkeyBytes = session.serverPublicKey.slice(-32);

      const attData = serializeSessionAttestation(
        session.id,
        sessionPubkeyBytes,
        nonce,
        session.paramsHash!,
        true,
      );
      const nonceBytes = Buffer.allocUnsafe(8);
      nonceBytes.writeBigUInt64LE(nonce, 0);
      const dataLen = Buffer.allocUnsafe(4);
      dataLen.writeUInt32LE(attData.length, 0);
      const instructionData = Buffer.concat([
        Buffer.from([6]), nonceBytes, dataLen, attData, Buffer.from([0]),
      ]);

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
      const credentialAddr = address(this.config.credentialAddress!);
      const schemaAddr = address(this.config.teeSessionSchemaAddress!);
      // PDA is derived deterministically by the SAS program
      const attestationAddr = address(demoAttestation(session.id, session.userSolanaPubkey ?? ''));

      const txMsg = pipe(
        createTransactionMessage({ version: 0 }),
        (tx: unknown) => setTransactionMessageFeePayer(signer.address, tx),
        (tx: unknown) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
        (tx: unknown) => appendTransactionMessageInstruction(
          {
            programAddress: address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG'),
            accounts: [
              { address: signer.address, role: 3 },
              { address: signer.address, role: 2 },
              { address: credentialAddr, role: 0 },
              { address: schemaAddr, role: 0 },
              { address: attestationAddr, role: 1 },
              { address: address('11111111111111111111111111111111'), role: 0 },
            ],
            data: instructionData,
          },
          tx,
        ),
      );
      const signedTx = await signTransactionMessageWithSigners(txMsg);
      const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc });
      await sendAndConfirm(signedTx, { commitment: 'confirmed' });
      return attestationAddr.toString();
    } catch (err) {
      session.isActive = false;
      throw new Error(`On-chain session attestation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  getSession(sessionId: string): TeeSession | undefined {
    return this.sessions.get(sessionId);
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
      session.sessionKey?.fill(0);
      this.sessions.delete(sessionId);
    }
  }

  activeSessions(): number {
    let count = 0;
    for (const s of this.sessions.values()) if (s.isActive) count++;
    return count;
  }
}
