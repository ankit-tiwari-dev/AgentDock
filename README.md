# AgentDock Platform

> **The Web Dashboard, Real-time WebSocket Server, and VS Code Extension for AgentDock.**

[![Tests](https://img.shields.io/badge/tests-8%2F8%20passing-emerald)](https://github.com/ankit-tiwari-dev/AgentDock)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-purple)](LICENSE)

**AgentDock Platform** provides the developer-facing visual surfaces for the AgentDock ecosystem:
1. **Interactive Web Dashboard:** Real-time execution stream, live policy badges, visual acceptance criteria matrix, delta diff inspector, and token spend tracker.
2. **Prompt Coach & Socratic Advisor:** Interactive prompt analyzer that detects ambiguity, frustration patterns, and multi-task overload before handing instructions to coding agents.
3. **Socratic Product Guide (Agent 3):** An AI interview wizard that asks 2–3 plain-English product questions before coding begins, locking specifications so the agent doesn't invent product rules.
4. **VS Code Extension:** Activity Bar sidebar panel with OS Keychain key storage (`vscode.SecretStorage`) for Gemini 1.5 Pro, Claude 3.5 Sonnet, and Ollama, plus distributable [`.vsix` package](extension/agentdock-vscode-0.1.0.vsix).

---

## Ecosystem Architecture

```
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│       agentdock-cli             │                 │        AgentDock Platform       │
│   (Core Engine & CLI Hooks)     │  Telemetry &    │  (Web, Backend & VS Code Ext)   │
├─────────────────────────────────┤  WebSockets     ├─────────────────────────────────┤
│ • PreToolUse Interception       │ ──────────────► │ • Real-Time Web Dashboard       │
│ • Anti-Test-Gaming Guard        │                 │ • Socratic Product Guide (AI)   │
│ • Destructive Command Blocking  │                 │ • Verification Matrix Board     │
│ • SQLite WAL + Secret Redaction │                 │ • VS Code Activity Bar Sidebar  │
└─────────────────────────────────┘                 └─────────────────────────────────┘
```

---

## Platform Modules

| Module | Location | Description |
|---|---|---|
| **`backend/`** | [`backend/`](backend/) | Fastify/Node.js REST API + RFC 6455 WebSocket broadcaster + Supervisor Service. |
| **`frontend/`** | [`frontend/`](frontend/) | Next.js App Router dashboard with live activity, agent sessions, policy center, and prompt tools. |
| **`extension/`** | [`extension/`](extension/) | VS Code Extension with Activity Bar sidebar and OS Keychain credential storage. |

---

## Web Dashboard Features

* **Live Execution Timeline:** Watch coding agents execute tools in real time. Allowed actions display green badges; blocked actions display red badges (`Exit Code 2`) with the exact policy violation reason.
* **Socratic Product Wizard (Agent 3):**
  * Type a feature idea (e.g. *"Add Google OAuth login"*).
  * Agent 3 asks 2–3 targeted product decisions (session lifetimes, account collision handling, edge cases).
  * Select your answers and click **Lock Specification** to anchor the coding agent to a deterministic contract.
* **Two-Tier Verification Board:** View compiler/typecheck ground truth, unit test results, and criteria verification cards backed by exact line-number citations.
* **Delta Diff & Risk Inspector:** Line-by-line diff inspector with symbol blast radius, dependency drift warnings, and interactive Socratic comprehension questions ("Grill Me" mode).

---

## Quickstart

### 1. Build and launch the Platform Server & Web Dashboard

```bash
cd agentdock-platform
npm install
npm run build --workspace frontend
node backend/src/server.ts
```

Open your browser to:
```
http://localhost:45820
```

The backend automatically serves the interactive dashboard and WebSocket stream simultaneously!

For frontend development with hot reload, start the backend and run `npm run dev --workspace frontend` in a second terminal. The frontend is available at `http://localhost:3000` and connects to the local backend on port `45820`.

---

### 2. VS Code Extension Setup

The extension is located in [`extension/`](extension/). It integrates into the VS Code Activity Bar:
* Uses `vscode.SecretStorage` to store Gemini and Claude API keys in your operating system keychain (Windows Credential Manager / macOS Keychain).
* Opens the Socratic Product Guide directly inside the VS Code sidebar.

---

## Automated Test Suite

Run all tests across `backend/`, `frontend/`, and `extension/`:

```bash
node --test backend/tests/**/*.test.ts frontend/tests/**/*.test.ts extension/tests/**/*.test.ts
```

Output:
```
✔ 7/7 tests passing (Duration: ~0.22s)
```

---

## License

MIT © [Ankit Tiwari](https://github.com/ankit-tiwari-dev)

