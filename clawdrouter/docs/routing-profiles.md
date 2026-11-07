# ClawdRouter Routing Profiles

## Overview

ClawdRouter provides three routing profiles that control the quality/cost tradeoff for model selection. Switch profiles with `/model <profile>` or the `CLAWDROUTER_PROFILE` environment variable.

## Profiles

### 🌿 ECO — Maximum Savings

**Target savings: 95-100%**

Routes every request to the cheapest model that can handle it. Ideal for batch processing, non-critical tasks, and development.

| Tier | Model | Cost/request |
|------|-------|-------------|
| SIMPLE | nvidia/gpt-oss-120b | **FREE** |
| MEDIUM | deepseek/deepseek-v4-flash | Registry estimate |
| COMPLEX | google/gemini-2.5-flash-lite | $0.0003 |
| REASONING | deepseek/deepseek-v4-pro | Registry estimate |

### ⚡ AUTO — Balanced (Default)

**Target savings: 74-100%**

Balances quality and cost. Best for general coding, analysis, and daily use.

| Tier | Model | Cost/request |
|------|-------|-------------|
| SIMPLE | google/gemini-2.5-flash | $0.0014 |
| MEDIUM | nvidia/kimi-k2.5 | $0.0015 |
| COMPLEX | google/gemini-3.1-pro | $0.0070 |
| REASONING | xai/grok-4-1-fast-reasoning | $0.0004 |

### 👑 PREMIUM — Best Quality

**Target savings: 0%**

Routes to the highest quality model for each tier. Use for mission-critical code, complex architecture, and important decisions.

| Tier | Model | Cost/request |
|------|-------|-------------|
| SIMPLE | nvidia/kimi-k2.5 | $0.0015 |
| MEDIUM | openai/gpt-5.3-codex | $0.0079 |
| COMPLEX | anthropic/claude-opus-4.6 | $0.0150 |
| REASONING | anthropic/claude-sonnet-4.6 | $0.0090 |

## Tier Classification

Requests are classified into 4 tiers based on 15-dimension scoring:

| Tier | Score Range | Examples |
|------|------------|---------|
| 🟢 SIMPLE | 0.00 – 0.19 | Greetings, simple lookups, formatting |
| 🟡 MEDIUM | 0.20 – 0.44 | Code snippets, explanations, summaries |
| 🟠 COMPLEX | 0.45 – 0.69 | Multi-file refactoring, architecture, vision |
| 🔴 REASONING | 0.70 – 1.00 | Proofs, multi-step logic, complex debugging |

## Override Rules

- **Reasoning override**: If reasoning or math score > 0.7 → always REASONING tier
- **Vision override**: If vision score > 0.8 → always COMPLEX tier (needs capable model)
- **Excluded models**: If primary model is excluded, fallback finds the next allowed model in the tier. If none remain, routing fails without restoring an excluded model.

## Quick Commands

```
/model auto       # Switch to balanced routing
/model eco        # Switch to maximum savings
/model premium    # Switch to best quality
/model free       # Show free models
/model grok       # Pin to Grok 4.1 Fast Reasoning
/model claude     # Pin to Claude Sonnet 4.6
/model opus       # Pin to Claude Opus 4.6
```
