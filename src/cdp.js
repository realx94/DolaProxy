import { EventEmitter } from "node:events";

export class CdpConnection extends EventEmitter {
  constructor(webSocketUrl) {
    super();
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;

    socket.onmessage = ({ data }) => this.#onMessage(data);
    socket.onclose = () => this.#onClose(new Error("Dola DevTools connection closed"));
    socket.onerror = () => this.#onClose(new Error("Dola DevTools connection failed"));

    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`Cannot connect to ${this.webSocketUrl}`));
    });
  }

  async send(method, params = {}) {
    await this.connect();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }

  #onMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit(message.method, message.params || {});
  }

  #onClose(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.emit("disconnect", error);
  }
}
