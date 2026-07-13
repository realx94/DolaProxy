import crypto from "node:crypto";

export function createCompletionId() {
  return `chatcmpl-dola-${crypto.randomUUID().replaceAll("-", "")}`;
}

export function completionResponse({ id, created, model, text, media = [] }) {
  const message = { role: "assistant", content: text, refusal: null };
  if (media.length) message.media = media;
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: "stop",
    }],
    usage: emptyUsage(),
  };
}

export function completionChunk({ id, created, model, delta = {}, finishReason = null, usage }) {
  const result = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}

export function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

export function openAiError(message, { type = "invalid_request_error", code = null, param = null } = {}) {
  return { error: { message, type, param, code } };
}
