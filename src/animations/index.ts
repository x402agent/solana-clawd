/**
 * 🦞 Clawd-branded spinner frames.
 *
 * Pulled from the `clawd` package (clawd/src/animations/clawd-frames.ts) and
 * trimmed to single-line, terminal-safe frames so they play nicely inside Ink.
 * Each entry is a { frames, interval } pair compatible with the
 * unicode-animations Spinner interface.
 */

export interface ClawdSpinner {
  frames: string[];
  interval: number;
}

// A pulse that evokes the Solana TPS counter.
export const solanaPulse: ClawdSpinner = {
  frames: ["⣀", "⣄", "⣆", "⣇", "⣧", "⣷", "⣿", "⣷", "⣧", "⣇", "⣆", "⣄"],
  interval: 100,
};

// $CLAWD claw rotating.
export const clawdSpin: ClawdSpinner = {
  frames: ["🦞", "🦐", "🦞", "🦀", "🦞", "🦐"],
  interval: 220,
};

// ECG-style heartbeat.
export const walletHeartbeat: ClawdSpinner = {
  frames: ["·", "•", "●", "◉", "●", "•", "·", " "],
  interval: 110,
};

// Dots orbiting like tokens swirling in a bonding curve.
export const tokenOrbit: ClawdSpinner = {
  frames: ["◐", "◓", "◑", "◒"],
  interval: 120,
};

// Bonding curve filling up.
export const pumpLoader: ClawdSpinner = {
  frames: [
    "▱▱▱▱▱",
    "▰▱▱▱▱",
    "▰▰▱▱▱",
    "▰▰▰▱▱",
    "▰▰▰▰▱",
    "▰▰▰▰▰",
    "▱▰▰▰▰",
    "▱▱▰▰▰",
    "▱▱▱▰▰",
    "▱▱▱▱▰",
  ],
  interval: 90,
};

// MEV scan-line.
export const mevScan: ClawdSpinner = {
  frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
  interval: 80,
};

// Degen dice roll.
export const degenDice: ClawdSpinner = {
  frames: ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"],
  interval: 110,
};

// Block finality / validator.
export const blockFinality: ClawdSpinner = {
  frames: ["░", "▒", "▓", "█", "▓", "▒", "░"],
  interval: 95,
};

export const CLAWD_SPINNERS = {
  solanaPulse,
  clawdSpin,
  walletHeartbeat,
  tokenOrbit,
  pumpLoader,
  mevScan,
  degenDice,
  blockFinality,
} as const;

export type ClawdSpinnerName = keyof typeof CLAWD_SPINNERS;

/**
 * Per-provider default spinner. When the active model changes provider,
 * the loading spinner picks a themed animation so the user can tell at a
 * glance which backend is answering.
 */
export function spinnerForProvider(provider: string): ClawdSpinner {
  switch (provider) {
    case "ollama":
      return blockFinality; // local / chunk-y vibe
    case "openrouter":
      return tokenOrbit; // routed through the swarm
    case "openai":
      return pumpLoader; // steady fill
    case "custom":
      return mevScan;
    case "grok":
    default:
      return clawdSpin; // lobster loves Grok
  }
}
