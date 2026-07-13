import http from "node:http";
import { collectAttachments } from "./attachments.js";
import { getConfig } from "./config.js";
import { DolaClient } from "./dola-client.js";
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

export function createServer(client = dola, settings = config) {
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
        return await handleChatCompletion(request, response, client, settings);
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
        type: error.statusCode === 400 ? "invalid_request_error" : "api_error",
        code: error.code || "dola_proxy_error",
      }));
    }
  });
}

async function handleChatCompletion(request, response, client, settings) {
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
    return sendJson(response, 200, completionResponse({ id, created, model, text: result.text }));
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeSse(response, completionChunk({ id, created, model, delta: { role: "assistant", content: "" } }));

  await client.generate(body.messages, {
    ...generateOptions,
    onDelta: (content) => writeSse(response, completionChunk({ id, created, model, delta: { content } })),
  });
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
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
