import crypto from "node:crypto";

const TOOL_TAG = "dola_tool_use";

export function createMessageId() {
  return `msg_dola_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function anthropicResponse({ id, model, blocks, stopReason }) {
  return {
    id,
    type: "message",
    role: "assistant",
    content: blocks,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: anthropicUsage(),
  };
}

export function anthropicUsage() {
  return { input_tokens: 0, output_tokens: 0 };
}

export function anthropicError(message, type = "api_error") {
  return { type: "error", error: { type, message } };
}

export function messagesToAnthropicPrompt({ system, messages, tools, toolChoice }) {
  const sections = [];
  const systemText = blocksToText(system);
  if (systemText) sections.push(`<system>\n${systemText}\n</system>`);

  const transcript = messages.map((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    return `<${role}>\n${blocksToText(message?.content)}\n</${role}>`;
  }).join("\n\n");
  if (transcript) sections.push(transcript);

  const availableTools = normalizeTools(tools);
  if (availableTools.length && toolChoice?.type !== "none") {
    const choiceInstruction = toolChoiceInstruction(toolChoice);
    sections.push([
      "<tool_instructions>",
      "You can call tools supplied by the client. The client, not you, executes them.",
      "When a tool is needed, emit exactly one XML element per call in this form:",
      `<${TOOL_TAG}>{\"name\":\"tool_name\",\"input\":{\"argument\":\"value\"}}</${TOOL_TAG}>`,
      "The element body must be valid JSON. Use an exact tool name and make input conform to its input_schema.",
      "You may emit multiple tool elements for independent calls. Do not describe a call instead of emitting it.",
      "Do not emit a tool element when you can answer the user directly. Never fabricate tool results.",
      choiceInstruction,
      "Available tools:",
      JSON.stringify(availableTools),
      "</tool_instructions>",
    ].filter(Boolean).join("\n"));
  }

  return [
    "Continue the conversation as the assistant. Follow the system instructions and answer the final user turn.",
    "Do not quote this transcript or add role labels.",
    ...sections,
  ].join("\n\n");
}

export function parseAnthropicOutput(text, tools = []) {
  const knownNames = new Set(normalizeTools(tools).map(({ name }) => name));
  const direct = parseDirectAnthropicMessage(text, knownNames);
  if (direct) return direct;

  const calls = [];
  const ranges = [];
  const pattern = new RegExp(`<${TOOL_TAG}>\\s*([\\s\\S]*?)\\s*</${TOOL_TAG}>`, "gi");
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    try {
      const call = JSON.parse(stripCodeFence(match[1]));
      if (call && typeof call.name === "string" && isPlainObject(call.input) && knownNames.has(call.name)) {
        calls.push({
          type: "tool_use",
          id: createToolUseId(),
          name: call.name,
          input: call.input,
        });
        ranges.push([match.index, pattern.lastIndex]);
      }
    } catch {
      // Leave malformed or hallucinated tool markup visible as ordinary model text.
    }
  }

  let cursor = 0;
  const textParts = [];
  for (const [start, end] of ranges) {
    textParts.push(String(text || "").slice(cursor, start));
    cursor = end;
  }
  textParts.push(String(text || "").slice(cursor));
  const visibleText = textParts.join("").trim();
  const blocks = [];
  if (visibleText) blocks.push({ type: "text", text: visibleText });
  blocks.push(...calls);
  if (!blocks.length) blocks.push({ type: "text", text: "" });
  return { blocks, stopReason: calls.length ? "tool_use" : "end_turn" };
}

function parseDirectAnthropicMessage(text, knownNames) {
  let value;
  try {
    value = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (!value || !Array.isArray(value.content)) return null;

  const blocks = [];
  for (const block of value.content) {
    if (block?.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    if (block?.type !== "tool_use" || typeof block.name !== "string" ||
        !isPlainObject(block.input) || !knownNames.has(block.name)) {
      return null;
    }
    blocks.push({
      type: "tool_use",
      id: validToolUseId(block.id) ? block.id : createToolUseId(),
      name: block.name,
      input: block.input,
    });
  }
  if (!blocks.length) return null;
  const hasCalls = blocks.some(({ type }) => type === "tool_use");
  return { blocks, stopReason: hasCalls ? "tool_use" : "end_turn" };
}

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((block) => blockToText(block)).filter(Boolean).join("\n");
}

function blockToText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return block.text || "";
  if (block.type === "tool_use") {
    return `[Tool call id=${block.id || "unknown"} name=${block.name || "unknown"}]\n${JSON.stringify(block.input || {})}`;
  }
  if (block.type === "tool_result") {
    const result = blocksToText(block.content);
    return `[Tool result for ${block.tool_use_id || "unknown"}${block.is_error ? "; error" : ""}]\n${result}`;
  }
  if (block.type === "image") return `[Attached image: ${block.source?.media_type || "image"}]`;
  if (block.type === "document") return `[Attached document: ${block.title || block.source?.media_type || "document"}]`;
  if (block.type === "thinking" || block.type === "redacted_thinking") return "";
  return `[Unsupported content: ${block.type || "unknown"}]`;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool) => tool && typeof tool.name === "string").map((tool) => ({
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    input_schema: isPlainObject(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
  }));
}

function toolChoiceInstruction(choice) {
  const parallel = choice?.disable_parallel_tool_use ? " Call at most one tool in this response." : "";
  if (choice?.type === "any") return `You must call at least one available tool in this response.${parallel}`;
  if (choice?.type === "tool" && typeof choice.name === "string") {
    return `You must call the tool named ${JSON.stringify(choice.name)} in this response.${parallel}`;
  }
  return parallel.trim();
}

function stripCodeFence(value) {
  return String(value).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function createToolUseId() {
  return `toolu_dola_${crypto.randomUUID().replaceAll("-", "")}`;
}

function validToolUseId(value) {
  return typeof value === "string" && /^toolu_[A-Za-z0-9_-]{1,200}$/.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
