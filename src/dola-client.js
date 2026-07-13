import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { CdpConnection } from "./cdp.js";
import { DolaSseParser, extractDolaError, extractTextDelta } from "./dola-sse.js";
import { messagesToPrompt } from "./prompt.js";

const BRIDGE_BINDING = "__dolaProxyEmit";

export class DolaClient {
  constructor({ debugUrl, requestTimeoutMs }) {
    this.debugUrl = debugUrl;
    this.resolvedDebugUrl = null;
    this.requestTimeoutMs = requestTimeoutMs;
    this.cdp = null;
    this.jobs = new Map();
    this.queue = Promise.resolve();
  }

  async generate(messages, { onDelta, model = { mode: "Fast" }, attachments = [] } = {}) {
    const task = () => this.#generateLocked(messages, onDelta, model, attachments);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  async status() {
    try {
      const pages = await this.#getPages();
      return { connected: Boolean(findChatPage(pages)), page: findChatPage(pages)?.url || null };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  async #generateLocked(messages, onDelta, model, attachments) {
    await this.#ensureConnected();
    await this.#openNewChat();
    await this.#selectMode(model.mode);
    if (attachments.length) await this.#attachFiles(attachments);

    const jobId = crypto.randomUUID();
    const prompt = messagesToPrompt(messages);

    const response = new Promise((resolve, reject) => {
      const job = {
        text: "",
        onDelta,
        resolve,
        reject,
        parser: null,
        timer: setTimeout(() => this.#finishJob(jobId, new Error("Dola response timed out")), this.requestTimeoutMs),
      };
      job.parser = new DolaSseParser((event) => this.#onDolaEvent(jobId, event));
      this.jobs.set(jobId, job);
    });

    try {
      await this.cdp.send("Runtime.evaluate", {
        expression: `window.__dolaProxyRequestId=${JSON.stringify(jobId)}`,
      });
      await this.#submitPrompt(prompt, attachments.length ? 60_000 : 10_000);
    } catch (error) {
      this.#finishJob(jobId, error);
    }

    return response;
  }

  async #ensureConnected() {
    if (this.cdp) return;
    const pages = await this.#getPages();
    const page = findChatPage(pages);
    if (!page) {
      throw new Error(`Dola chat page was not found at ${this.debugUrl}. Run: npm run dola`);
    }

    const debugUrl = await this.#getResolvedDebugUrl();
    const cdp = new CdpConnection(rewriteWebSocketUrl(page.webSocketDebuggerUrl, debugUrl));
    await cdp.connect();
    cdp.on("Runtime.bindingCalled", ({ name, payload }) => {
      if (name !== BRIDGE_BINDING) return;
      this.#onBridgeMessage(payload);
    });
    cdp.on("disconnect", (error) => {
      if (this.cdp !== cdp) return;
      this.cdp = null;
      for (const id of [...this.jobs.keys()]) this.#finishJob(id, error);
    });
    this.cdp = cdp;

    await cdp.send("Runtime.enable");
    try {
      await cdp.send("Runtime.addBinding", { name: BRIDGE_BINDING });
    } catch {
      // The binding may already exist after a reconnect.
    }
    await this.#installFetchBridge();
  }

  async #installFetchBridge() {
    const expression = `(() => {
      if (window.__dolaProxyFetchInstalled) return true;
      const originalFetch = window.fetch.bind(window);
      window.__dolaProxyOriginalFetch = originalFetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        let url = "";
        try { url = args[0] instanceof Request ? args[0].url : String(args[0]); } catch {}
        let pathname = "";
        try { pathname = new URL(url, location.href).pathname; } catch {}
        const jobId = window.__dolaProxyRequestId;
        if (pathname === "/chat/completion" && jobId && response.body) {
          const copy = response.clone();
          (async () => {
            try {
              window.${BRIDGE_BINDING}(JSON.stringify({ type: "start", jobId, status: copy.status }));
              const reader = copy.body.getReader();
              const decoder = new TextDecoder();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) window.${BRIDGE_BINDING}(JSON.stringify({ type: "chunk", jobId, text }));
              }
              const tail = decoder.decode();
              if (tail) window.${BRIDGE_BINDING}(JSON.stringify({ type: "chunk", jobId, text: tail }));
              window.${BRIDGE_BINDING}(JSON.stringify({ type: "end", jobId }));
            } catch (error) {
              window.${BRIDGE_BINDING}(JSON.stringify({ type: "error", jobId, error: String(error?.message || error) }));
            }
          })();
        }
        return response;
      };
      window.__dolaProxyFetchInstalled = true;
      return true;
    })()`;
    const result = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error("Could not install the Dola streaming bridge");
  }

  async #openNewChat() {
    const expression = `(() => {
      const button = document.querySelector('[data-testid="create_conversation_button"]');
      if (!button) return false;
      (button.firstElementChild || button).click();
      return true;
    })()`;
    const result = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (!result.result?.value) throw new Error("Dola New Chat button was not found");
    await delay(350);
    await this.#waitForTextarea();
  }

  async #waitForTextarea() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await this.cdp.send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector('textarea[data-testid="chat_input_input"],textarea[placeholder="Message..."]'))`,
        returnByValue: true,
      });
      if (result.result?.value) return;
      await delay(100);
    }
    throw new Error("Dola chat input did not become ready");
  }

  async #selectMode(mode) {
    const target = mode === "Pro" ? "Pro" : "Fast";
    const openResult = await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.querySelector('[data-testid="deep-thinking-action-button"]');
        if (!root) return { error: "Dola model selector was not found" };
        const current = (root.innerText || "").trim().split("\\n")[0];
        if (current === ${JSON.stringify(target)}) return { selected: true };
        const trigger = root.parentElement?.closest('button');
        if (!trigger) return { error: "Dola model selector trigger was not found" };
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        trigger.click();
        return { opened: true };
      })()`,
      returnByValue: true,
    });
    if (openResult.result?.value?.error) throw new Error(openResult.result.value.error);
    if (openResult.result?.value?.selected) return;

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const selected = await this.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const item = [...document.querySelectorAll('[role="menuitem"]')]
            .find((element) => (element.innerText || "").trim().split("\\n")[0] === ${JSON.stringify(target)});
          if (!item) return false;
          item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
          item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
          item.click();
          return true;
        })()`,
        returnByValue: true,
      });
      if (selected.result?.value) {
        await delay(150);
        return;
      }
      await delay(75);
    }
    throw new Error(`Dola ${target} model option was not found`);
  }

  async #attachFiles(attachments) {
    const payload = attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector('input[data-testid="upload-file-input"]');
        if (!input) return { error: "Dola file input was not found" };
        const transfer = new DataTransfer();
        const files = ${JSON.stringify(payload)};
        for (const file of files) {
          const binary = atob(file.data);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          transfer.items.add(new File([bytes], file.name, { type: file.mimeType, lastModified: Date.now() }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { count: input.files.length, names: [...input.files].map((file) => file.name) };
      })()`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error("Could not create Dola file attachments");
    const value = result.result?.value;
    if (value?.error) throw new Error(value.error);
    if (value?.count !== attachments.length) throw new Error("Dola did not accept all file attachments");

    const names = attachments.map(({ name }) => name);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await this.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const text = document.body.innerText || "";
          return ${JSON.stringify(names)}.every((name) => text.includes(name));
        })()`,
        returnByValue: true,
      });
      if (ready.result?.value) return;
      await delay(100);
    }
    throw new Error("Dola file attachments did not become ready");
  }

  async #submitPrompt(prompt, sendTimeoutMs) {
    const setValue = `(() => {
      const input = document.querySelector('textarea[data-testid="chat_input_input"],textarea[placeholder="Message..."]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(prompt)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    })()`;
    const result = await this.cdp.send("Runtime.evaluate", { expression: setValue, returnByValue: true });
    if (!result.result?.value) throw new Error("Dola chat input was not found");

    const deadline = Date.now() + sendTimeoutMs;
    while (Date.now() < deadline) {
      const clicked = await this.cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const button = document.querySelector('#flow-end-msg-send,[data-testid="chat_input_send_button"]');
          if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
          button.click();
          return true;
        })()`,
        returnByValue: true,
      });
      if (clicked.result?.value) return;
      await delay(75);
    }
    throw new Error("Dola Send button stayed disabled");
  }

  #onBridgeMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const job = this.jobs.get(message.jobId);
    if (!job) return;

    if (message.type === "start" && message.status >= 400) {
      this.#finishJob(message.jobId, new Error(`Dola returned HTTP ${message.status}`));
    } else if (message.type === "chunk") {
      job.parser.push(message.text);
    } else if (message.type === "end") {
      job.parser.end();
      this.#finishJob(message.jobId);
    } else if (message.type === "error") {
      this.#finishJob(message.jobId, new Error(message.error || "Dola stream failed"));
    }
  }

  #onDolaEvent(jobId, event) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const error = extractDolaError(event);
    if (error) {
      this.#finishJob(jobId, new Error(error));
      return;
    }
    const delta = extractTextDelta(event);
    if (!delta) return;
    job.text += delta;
    job.onDelta?.(delta);
  }

  #finishJob(jobId, error) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    clearTimeout(job.timer);
    if (error) job.reject(error);
    else if (!job.text) job.reject(new Error("Dola returned an empty response"));
    else job.resolve({ text: job.text });
  }

  async #getPages() {
    const debugUrl = await this.#getResolvedDebugUrl();
    let response;
    try {
      response = await fetch(`${debugUrl}/json/list`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new Error(`Cannot reach Dola DevTools at ${this.debugUrl}. Run: npm run dola`);
    }
    if (!response.ok) throw new Error(`Dola DevTools returned HTTP ${response.status}`);
    return response.json();
  }

  async #getResolvedDebugUrl() {
    if (this.resolvedDebugUrl) return this.resolvedDebugUrl;
    const url = new URL(this.debugUrl);
    if (url.hostname === "localhost" || net.isIP(url.hostname)) {
      this.resolvedDebugUrl = url.origin;
      return this.resolvedDebugUrl;
    }

    try {
      const { address } = await dns.lookup(url.hostname, { family: 4 });
      url.hostname = address;
      this.resolvedDebugUrl = url.origin;
      return this.resolvedDebugUrl;
    } catch {
      throw new Error(`Cannot resolve Dola DevTools host: ${url.hostname}`);
    }
  }
}

function findChatPage(pages) {
  return pages.find((page) => page.type === "page" && /dola-chat/.test(page.url))
    || pages.find((page) => page.type === "page" && /dola-launcher/.test(page.url) && /chat/.test(page.url));
}

function rewriteWebSocketUrl(webSocketUrl, debugUrl) {
  const source = new URL(webSocketUrl);
  const target = new URL(debugUrl);
  source.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  source.hostname = target.hostname;
  source.port = target.port;
  return source.href;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
