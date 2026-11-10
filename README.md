# AgentDock Platform

> **The Web Dashboard, Real-time WebSocket Server, and VS Code Extension for AgentDock.**

[![Tests](https://img.shields.io/badge/tests-7%2F7%20passing-emerald)](https://github.com/ankit-tiwari-dev/AgentDock)
[![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-purple)](LICENSE)

**AgentDock Platform** provides the developer-facing visual surfaces for the AgentDock ecosystem:
1. **Interactive Web Dashboard:** Real-time execution stream, live policy badges, visual acceptance criteria matrix, and delta diff inspector.
2. **Socratic Product Guide (Agent 3):** An AI interview wizard that asks 2–3 plain-English product questions before coding begins, locking specifications so the agent doesn't invent product rules.
3. **VS Code Extension:** Activity Bar sidebar panel with OS Keychain key storage (`vscode.SecretStorage`) for Gemini 1.5 Pro, Claude 3.5 Sonnet, and Ollama.

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
| **`frontend/`** | [`frontend/`](frontend/) | Dark-mode Web Dashboard with live stream, criteria matrix, and diff inspector. |
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

### 1. Launch the Platform Server & Web Dashboard

```bash
cd agentdock-platform
node backend/src/server.ts
```

Open your browser to:
```
http://localhost:45820
```

The backend automatically serves the interactive dashboard and WebSocket stream simultaneously!

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
