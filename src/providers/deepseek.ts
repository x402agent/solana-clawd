/**
 * src/providers/deepseek.ts — Unified AI Provider for Solana Clawd
 *
 * Priority order:
 *   1. DEEPSEEK_API_KEY  → https://api.deepseek.com  (cheapest, thinking mode)
 *   2. OPENROUTER_API_KEY → https://openrouter.ai/api/v1
 *   3. ANTHROPIC_API_KEY  → direct Anthropic API
 *
 * DeepSeek is OpenAI-compatible AND Anthropic-compatible.
 * This module exports both client types so any part of the codebase
 * can adopt DeepSeek without changing call sites.
 *
 * Usage:
 *   import { resolveOpenAIClient, resolveAnthropicClient, DEEPSEEK_MODEL } from '@/providers/deepseek'
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// ── Model constants ──────────────────────────────────────────────────────────

export const DEEPSEEK_MODELS = {
  flash: 'deepseek-v4-flash',     // fast, cheap, tool use — default
  pro:   'deepseek-v4-pro',       // thinking mode, max reasoning
} as const;

export type DeepSeekModel = typeof DEEPSEEK_MODELS[keyof typeof DEEPSEEK_MODELS];

// ── Provider detection ───────────────────────────────────────────────────────

export type ProviderName = 'deepseek' | 'openrouter' | 'anthropic';

export interface ProviderInfo {
  name: ProviderName;
  apiKey: string;
  baseURL: string;
  defaultModel: string;
  thinkingModel: string;
  supportsThinking: boolean;
}

/**
 * Resolve which provider to use based on available env vars.
 * Call once per process — result is stable.
 */
export function resolveProvider(): ProviderInfo {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (deepseekKey) {
    return {
      name: 'deepseek',
      apiKey: deepseekKey,
      baseURL: 'https://api.deepseek.com',
      defaultModel: process.env.DEEPSEEK_MODEL ?? DEEPSEEK_MODELS.flash,
      thinkingModel: DEEPSEEK_MODELS.pro,
      supportsThinking: true,
    };
  }

  if (openrouterKey) {
    return {
      name: 'openrouter',
      apiKey: openrouterKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultModel: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-opus-4.7-fast',
      thinkingModel: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-opus-4.7-fast',
      supportsThinking: false,
    };
  }

  if (anthropicKey) {
    return {
      name: 'anthropic',
      apiKey: anthropicKey,
      baseURL: 'https://api.anthropic.com/v1',
      defaultModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
      thinkingModel: 'claude-opus-4-7',
      supportsThinking: true,
    };
  }

  throw new Error(
    'No AI provider key found. Set DEEPSEEK_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY.'
  );
}

// ── OpenAI-compatible client (DeepSeek / OpenRouter) ────────────────────────

/**
 * Returns an OpenAI-compatible client pointed at the resolved provider.
 * DeepSeek and OpenRouter both speak the OpenAI protocol.
 * Direct Anthropic uses a different wire protocol and must use its own client.
 */
export function resolveOpenAIClient(): { client: OpenAI; model: string; provider: ProviderInfo } {
  const provider = resolveProvider();
  if (provider.name === 'anthropic') {
    throw new Error('Anthropic uses the Messages API. Use resolveAnthropicClient(), thinkingCall(), or singleToolCall(); OpenAI-format agent loops require DEEPSEEK_API_KEY or OPENROUTER_API_KEY.');
  }

  const headers: Record<string, string> = {};
  if (provider.name === 'openrouter') {
    headers['HTTP-Referer'] = 'https://openclawd.com';
    headers['X-Title'] = 'Solana Clawd';
  }

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    defaultHeaders: Object.keys(headers).length > 0 ? headers : undefined,
  });

  return { client, model: provider.defaultModel, provider };
}

// ── Anthropic-compatible client (DeepSeek Anthropic endpoint) ────────────────

/**
 * Returns an Anthropic SDK client.
 * When DEEPSEEK_API_KEY is set: routes through https://api.deepseek.com/anthropic
 * Otherwise: uses native Anthropic or throws.
 *
 * DeepSeek's Anthropic endpoint supports:
 *   - tool_use, thinking, streaming
 *   - Models: deepseek-v4-flash, deepseek-v4-pro
 */
export function resolveAnthropicClient(): { client: Anthropic; model: string; provider: ProviderInfo } {
  const provider = resolveProvider();

  if (provider.name === 'deepseek') {
    const client = new Anthropic({
      apiKey: provider.apiKey,
      baseURL: 'https://api.deepseek.com/anthropic',
    });
    return { client, model: provider.defaultModel, provider };
  }

  if (provider.name === 'anthropic') {
    const client = new Anthropic({ apiKey: provider.apiKey });
    return { client, model: provider.defaultModel, provider };
  }

  // OpenRouter doesn't have an Anthropic-compatible endpoint — use OpenAI path
  throw new Error(
    'resolveAnthropicClient: OPENROUTER does not support Anthropic SDK format. ' +
    'Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY instead.'
  );
}

// ── Thinking-mode call helper ────────────────────────────────────────────────

export interface ThinkingCallOptions {
  system: string;
  userMessage: string;
  maxTokens?: number;
  effort?: 'high' | 'max';
}

export interface ThinkingCallResult {
  reasoning: string | null;
  content: string;
  model: string;
  provider: ProviderName;
}

/**
 * Make a single thinking-mode call using whichever provider is available.
 * Returns both the reasoning chain and the final answer.
 *
 * DeepSeek: uses reasoning_effort + extra_body thinking
 * Anthropic: uses extended thinking budget
 * OpenRouter: no thinking, returns content only
 */
export async function thinkingCall(opts: ThinkingCallOptions): Promise<ThinkingCallResult> {
  if (resolveProvider().name === 'anthropic') {
    const { client, model, provider } = resolveAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      system: opts.system,
      messages: [{ role: 'user', content: opts.userMessage }],
    });
    return {
      content: response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
      reasoning: null,
      model,
      provider: provider.name,
    };
  }
  const { client, model, provider } = resolveOpenAIClient();
  const { system, userMessage, maxTokens = 2048, effort = 'high' } = opts;
  const thinkModel = provider.supportsThinking ? provider.thinkingModel : model;

  const response = await client.chat.completions.create({
    model: thinkModel,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ],
    ...(provider.name === 'deepseek' ? {
      reasoning_effort: effort,
      extra_body: { thinking: { type: 'enabled' } },
    } : {}),
  } as import('openai/resources/chat/completions.js').ChatCompletionCreateParamsNonStreaming);

  const msg = response.choices[0]?.message;
  const reasoning = (msg as unknown as { reasoning_content?: string } | undefined)?.reasoning_content ?? null;

  return {
    reasoning,
    content: msg?.content ?? '',
    model: thinkModel,
    provider: provider.name,
  };
}

// ── Tool call helper ─────────────────────────────────────────────────────────

import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';

export interface ToolCallResult {
  toolName: string;
  toolInput: Record<string, unknown>;
  reasoning: string | null;
  success: boolean;
}

/**
 * Single-turn tool call using DeepSeek/OpenRouter/Anthropic.
 * Returns the first tool call made by the model, plus any reasoning.
 */
export async function singleToolCall(opts: {
  system: string;
  userMessage: string;
  tools: ChatCompletionTool[];
  maxTokens?: number;
  thinking?: boolean;
}): Promise<ToolCallResult> {
  if (resolveProvider().name === 'anthropic') {
    const { client, model } = resolveAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: [{ role: 'user', content: opts.userMessage }],
      tools: opts.tools.map(({ function: tool }) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Tool['input_schema'],
      })),
    });
    const selected = response.content.find(block => block.type === 'tool_use');
    if (selected?.type === 'tool_use') {
      return { toolName: selected.name, toolInput: selected.input as Record<string, unknown>, reasoning: null, success: true };
    }
    return {
      toolName: 'hold',
      toolInput: { reason: response.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || 'no tool selected' },
      reasoning: null,
      success: false,
    };
  }
  const { client, model, provider } = resolveOpenAIClient();
  const { system, userMessage, tools, maxTokens = 1024, thinking = false } = opts;

  const extraBody = thinking && provider.name === 'deepseek'
    ? { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
    : {};

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ] satisfies ChatCompletionMessageParam[],
    tools,
    tool_choice: 'auto',
    ...extraBody,
  } as import('openai/resources/chat/completions.js').ChatCompletionCreateParamsNonStreaming);

  const msg = response.choices[0]?.message;
  const toolCall = msg?.tool_calls?.[0];
  const reasoning = (msg as unknown as { reasoning_content?: string } | undefined)?.reasoning_content ?? null;

  if (!toolCall) {
    return { toolName: 'hold', toolInput: { reason: msg?.content ?? 'no tool selected' }, reasoning, success: false };
  }

  const fn = (toolCall as unknown as { function: { name: string; arguments: string } }).function;
  return {
    toolName: fn.name,
    toolInput: JSON.parse(fn.arguments) as Record<string, unknown>,
    reasoning,
    success: true,
  };
}

// ── Env summary ──────────────────────────────────────────────────────────────

export function printProviderInfo(): void {
  try {
    const p = resolveProvider();
    console.log(`[provider] ${p.name} · default: ${p.defaultModel} · thinking: ${p.thinkingModel}`);
  } catch {
    console.log('[provider] ⚠ No AI provider key set');
  }
}
