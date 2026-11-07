# Repository map

Start with [the local workflow](WORKSPACE.md) and the machine-readable
[component inventory](../workspace.components.json). Run `npm run workspace -- list`
for the complete catalog and `npm run workspace:doctor` for current readiness.

| Area | Paths | Role |
| --- | --- | --- |
| Entry and SDK | `src/`, `sdk/`, `packages/` | Root CLI/library and reusable SDK, wallet, perps packages |
| Local services | `gateway/`, `mcp/`, `clawdrouter/` | Shared registry/skills/data, MCP tools, optional model proxy |
| Runtime | `leviathan/`, `ooda/`, `deep-clawd/`, `agent-tasks/`, `agent-kit/` | Agent orchestration and strategies |
| Clients | `tui/`, `apps/`, `tailclawd/`, `chrome-extension/`, `clawdcli/`, `clawd-cloud-os/` | Terminal, desktop, browser and cloud clients |
| Private AI | `attestation/` | Solana attestation program, private inference, agent router, terminal, proofs |
| Markets and programs | `amm/`, `Perps/`, `programs/`, `pinocchio/`, `llm_oracle/`, `pump-fun/`, `ore-master/`, `vulcan-cli-master/` | Market integrations and independent Rust/Anchor programs |
| Agents and knowledge | `agents/`, `skills/`, `memory/`, `MemeBRain/`, `llm-wiki-tang/`, `moltbook-agent/` | Catalogs, skills and memory systems |
| Protocols and integrations | `x402/`, `a2a-x402-main/`, `adk/`, `email-worker/`, `openShell/`, `operator/`, `python/` | Payments, interoperability and separate runtimes |
| Preserved apps | `automaton-main/`, `dark-defi/`, `plugin.delivery/` | Independent application/toolchain boundaries |
| Optional submodules | `openclawd/`, `payments/`, `ultra/`, `llm_oracle/upstream/*` | Initialize deliberately after reviewing `.gitmodules` |
| Workspace support | `scripts/`, `docs/`, `examples/`, `formal_verification/`, `hackathon/`, `data/`, `starter/` | Build graph, verification, documentation and examples |

Use exact path casing: `mcp/`, `Perps/`, and `apps/beepboop/`. Node 22 is the
root toolchain. Installs are explicit; checks/builds do not install dependencies.
