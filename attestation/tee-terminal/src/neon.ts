import { generateText } from 'ai';
import { neon } from '@neondatabase/ai-sdk-provider';

/** Model id the tee-terminal default / `!ai` path sends to the Neon gateway. */
export const NEON_MODEL_ID = 'claude-opus-5-5';

export interface NeonCompletion {
  text: string;
  modelId: string;
}

export function neonGatewayConfigured(): boolean {
  return Boolean(
    process.env.NEON_AI_GATEWAY_BASE_URL?.trim() &&
      process.env.NEON_AI_GATEWAY_TOKEN?.trim(),
  );
}

/**
 * Explicit `!ai --claude` / `!ai --openai` stay on those adapters.
 * A bare prompt and `!ai <prompt>` use Neon when the gateway env is set.
 */
export function shouldUseNeon(raw: string): boolean {
  if (!neonGatewayConfigured()) return false;
  const trimmed = raw.trim();
  if (trimmed.startsWith('!ai --openai') || trimmed.startsWith('!ai --claude')) return false;
  return true;
}

/**
 * Completion the tee-terminal server uses for a non-bang prompt and for `!ai`.
 * `neon()` reads `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN`.
 * The token is never embedded in source.
 */
export async function completeWithNeon(prompt: string): Promise<NeonCompletion> {
  if (!neonGatewayConfigured()) {
    throw new Error('NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_TOKEN are required');
  }

  const model = neon(NEON_MODEL_ID);
  const result = await generateText({
    model,
    prompt,
  });

  const reported = result.response?.modelId?.trim();
  const modelId =
    reported && reported.length > 0
      ? reported.includes(NEON_MODEL_ID)
        ? NEON_MODEL_ID
        : reported
      : model.modelId || NEON_MODEL_ID;

  return {
    text: result.text,
    modelId,
  };
}
