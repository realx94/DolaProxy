export class DolaSseParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.#parseFrame(frame);
    }
  }

  end() {
    if (this.buffer.trim()) this.#parseFrame(this.buffer);
    this.buffer = "";
  }

  #parseFrame(frame) {
    let event = "message";
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const raw = data.join("\n");
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // Keep non-JSON data as text so upstream errors remain visible.
    }
    this.onEvent({ event, data: value });
  }
}

export function extractTextDelta({ event, data }) {
  if (!data || typeof data !== "object") return "";

  if (event === "STREAM_MSG_NOTIFY") {
    return textFromBlocks(data.content?.content_block);
  }

  if (event === "STREAM_CHUNK") {
    return (data.patch_op || [])
      .filter((patch) => patch.patch_object === 1)
      .map((patch) => textFromBlocks(patch.patch_value?.content_block))
      .join("");
  }

  if (event === "FULL_MSG_NOTIFY" && data.message?.user_type === 2) {
    return textFromBlocks(data.message.content_block);
  }

  return "";
}

export function extractDolaError({ event, data }) {
  if (!/ERR|ERROR/.test(event)) return null;
  if (typeof data === "string") return data;
  return data?.error_detail?.message || data?.message || `Dola event ${event}`;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => block?.content?.text_block?.text)
    .filter((text) => typeof text === "string")
    .join("");
}
