import crypto from "node:crypto";
import { Readable } from "node:stream";

export class MediaStore {
  constructor({ ttlMs = 60 * 60_000, maxBufferBytes = 50 * 1024 * 1024, fetchImpl = fetch } = {}) {
    this.ttlMs = ttlMs;
    this.maxBufferBytes = maxBufferBytes;
    this.fetchImpl = fetchImpl;
    this.records = new Map();
    this.sourceIds = new Map();
  }

  register(media) {
    this.#cleanup();
    const existingId = this.sourceIds.get(media.sourceUrl);
    const existing = existingId && this.records.get(existingId);
    if (existing && existing.expiresAt > Date.now()) {
      Object.assign(existing, media, { id: existing.id, expiresAt: Date.now() + this.ttlMs });
      return existing;
    }

    const id = `media_${crypto.randomUUID().replaceAll("-", "")}`;
    const record = { ...media, id, createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs };
    this.records.set(id, record);
    this.sourceIds.set(media.sourceUrl, id);
    return record;
  }

  get(id) {
    this.#cleanup();
    return this.records.get(id) || null;
  }

  publicUrl(baseUrl, id) {
    return `${baseUrl.replace(/\/$/, "")}/v1/media/${encodeURIComponent(id)}`;
  }

  async toBase64(record) {
    const response = await this.#fetch(record, {});
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > this.maxBufferBytes) {
      throw mediaError(413, "Generated media is too large to return as base64", "media_too_large");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.maxBufferBytes) {
      throw mediaError(413, "Generated media is too large to return as base64", "media_too_large");
    }
    return { data: buffer.toString("base64"), mimeType: contentType(response, record.mimeType) };
  }

  async proxy(id, request, response) {
    const record = this.get(id);
    if (!record) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { message: "Media not found or expired", type: "invalid_request_error", code: "media_not_found" } }));
      return;
    }

    const headers = {};
    if (request.headers.range) headers.Range = request.headers.range;
    const upstream = await this.#fetch(record, { method: request.method === "HEAD" ? "HEAD" : "GET", headers });
    const responseHeaders = {
      "Content-Type": contentType(upstream, record.mimeType),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    };
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    response.writeHead(upstream.status, responseHeaders);
    if (request.method === "HEAD" || !upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body).pipe(response);
  }

  async #fetch(record, options) {
    let response;
    try {
      response = await this.fetchImpl(record.sourceUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
        ...options,
      });
    } catch (error) {
      throw mediaError(502, `Could not fetch generated media: ${error.message}`, "media_fetch_failed");
    }
    if (!response.ok && response.status !== 206) {
      throw mediaError(502, `Generated media returned HTTP ${response.status}`, "media_fetch_failed");
    }
    return response;
  }

  #cleanup() {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt > now) continue;
      this.records.delete(id);
      if (this.sourceIds.get(record.sourceUrl) === id) this.sourceIds.delete(record.sourceUrl);
    }
  }
}

function contentType(response, fallback) {
  return response.headers.get("content-type")?.split(";", 1)[0] || fallback || "application/octet-stream";
}

function mediaError(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, code });
}
