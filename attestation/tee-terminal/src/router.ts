import { execFile } from 'child_process';
import { promisify } from 'util';
import { completeWithNeon, shouldUseNeon, type NeonCompletion } from './neon';
import type { ParsedCommand, CommandResult, TeeSession, TeeConfig } from './types';

const execFileAsync = promisify(execFile);

// ─── Command Parser ───────────────────────────────────────────────────────────
//
// Syntax:
//   !ai [--claude|--openai] [--model=<name>] <prompt...>
//   !shell <cmd> [args...]
//   !agent <agentId> <message...>
//   !attest               → show session attestation
//   !verify <inferenceId> → verify inference on chain
//   !help
//   <anything else>       → default AI

export function parseCommand(raw: string): ParsedCommand {
  const trimmed = raw.trim();

  if (trimmed.startsWith('!shell ') || trimmed === '!shell') {
    return { target: 'shell', content: trimmed.slice(7).trim(), raw };
  }

  if (trimmed.startsWith('!agent ')) {
    const rest = trimmed.slice(7).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) return { target: 'agent', agentId: rest, content: '', raw };
    const agentId = rest.slice(0, spaceIdx);
    const content = rest.slice(spaceIdx + 1);
    return { target: 'agent', agentId, content, raw };
  }

  if (trimmed.startsWith('!ai ') || trimmed === '!ai') {
    let rest = trimmed.slice(4).trim();
    let provider: ParsedCommand['provider'] = 'claude';
    let model: string | undefined;

    if (rest.startsWith('--claude')) { provider = 'claude'; rest = rest.slice(8).trim(); }
    else if (rest.startsWith('--openai')) { provider = 'openai'; rest = rest.slice(8).trim(); }

    const modelMatch = rest.match(/^--model=(\S+)\s*/);
    if (modelMatch) { model = modelMatch[1]; rest = rest.slice(modelMatch[0].length); }

    return { target: 'ai', provider, model, content: rest, raw };
  }

  if (trimmed === '!attest' || trimmed === '!verify' || trimmed.startsWith('!verify ') ||
      trimmed === '!help' || trimmed === '!status') {
    return { target: 'system', content: trimmed.slice(1), raw };
  }

  // Default: route to AI
  return { target: 'ai', provider: 'claude', content: trimmed, raw };
}

// ─── Command Router ───────────────────────────────────────────────────────────

export class CommandRouter {
  private config: TeeConfig;

  constructor(config: TeeConfig) {
    this.config = config;
  }

  async route(session: TeeSession, rawCommand: string): Promise<CommandResult> {
    const cmd = parseCommand(rawCommand);

    switch (cmd.target) {
      case 'shell':
        return this.routeShell(cmd.content);
      case 'ai':
        return this.routeAI(session, cmd);
      case 'agent':
        return this.routeAgent(session, cmd);
      case 'system':
        return this.routeSystem(session, cmd.content);
      default:
        return { output: `Unknown route target`, exitCode: 1 };
    }
  }

  private async routeShell(command: string): Promise<CommandResult> {
    if (process.env.TEE_ALLOW_SHELL !== 'true') {
      return { output: 'Shell execution is disabled. Set TEE_ALLOW_SHELL=true to enable local shell commands.', exitCode: 1 };
    }
    if (!command.trim()) return { output: '', exitCode: 0 };
    const start = Date.now();
    try {
      const parts = command.split(/\s+/);
      const [bin, ...args] = parts;
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: 30_000,
        env: { ...process.env, TERM: 'dumb' },
      });
      return {
        output: (stdout + stderr).trim(),
        exitCode: 0,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
      return { output: output || 'Command failed', exitCode: e.code ?? 1, durationMs: Date.now() - start };
    }
  }

  private async routeAI(session: TeeSession, cmd: ParsedCommand): Promise<CommandResult> {
    if (!cmd.content.trim()) return { output: 'Usage: !ai <prompt>', exitCode: 1 };

    // Default prompt and `!ai` go through Neon when the gateway env is set.
    // Explicit `!ai --claude` / `!ai --openai` keep the adapters below.
    if (shouldUseNeon(cmd.raw)) {
      return this.neonAiCall(cmd);
    }

    // Delegate to the inference service
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PrivateInferenceService } = require('../../inference/dist/index.js');
      const svc: {
        infer(prompt: string, options?: unknown): Promise<{
          response: string;
          record: { inferenceId: string; promptHash: string; responseHash: string };
          attestation: { attestationAddress: string; demoMode: boolean };
        }>;
      } = new PrivateInferenceService({
        solanaRpcUrl: this.config.solanaRpcUrl,
        network: this.config.network,
        sasProgram: this.config.sasProgram,
        claudeApiKey: this.config.claudeApiKey,
        openaiApiKey: this.config.openaiApiKey,
        demoMode: this.config.demoMode,
        defaultProvider: cmd.provider ?? 'claude',
        defaultModel: cmd.model ?? (cmd.provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6'),
      });

      const result = await svc.infer(cmd.content, {
        provider: cmd.provider,
        model: cmd.model,
      });
      if (!this.config.demoMode && result.attestation.demoMode) {
        throw new Error('Inference returned a demo attestation in live mode');
      }
      return {
        output: result.response,
        inferenceId: result.record.inferenceId,
        promptHash: result.record.promptHash,
        responseHash: result.record.responseHash,
        attestationAddress: result.attestation.attestationAddress,
        demoMode: result.attestation.demoMode,
      };
    } catch (err: unknown) {
      // Only explicit demo sessions may use the direct, unattested fallback.
      if (this.config.demoMode) return this.directAiCall(cmd);
      return { output: `Private inference unavailable: ${(err as Error).message}. Build attestation/inference first.`, exitCode: 1 };
    }
  }

  private async neonAiCall(cmd: ParsedCommand): Promise<CommandResult> {
    const start = Date.now();
    try {
      const completion = await completeWithNeon(cmd.content);
      const recorded = await this.attachDemoRecord(cmd.content, completion, Date.now() - start);
      return {
        output: completion.text,
        modelId: completion.modelId,
        exitCode: 0,
        durationMs: Date.now() - start,
        demoMode: this.config.demoMode,
        ...recorded,
      };
    } catch (err: unknown) {
      return { output: `AI error: ${(err as Error).message}`, exitCode: 1 };
    }
  }

  /**
   * Demo-mode hash attestation for a Neon completion. Keeps the existing
   * on-chain demo record path without replacing the model text with the echo.
   */
  private async attachDemoRecord(
    prompt: string,
    completion: NeonCompletion,
    durationMs: number,
  ): Promise<Pick<CommandResult, 'inferenceId' | 'promptHash' | 'responseHash' | 'attestationAddress'>> {
    if (!this.config.demoMode) return {};
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { v4: uuidv4 } = require('uuid') as { v4: () => string };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildPrivateRecord } = require('../../inference/src/privacy') as {
        buildPrivateRecord: (
          inferenceId: string,
          req: { prompt: string },
          response: string,
          model: string,
          provider: string,
          durationMs: number,
        ) => { record: { inferenceId: string; promptHash: string; responseHash: string; timestamp: number } };
      };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { recordInferenceOnChain } = require('../../inference/src/chain') as {
        recordInferenceOnChain: (
          attestation: {
            inferenceId: string;
            modelPubkey: string;
            promptHash: Buffer;
            responseHash: Buffer;
            timestamp: bigint;
            isVerified: boolean;
          },
          config: {
            solanaRpcUrl: string;
            network: TeeConfig['network'];
            sasProgram: string;
            demoMode: boolean;
            defaultProvider: string;
            defaultModel: string;
          },
        ) => Promise<{ attestationAddress: string }>;
      };
      const inferenceId = uuidv4();
      const { record } = buildPrivateRecord(
        inferenceId,
        { prompt },
        completion.text,
        completion.modelId,
        'claude',
        durationMs,
      );
      const attestation = await recordInferenceOnChain(
        {
          inferenceId,
          modelPubkey: '11111111111111111111111111111111',
          promptHash: Buffer.from(record.promptHash, 'hex'),
          responseHash: Buffer.from(record.responseHash, 'hex'),
          timestamp: BigInt(record.timestamp),
          isVerified: false,
        },
        {
          solanaRpcUrl: this.config.solanaRpcUrl,
          network: this.config.network,
          sasProgram: this.config.sasProgram,
          demoMode: true,
          defaultProvider: 'claude',
          defaultModel: completion.modelId,
        },
      );
      return {
        inferenceId: record.inferenceId,
        promptHash: record.promptHash,
        responseHash: record.responseHash,
        attestationAddress: attestation.attestationAddress,
      };
    } catch {
      return {};
    }
  }

  private async directAiCall(cmd: ParsedCommand): Promise<CommandResult> {
    // Same Neon completion as the default path, including this no-key fallback.
    if (shouldUseNeon(cmd.raw)) return this.neonAiCall(cmd);

    const provider = cmd.provider ?? 'claude';
    const apiKey = provider === 'openai' ? this.config.openaiApiKey : this.config.claudeApiKey;
    if (!apiKey) {
      if (this.config.demoMode) return { output: '[demo] AI response to: ' + cmd.content, exitCode: 0, demoMode: true };
      return { output: `${provider} API key is not configured`, exitCode: 1 };
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      if (provider === 'openai') {
        const start = Date.now();
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cmd.model ?? 'gpt-4o', messages: [{ role: 'user', content: cmd.content }] }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) return { output: `OpenAI returned HTTP ${response.status}`, exitCode: 1 };
        const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        return { output: result.choices?.[0]?.message?.content ?? '', durationMs: Date.now() - start, demoMode: true };
      }
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic.default({ apiKey: this.config.claudeApiKey });
      const start = Date.now();
      const msg = await client.messages.create({
        model: cmd.model ?? 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: cmd.content }],
      });
      const text = msg.content.filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text).join('');
      return { output: text, durationMs: Date.now() - start, demoMode: true };
    } catch (err: unknown) {
      return { output: `AI error: ${(err as Error).message}`, exitCode: 1 };
    }
  }

  private async routeAgent(session: TeeSession, cmd: ParsedCommand): Promise<CommandResult> {
    if (!cmd.agentId) return { output: 'Usage: !agent <agentId> <message>', exitCode: 1 };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AgentRouter } = require('../../agent-router/dist/index.js');
      const router: {
        route(req: unknown): Promise<{ endpoint: string; attestationAddress: string }>;
      } = new AgentRouter({
        solanaRpcUrl: this.config.solanaRpcUrl,
        network: this.config.network,
        sasProgram: this.config.sasProgram,
        demoMode: this.config.demoMode,
        defaultStrategy: 'capability',
        cacheAgentsTtlMs: 30_000,
        healthCheckIntervalMs: 60_000,
      });
      const result = await router.route({ agentId: cmd.agentId, payload: cmd.content });
      return {
        output: `Routed to agent ${cmd.agentId} at ${result.endpoint}`,
        attestationAddress: result.attestationAddress,
      };
    } catch (err: unknown) {
      return { output: `Agent routing error: ${(err as Error).message}`, exitCode: 1 };
    }
  }

  private routeSystem(session: TeeSession, subcommand: string): CommandResult {
    if (subcommand === 'attest' || subcommand === 'status') {
      const lines = [
        `Mode:                ${this.config.demoMode ? 'demo (no on-chain receipt)' : 'live'}`,
        `Session ID:          ${session.id}`,
        `Attestation Address: ${session.attestationAddress ?? 'pending...'}`,
        `User Pubkey:         ${session.userSolanaPubkey ?? 'unknown'}`,
        `Started:             ${new Date(session.startTime).toISOString()}`,
        `Params Hash:         ${session.paramsHash?.toString('hex').slice(0, 16) ?? 'none'}...`,
        `Active:              ${session.isActive}`,
      ];
      return { output: lines.join('\n') };
    }
    if (subcommand === 'help' || subcommand === '') {
      return { output: HELP_TEXT };
    }
    if (subcommand.startsWith('verify ')) {
      const inferenceId = subcommand.slice(7).trim();
      return { output: `Verification of ${inferenceId} requires the inference service.\nRun: node inference/dist/index.js verify ${inferenceId}` };
    }
    return { output: `Unknown system command: ${subcommand}` };
  }
}

const HELP_TEXT = `
  CLAWD TEE Terminal Commands
  ───────────────────────────
  !ai [--claude|--openai] [--model=<name>] <prompt>
        Private AI inference with on-chain hash attestation

  !shell <cmd> [args...]
        Execute a shell command (output logged locally)

  !agent <agentId> <message>
        Route message to a Solana-attested agent

  !attest
        Show current session attestation details

  !verify <inferenceId>
        Verify an inference on-chain

  !help
        Show this help

  exit / quit
        End the session
`.trim();
