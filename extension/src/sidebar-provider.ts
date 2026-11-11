import { randomBytes } from "node:crypto";
import type { SecretManager } from "./secret-manager.ts";
import type { WebviewMessage } from "./types.ts";

export class AgentDockSidebarProvider {
  private secretManager: SecretManager;
  private backendPort: number;

  constructor(secretManager: SecretManager, backendPort = 45820) {
    this.secretManager = secretManager;
    this.backendPort = backendPort;
  }

  public async handleMessage(
    message: WebviewMessage,
    postMessageToWebview: (msg: unknown) => void
  ): Promise<void> {
    switch (message.type) {
      case "ready": {
        const hasGemini = await this.secretManager.hasKeyForProvider("gemini");
        const hasClaude = await this.secretManager.hasKeyForProvider("claude");
        postMessageToWebview({
          type: "status_update",
          hasGemini,
          hasClaude,
          backendPort: this.backendPort,
        });
        break;
      }

      case "save_api_key": {
        if (message.provider === "gemini") {
          await this.secretManager.setGeminiKey(message.key);
        } else if (message.provider === "claude") {
          await this.secretManager.setClaudeKey(message.key);
        }
        postMessageToWebview({
          type: "key_saved",
          provider: message.provider,
        });
        break;
      }

      case "start_interview": {
        // Call local backend supervisor endpoint
        try {
          const res = await fetch(`http://127.0.0.1:${this.backendPort}/api/supervisor/interview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ featurePrompt: message.prompt }),
          });
          const data = await res.json();
          postMessageToWebview({ type: "interview_result", data });
        } catch {
          postMessageToWebview(this.offlineMessage());
        }
        break;
      }

      case "submit_answers": {
        try {
          const res = await fetch(`http://127.0.0.1:${this.backendPort}/api/supervisor/interview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              featurePrompt: message.prompt,
              developerAnswers: message.answers,
            }),
          });
          const data = await res.json();
          postMessageToWebview({ type: "interview_locked", data });
        } catch {
          // Never make up a locked specification: the agent would be told criteria nobody agreed to.
          postMessageToWebview(this.offlineMessage());
        }
        break;
      }
    }
  }

  private offlineMessage() {
    return {
      type: "backend_offline",
      message: `The AgentDock backend is not answering on port ${this.backendPort}. Start it and try again.`,
    };
  }

  public getHtmlForWebview(): string {
    // A fresh nonce per page: only the script tag carrying it may run.
    const nonce = randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>AgentDock Supervisor</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      padding: 12px;
      margin: 0;
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: bold;
      background: rgba(99, 102, 241, 0.2);
      color: #818cf8;
      border: 1px solid rgba(99, 102, 241, 0.3);
    }
    .card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      width: 100%;
      margin-top: 8px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    textarea, input[type="text"], input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 4px;
      padding: 6px;
      font-size: 12px;
      margin-top: 4px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      background: #10b981;
      margin-right: 4px;
    }
  </style>
</head>
<body>
  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
    <div style="font-weight: 600; font-size: 13px; display: flex; align-items: center;">
      <span class="status-dot"></span> AgentDock Supervisor
    </div>
    <span class="badge">v0.1</span>
  </div>

  <div class="card">
    <div style="font-size: 11px; font-weight: 600; color: #a5b4fc; margin-bottom: 4px;">Socratic Product Guide (Agent 3)</div>
    <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">
      Ask product questions and lock acceptance criteria before your coding agent writes code.
    </div>
    <textarea id="promptInput" rows="3" placeholder="e.g. Add Google OAuth login with token rotation"></textarea>
    <button id="btnAsk">Ask Supervisor to Clarify →</button>
    <div id="offlineNotice" style="display: none; font-size: 11px; margin-top: 6px; color: var(--vscode-errorForeground);"></div>
  </div>

  <div id="questionsBox" class="card" style="display: none; border-color: #818cf8;">
    <div style="font-size: 11px; font-weight: 600; color: #c084fc; margin-bottom: 8px;">Agent 3 Asks: Clarify Product Decisions</div>
    <div id="questionsList"></div>
    <button id="btnLock" style="background: #059669;">Lock Specification & Dispatch ✔</button>
  </div>

  <div id="lockedBox" class="card" style="display: none; border-color: #10b981;">
    <div style="font-size: 11px; font-weight: 600; color: #34d399;">✔ Specification Locked</div>
    <div id="lockedTitle" style="font-size: 12px; font-weight: bold; margin-top: 4px;"></div>
    <div id="lockedCriteria" style="font-size: 11px; margin-top: 6px; color: var(--vscode-descriptionForeground);"></div>
  </div>

  <div class="card">
    <div style="font-size: 11px; font-weight: 600; margin-bottom: 4px;">AI Model Configuration</div>
    <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px;">
      Store keys securely in OS Keychain (vscode.SecretStorage):
    </div>
    <input type="password" id="geminiKeyInput" placeholder="Gemini API key" />
    <button id="btnSaveGemini" style="background: var(--vscode-button-secondaryBackground, #374151); color: var(--vscode-button-secondaryForeground, #fff);">
      Save Gemini Key 🔑
    </button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btnAsk').addEventListener('click', () => startInterview());
    document.getElementById('btnLock').addEventListener('click', () => lockCriteria());
    document.getElementById('btnSaveGemini').addEventListener('click', () => saveKey('gemini'));

    function el(tag, text) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    }
    vscode.postMessage({ type: 'ready' });

    let currentQuestions = [];

    function startInterview() {
      const prompt = document.getElementById('promptInput').value;
      if (!prompt) return;
      document.getElementById('btnAsk').innerText = 'Analyzing with Supervisor...';
      vscode.postMessage({ type: 'start_interview', prompt });
    }

    function lockCriteria() {
      const prompt = document.getElementById('promptInput').value;
      const answers = {};
      currentQuestions.forEach(q => {
        const sel = document.querySelector(\`input[name="ans_\${CSS.escape(q.id)}"]:checked\`);
        if (sel) answers[q.id] = sel.value;
      });
      vscode.postMessage({ type: 'submit_answers', prompt, answers });
    }

    function saveKey(provider) {
      const key = document.getElementById('geminiKeyInput').value;
      if (!key) return;
      vscode.postMessage({ type: 'save_api_key', provider, key });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'key_saved') {
        // Shown only once the extension has confirmed the save.
        document.getElementById('geminiKeyInput').value = '';
        alert('Key saved to the OS keychain.');
      }

      if (msg.type === 'backend_offline') {
        document.getElementById('btnAsk').innerText = 'Ask Supervisor to Clarify →';
        const notice = document.getElementById('offlineNotice');
        notice.textContent = msg.message;
        notice.style.display = 'block';
      }
      if (msg.type === 'interview_result' && msg.data.clarificationQuestions) {
        document.getElementById('btnAsk').innerText = 'Ask Supervisor to Clarify →';
        currentQuestions = msg.data.clarificationQuestions;
        const list = document.getElementById('questionsList');
        list.innerHTML = '';
        currentQuestions.forEach((q, i) => {
          const div = document.createElement('div');
          div.style.marginBottom = '8px';
          const question = el('div', q.question);
          question.style.cssText = 'font-size: 11px; font-weight: 600;';
          const why = el('div', q.whyItMatters);
          why.style.cssText = 'font-size: 10px; color: var(--vscode-descriptionForeground);';
          div.appendChild(question);
          div.appendChild(why);
          q.suggestedAnswers.forEach((a, idx) => {
            const label = el('label');
            label.style.cssText = 'display: flex; align-items: center; font-size: 11px; margin-top: 4px;';
            const input = el('input');
            input.type = 'radio';
            input.name = 'ans_' + q.id;
            input.value = a;
            input.checked = idx === 0;
            input.style.marginRight = '6px';
            label.appendChild(input);
            label.appendChild(document.createTextNode(a));
            div.appendChild(label);
          });
          list.appendChild(div);
        });
        document.getElementById('questionsBox').style.display = 'block';
      }

      if (msg.type === 'interview_locked' && msg.data.lockedSpecification) {
        document.getElementById('questionsBox').style.display = 'none';
        const spec = msg.data.lockedSpecification;
        document.getElementById('lockedTitle').innerText = spec.title;
        document.getElementById('lockedCriteria').innerText = spec.acceptanceCriteria.join('\\n');
        document.getElementById('lockedBox').style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
  }
}

