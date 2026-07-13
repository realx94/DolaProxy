import crypto from "node:crypto";
import http from "node:http";
import { collectAttachments } from "./attachments.js";
import { getConfig } from "./config.js";
import { DolaClient } from "./dola-client.js";
import { MediaStore } from "./media-store.js";
import { DOLA_MODELS, resolveDolaModel } from "./models.js";
import {
  completionChunk,
  completionResponse,
  createCompletionId,
  emptyUsage,
  openAiError,
} from "./openai.js";

const config = getConfig();
const dola = new DolaClient(config);

export function createServer(client = dola, settings = config, state = {}) {
  const mediaStore = state.mediaStore || new MediaStore({
    ttlMs: settings.mediaTtlMs,
    maxBufferBytes: settings.maxMediaBytes,
  });
  const videoJobs = state.videoJobs || new Map();

  return http.createServer(async (request, response) => {
    setCommonHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return sendJson(response, 200, { status: "ok", dola: await client.status() });
      }

      const mediaMatch = url.pathname.match(/^\/v1\/media\/([^/]+)$/);
      if (mediaMatch && (request.method === "GET" || request.method === "HEAD")) {
        return await mediaStore.proxy(decodeURIComponent(mediaMatch[1]), request, response);
      }

      if (!isAuthorized(request, settings.apiKey)) {
        return sendJson(response, 401, openAiError("Invalid API key", {
          type: "authentication_error",
          code: "invalid_api_key",
        }));
      }

      if (url.pathname === "/v1/models" && request.method === "GET") {
        return sendJson(response, 200, {
          object: "list",
          data: DOLA_MODELS.map(({ id, description }) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "dola",
            description,
          })),
        });
      }

      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        return await handleChatCompletion(request, response, client, settings, mediaStore);
      }

      if (url.pathname === "/v1/images/generations" && request.method === "POST") {
        return await handleImageGeneration(request, response, client, settings, mediaStore);
      }

      if (url.pathname === "/v1/videos" && request.method === "POST") {
        return await handleVideoGeneration(request, response, client, settings, mediaStore, videoJobs);
      }

      const videoContentMatch = url.pathname.match(/^\/v1\/videos\/([^/]+)\/content$/);
      if (videoContentMatch && (request.method === "GET" || request.method === "HEAD")) {
        const job = videoJobs.get(decodeURIComponent(videoContentMatch[1]));
        if (!job) throw httpError(404, "Video job not found", "video_not_found");
        if (job.status !== "completed" || !job.mediaId) {
          throw httpError(409, `Video is ${job.status}`, "video_not_ready");
        }
        return await mediaStore.proxy(job.mediaId, request, response);
      }

      const videoMatch = url.pathname.match(/^\/v1\/videos\/([^/]+)$/);
      if (videoMatch && request.method === "GET") {
        const id = decodeURIComponent(videoMatch[1]);
        let job = videoJobs.get(id);
        if (!job) throw httpError(404, "Video job not found", "video_not_found");
        if (job.status === "in_progress" && Date.now() - job.lastCheckedAt >= 3_000) {
          job.lastCheckedAt = Date.now();
          const inspected = await client.inspectConversation(job.conversationId);
          if (inspected.status === "failed") {
            job.status = "failed";
            job.error = inspected.error || "Dola video generation failed";
          } else if (inspected.status === "completed" && inspected.media?.length) {
            const [media] = exposeMedia(inspected.media, mediaStore, request);
            job.status = "completed";
            job.media = media;
            job.mediaId = media.id;
            job.completedAt = Math.floor(Date.now() / 1000);
          }
        }
        return sendJson(response, 200, videoJobResponse(job, request));
      }

      return sendJson(response, 404, openAiError(`Unknown endpoint: ${url.pathname}`, {
        type: "invalid_request_error",
        code: "not_found",
      }));
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) {
          writeSse(response, openAiError(error.message, { type: "api_error" }));
          response.write("data: [DONE]\n\n");
          response.end();
        }
        return;
      }
      sendJson(response, error.statusCode || 502, openAiError(error.message, {
        type: error.statusCode && error.statusCode < 500 ? "invalid_request_error" : "api_error",
        code: error.code || "dola_proxy_error",
      }));
    }
  });
}

async function handleChatCompletion(request, response, client, settings, mediaStore) {
  const body = await readJson(request, settings.maxRequestBytes);
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw httpError(400, "messages must be a non-empty array", "invalid_messages");
  }

  const selectedModel = resolveDolaModel(body.model);
  const model = selectedModel.id;
  const attachments = await collectAttachments(body.messages, body.attachments, {
    maxFileBytes: settings.maxFileBytes,
    maxTotalBytes: settings.maxRequestBytes,
  });
  const id = createCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const generateOptions = { model: selectedModel, attachments };

  if (!body.stream) {
    const result = await client.generate(body.messages, generateOptions);
    const media = exposeMedia(result.media, mediaStore, request);
    const text = `${result.text || ""}${mediaMarkdown(media)}`;
    return sendJson(response, 200, completionResponse({ id, created, model, text, media }));
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeSse(response, completionChunk({ id, created, model, delta: { role: "assistant", content: "" } }));

  const result = await client.generate(body.messages, {
    ...generateOptions,
    onDelta: (content) => writeSse(response, completionChunk({ id, created, model, delta: { content } })),
  });
  const media = exposeMedia(result.media, mediaStore, request);
  if (media.length) {
    writeSse(response, completionChunk({
      id,
      created,
      model,
      delta: { content: mediaMarkdown(media), media },
    }));
  }
  writeSse(response, completionChunk({ id, created, model, delta: {}, finishReason: "stop" }));
  if (body.stream_options?.include_usage) {
    writeSse(response, {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: emptyUsage(),
    });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

async function handleImageGeneration(request, response, client, settings, mediaStore) {
  const body = await readJson(request, settings.maxRequestBytes);
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw httpError(400, "prompt must be a non-empty string", "invalid_prompt");
  }
  const selectedModel = resolveDolaModel(body.model || "dola-image");
  if (selectedModel.skill !== "image") throw httpError(400, "Image generations require model dola-image", "invalid_model");
  const n = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw httpError(400, "n must be an integer from 1 to 4", "invalid_n");
  const responseFormat = body.response_format || "url";
  if (!['url', 'b64_json'].includes(responseFormat)) {
    throw httpError(400, "response_format must be url or b64_json", "invalid_response_format");
  }

  const result = await client.generate([{ role: "user", content: body.prompt }], { model: selectedModel });
  const records = registerMedia(result.media, mediaStore).filter(({ type }) => type === "image").slice(0, n);
  if (!records.length) throw httpError(502, "Dola did not return a generated image", "empty_image_result");
  const baseUrl = requestBaseUrl(request);
  const data = await Promise.all(records.map(async (record) => {
    const metadata = compact({ width: record.width, height: record.height, mime_type: record.mimeType });
    if (responseFormat === "b64_json") {
      const encoded = await mediaStore.toBase64(record);
      return { b64_json: encoded.data, ...metadata, mime_type: encoded.mimeType };
    }
    return { url: mediaStore.publicUrl(baseUrl, record.id), ...metadata };
  }));
  return sendJson(response, 200, { created: Math.floor(Date.now() / 1000), data });
}

async function handleVideoGeneration(request, response, client, settings, mediaStore, videoJobs) {
  const body = await readJson(request, settings.maxRequestBytes);
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw httpError(400, "prompt must be a non-empty string", "invalid_prompt");
  }
  const selectedModel = resolveDolaModel(body.model || "dola-video");
  if (selectedModel.skill !== "video") throw httpError(400, "Video generations require model dola-video", "invalid_model");

  const result = await client.generate([{ role: "user", content: body.prompt }], { model: selectedModel });
  const id = `video_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const records = registerMedia(result.media, mediaStore).filter(({ type }) => type === "video");
  const first = records[0];
  const job = {
    id,
    model: selectedModel.id,
    conversationId: result.conversationId,
    createdAt,
    completedAt: first ? createdAt : null,
    lastCheckedAt: 0,
    status: first ? "completed" : "in_progress",
    mediaId: first?.id || null,
    media: first ? exposeRecord(first, mediaStore, requestBaseUrl(request)) : null,
    error: null,
  };
  if (!first && !job.conversationId) {
    job.status = "failed";
    job.error = "Dola did not return a conversation ID for the video job";
  }
  videoJobs.set(id, job);
  return sendJson(response, 200, videoJobResponse(job, request));
}

function videoJobResponse(job, request) {
  return compact({
    id: job.id,
    object: "video",
    created_at: job.createdAt,
    completed_at: job.completedAt,
    status: job.status,
    model: job.model,
    progress: job.status === "completed" ? 100 : 0,
    error: job.error ? { message: job.error, code: "video_generation_failed" } : null,
    url: job.status === "completed" ? `${requestBaseUrl(request)}/v1/videos/${encodeURIComponent(job.id)}/content` : null,
    media: job.media,
  });
}

function registerMedia(items, mediaStore) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item?.sourceUrl)
    .map((item) => mediaStore.register(item));
}

function exposeMedia(items, mediaStore, request) {
  const baseUrl = requestBaseUrl(request);
  return registerMedia(items, mediaStore).map((record) => exposeRecord(record, mediaStore, baseUrl));
}

function exposeRecord(record, mediaStore, baseUrl) {
  return compact({
    id: record.id,
    type: record.type,
    url: mediaStore.publicUrl(baseUrl, record.id),
    mime_type: record.mimeType,
    width: record.width,
    height: record.height,
    duration: record.duration,
  });
}

function mediaMarkdown(media) {
  if (!media.length) return "";
  return `\n\n${media.map((item, index) => item.type === "image"
    ? `![Generated image ${index + 1}](${item.url})`
    : `[Generated video ${index + 1}](${item.url})`).join("\n\n")}`;
}

function requestBaseUrl(request) {
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = typeof forwarded === "string" ? forwarded.split(",", 1)[0].trim() : "http";
  return `${protocol}://${request.headers.host || "localhost"}`;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

async function readJson(request, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "Request body is too large", "request_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

function isAuthorized(request, apiKey) {
  if (!apiKey) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

function sendJson(response, status, body) {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
  });
  response.end(content);
}

function writeSse(response, value) {
  if (!response.writableEnded) response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function setCommonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
  response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
}

function httpError(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Dola OpenAI proxy listening at http://${config.host}:${config.port}`);
    console.log(`OpenAI base URL: http://${config.host}:${config.port}/v1`);
  });
}
