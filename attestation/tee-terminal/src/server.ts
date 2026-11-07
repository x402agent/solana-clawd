import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { loadAttestationEnv } from './load-env';
import { TeeSessionManager } from './session';
import { CommandRouter } from './router';
import { encrypt, decrypt } from './crypto';
import type {
  WireMessage,
  HandshakePayload,
  HelloPayload,
  EncryptedMessage,
  TeeConfig,
} from './types';

loadAttestationEnv();

// ─── Config ───────────────────────────────────────────────────────────────────

const config: TeeConfig = {
  port: parseInt(process.env.TEE_PORT ?? '8443'),
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
  network: (process.env.SOLANA_NETWORK ?? 'demo') as TeeConfig['network'],
  sasProgram: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
  credentialAddress: process.env.CREDENTIAL_ADDRESS,
  teeSessionSchemaAddress: process.env.TEE_SESSION_SCHEMA_ADDRESS,
  claudeApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  demoMode: process.env.TEE_DEMO_MODE !== 'false',
};

if (process.env.SIGNER_PRIVATE_KEY) {
  config.signerPrivateKeyBytes = Buffer.from(process.env.SIGNER_PRIVATE_KEY, 'hex');
}

// ─── Server State ─────────────────────────────────────────────────────────────

const sessionManager = new TeeSessionManager(config);
const commandRouter = new CommandRouter(config);

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: config.port, host: process.env.TEE_HOST || '127.0.0.1' });

console.log(`╔═══════════════════════════════════════════════════╗`);
console.log(`║  CLAWD TEE Terminal Server v0.1.0                 ║`);
console.log(`║  Listening on ws://localhost:${config.port}               ║`);
console.log(`║  Network: ${config.network.padEnd(10)} Demo: ${config.demoMode}              ║`);
console.log(`║  Encryption: AES-256-GCM  Key Exchange: X25519    ║`);
console.log(`╚═══════════════════════════════════════════════════╝`);

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const remoteAddr = req.socket.remoteAddress ?? 'unknown';
  let sessionId: string | undefined;
  let outSeq = 0;

  function send(msg: WireMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function sendError(error: string, seq?: number): void {
    send({ type: 'error', error, seq });
  }

  function encryptedSend(
    type: WireMessage['type'],
    sessionKey: Buffer,
    payload: object,
    seq?: number,
  ): void {
    const encrypted = encrypt(sessionKey, Buffer.from(JSON.stringify(payload)), ++outSeq);
    send({ type, sessionId, seq: seq ?? outSeq, payload: encrypted });
  }

  // ── Initiate handshake ───────────────────────────────────────────────────
  const { sessionId: sid, serverPublicKey } = sessionManager.createSession();
  sessionId = sid;

  const handshakePayload: HandshakePayload = { serverPublicKey, sessionId };
  send({ type: 'handshake', sessionId, payload: JSON.stringify(handshakePayload) });
  console.log(`[${sessionId.slice(0, 8)}] New connection from ${remoteAddr}`);

  ws.on('message', async (data: WebSocket.Data) => {
    let msg: WireMessage;
    try {
      msg = JSON.parse(data.toString()) as WireMessage;
    } catch {
      sendError('Invalid JSON');
      return;
    }

    try {
      switch (msg.type) {
        case 'hello': {
          const hello = JSON.parse(msg.payload as string) as HelloPayload;
          const clientPublicKey = Buffer.from(hello.clientPublicKey, 'base64');
          const { readyPayload, sessionKey } = await sessionManager.completeHandshake(
            sessionId!,
            clientPublicKey,
            hello.solanaPubkey,
          );
          encryptedSend('ready', sessionKey!, readyPayload, msg.seq);
          console.log(
            `[${sessionId!.slice(0, 8)}] Handshake complete — attested: ` +
            `${readyPayload.attestationAddress.slice(0, 8)}... mode=${readyPayload.demoMode ? 'demo' : 'live'}`,
          );
          break;
        }

        case 'command': {
          const session = sessionManager.getSession(sessionId!);
          if (!session?.isActive || !session.sessionKey) { sendError('Session not ready', msg.seq); return; }

          const encMsg = msg.payload as EncryptedMessage;
          const commandBytes = decrypt(session.sessionKey, encMsg);
          const command = commandBytes.toString('utf8');

          console.log(`[${sessionId!.slice(0, 8)}] Encrypted command received`);

          const result = await commandRouter.route(session, command);
          encryptedSend('response', session.sessionKey, result, msg.seq);
          break;
        }

        case 'ping':
          send({ type: 'pong', sessionId, seq: msg.seq });
          break;

        case 'close':
          sessionManager.closeSession(sessionId!);
          console.log(`[${sessionId!.slice(0, 8)}] Session closed by client`);
          ws.close();
          break;

        default:
          sendError(`Unexpected message type: ${msg.type}`, msg.seq);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${sessionId?.slice(0, 8)}] Error:`, message);
      sendError(message, msg.seq);
    }
  });

  ws.on('close', () => {
    if (sessionId) sessionManager.closeSession(sessionId);
    console.log(`[${sessionId?.slice(0, 8)}] Disconnected`);
  });

  ws.on('error', err => {
    console.error(`[${sessionId?.slice(0, 8)}] WS error:`, err.message);
  });
});

wss.on('error', err => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down TEE terminal server...');
  wss.close(() => process.exit(0));
});
