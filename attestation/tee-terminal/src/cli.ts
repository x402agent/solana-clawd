import WebSocket from 'ws';
import * as readline from 'readline';
import { loadAttestationEnv } from './load-env';
import { generateX25519KeyPair, deriveSessionKey, encrypt, decrypt } from './crypto';
import type {
  WireMessage,
  HandshakePayload,
  HelloPayload,
  EncryptedMessage,
  CommandResult,
} from './types';

loadAttestationEnv();

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
  white:   '\x1b[37m',
  bgBlack: '\x1b[40m',
};

const w = process.stdout.columns ?? 72;

function box(lines: string[]): string {
  const inner = w - 2;
  const top    = '╔' + '═'.repeat(inner) + '╗';
  const bottom = '╚' + '═'.repeat(inner) + '╝';
  const mid    = lines.map(l => '║' + l.padEnd(inner) + '║').join('\n');
  return `${top}\n${mid}\n${bottom}`;
}

function rule(char = '─'): string { return char.repeat(w); }

function dim(s: string): string { return C.dim + s + C.reset; }
function bold(s: string): string { return C.bold + s + C.reset; }
function cyan(s: string): string { return C.cyan + s + C.reset; }
function green(s: string): string { return C.green + s + C.reset; }
function yellow(s: string): string { return C.yellow + s + C.reset; }
function red(s: string): string { return C.red + s + C.reset; }
function magenta(s: string): string { return C.magenta + s + C.reset; }

// ─── Config ───────────────────────────────────────────────────────────────────

const SERVER_URL = process.env.TEE_SERVER_URL ?? 'ws://localhost:8443';
const SOLANA_PUBKEY = process.env.SOLANA_PUBKEY ?? '11111111111111111111111111111111';

// ─── CLI State ────────────────────────────────────────────────────────────────

let sessionKey: Buffer | undefined;
let sessionId: string | undefined;
let attestationAddress: string | undefined;
let clientSeq = 0;
let pendingResolvers = new Map<number, (result: CommandResult) => void>();
let ws: WebSocket;
let rl: readline.Interface;
const clientKeyPair = generateX25519KeyPair();

// ─── Print Banner ─────────────────────────────────────────────────────────────

function printBanner(): void {
  const network = process.env.SOLANA_NETWORK ?? 'demo';
  const mode = process.env.TEE_DEMO_MODE !== 'false' ? 'DEMO' : 'LIVE';
  console.log('\n' + box([
    `  ${bold(cyan('CLAWD TEE TERMINAL'))} v0.1.0${' '.repeat(Math.max(0, w - 30))}`,
    `  Encryption: ${green('AES-256-GCM')}  Key Exchange: ${green('X25519')}${' '.repeat(Math.max(0, w - 50))}`,
    `  Network:    ${yellow(network)}  Mode: ${mode === 'DEMO' ? yellow(mode) : green(mode)}${' '.repeat(Math.max(0, w - 40))}`,
    `  Server:     ${dim(SERVER_URL)}${' '.repeat(Math.max(0, w - SERVER_URL.length - 14))}`,
  ]));
  console.log();
}

function printReady(attAddr: string): void {
  console.log(rule());
  console.log(`  ${green('✓')} Session attested on-chain`);
  console.log(`  ${dim('PDA:')} ${cyan(attAddr)}`);
  console.log(`  ${dim('Session:')} ${cyan(sessionId?.slice(0, 8) + '...')}`);
  console.log(rule());
  console.log();
  console.log(`  Type ${bold('!help')} for commands, ${bold('exit')} to quit.`);
  console.log();
}

function printResult(result: CommandResult): void {
  if (result.output) {
    console.log('\n' + result.output + '\n');
  }

  if (result.modelId || result.inferenceId) {
    console.log(dim(rule('─')));
  }
  if (result.modelId) {
    console.log(dim(`  Model:        ${result.modelId}`));
  }
  if (result.inferenceId) {
    console.log(dim(`  Inference ID: ${result.inferenceId}`));
    if (result.promptHash) {
      console.log(dim(`  Prompt Hash:  ${result.promptHash.slice(0, 32)}...`));
    }
    if (result.responseHash) {
      console.log(dim(`  Resp. Hash:   ${result.responseHash.slice(0, 32)}...`));
    }
    if (result.attestationAddress) {
      console.log(dim(`  Attestation:  ${result.attestationAddress.slice(0, 16)}...`));
    }
  }
  if (result.modelId || result.inferenceId) {
    console.log(dim(rule('─')));
    console.log();
  }
}

// ─── Send encrypted command ───────────────────────────────────────────────────

function sendCommand(command: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (!sessionKey) { reject(new Error('Session not ready')); return; }
    const seq = ++clientSeq;
    const encrypted = encrypt(sessionKey, Buffer.from(command, 'utf8'), seq);
    const msg: WireMessage = { type: 'command', sessionId, seq, payload: encrypted };
    pendingResolvers.set(seq, resolve);
    ws.send(JSON.stringify(msg));
    // Timeout after 60s
    setTimeout(() => {
      if (pendingResolvers.has(seq)) {
        pendingResolvers.delete(seq);
        reject(new Error('Command timeout'));
      }
    }, 60_000);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();
  console.log(`  Connecting to ${dim(SERVER_URL)}...`);

  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log(`  ${green('✓')} Connected`);
  });

  ws.on('message', async (data: WebSocket.Data) => {
    let msg: WireMessage;
    try {
      msg = JSON.parse(data.toString()) as WireMessage;
    } catch {
      console.error(red('  Invalid message from server'));
      return;
    }

    switch (msg.type) {
      case 'handshake': {
        const hs = JSON.parse(msg.payload as string) as HandshakePayload;
        sessionId = hs.sessionId;

        // Derive session key via ECDH
        const serverPubKey = Buffer.from(hs.serverPublicKey, 'base64');
        sessionKey = deriveSessionKey(clientKeyPair.privateKey, serverPubKey, hs.sessionId);

        // Send hello
        const hello: HelloPayload = {
          clientPublicKey: clientKeyPair.publicKey.toString('base64'),
          solanaPubkey: SOLANA_PUBKEY,
        };
        const helloMsg: WireMessage = {
          type: 'hello',
          sessionId,
          payload: JSON.stringify(hello),
        };
        ws.send(JSON.stringify(helloMsg));
        console.log(`  ${dim('→')} Key exchange initiated`);
        break;
      }

      case 'ready': {
        if (!sessionKey) break;
        const encMsg = msg.payload as EncryptedMessage;
        const payload = JSON.parse(decrypt(sessionKey, encMsg).toString('utf8'));
        attestationAddress = payload.attestationAddress;
        printReady(attestationAddress ?? 'unknown');
        startREPL();
        break;
      }

      case 'response': {
        if (!sessionKey) break;
        const encMsg = msg.payload as EncryptedMessage;
        const result: CommandResult = JSON.parse(decrypt(sessionKey, encMsg).toString('utf8'));
        const seq = msg.seq;
        if (seq !== undefined && pendingResolvers.has(seq)) {
          const resolve = pendingResolvers.get(seq)!;
          pendingResolvers.delete(seq);
          resolve(result);
        } else {
          // Unsolicited response
          printResult(result);
          rl?.prompt();
        }
        break;
      }

      case 'error': {
        console.error(red(`  Server error: ${msg.error}`));
        rl?.prompt();
        break;
      }

      case 'pong':
        break;

      default:
        break;
    }
  });

  ws.on('error', err => {
    console.error(red(`\n  Connection error: ${err.message}`));
    process.exit(1);
  });

  ws.on('close', () => {
    console.log(yellow('\n  Session closed.'));
    process.exit(0);
  });
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

function startREPL(): void {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: bold(cyan('clawd')) + dim('>') + ' ',
    terminal: true,
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === 'exit' || input === 'quit') {
      ws.send(JSON.stringify({ type: 'close', sessionId }));
      ws.close();
      return;
    }

    rl.pause();
    process.stdout.write('\n');

    try {
      const result = await sendCommand(input);
      printResult(result);
    } catch (err: unknown) {
      console.error(red(`  Error: ${(err as Error).message}\n`));
    } finally {
      rl.resume();
      rl.prompt();
    }
  });

  rl.on('close', () => {
    ws.send(JSON.stringify({ type: 'close', sessionId }));
    ws.close();
  });

  process.on('SIGINT', () => {
    console.log('\n' + dim('  Closing session...'));
    ws.send(JSON.stringify({ type: 'close', sessionId }));
    ws.close();
  });
}

// ─── Entry ────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(red(`\nFatal: ${err.message}`));
  process.exit(1);
});
