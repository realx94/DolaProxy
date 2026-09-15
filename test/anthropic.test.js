import test from "node:test";
import assert from "node:assert/strict";
import { messagesToAnthropicPrompt, parseAnthropicOutput } from "../src/anthropic.js";
import { createServer } from "../src/server.js";

const API_KEY = "test-key";
const TOOLS = [{
  name: "Read",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
}];

function fixture(output) {
  const calls = [];
  const client = {
    async status() { return { connected: true }; },
    async generate(messages, options = {}) {
      calls.push({ messages, options });
      if (options.onDelta) {
        options.onDelta(output.slice(0, 2));
        options.onDelta(output.slice(2));
      }
      return { text: output, media: [] };
    },
  };
  const server = createServer(client, {
    apiKey: API_KEY,
    maxRequestBytes: 1024 * 1024,
    maxFileBytes: 1024 * 1024,
    mediaTtlMs: 60_000,
    maxMediaBytes: 1024 * 1024,
  });
  return { server, calls };
}

async function start(t, output) {
  const result = fixture(output);
  await new Promise((resolve) => result.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => result.server.close(resolve)));
  return { ...result, baseUrl: `http://127.0.0.1:${result.server.address().port}` };
}

function send(baseUrl, body, headers = {}) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, ...headers },
    body: JSON.stringify(body),
  });
}

test("serializes system instructions, tool calls, results, and schemas", () => {
  const prompt = messagesToAnthropicPrompt({
    system: [{ type: "text", text: "Be precise" }],
    messages: [
      { role: "user", content: "Open it" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.js" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello" }] },
    ],
    tools: TOOLS,
  });
  assert.match(prompt, /<system>\nBe precise/);
  assert.match(prompt, /Tool call id=toolu_1 name=Read/);
  assert.match(prompt, /Tool result for toolu_1/);
  assert.match(prompt, /"input_schema"/);
});

test("parses only known, valid tool calls and keeps surrounding text", () => {
  const parsed = parseAnthropicOutput([
    "I will inspect it.",
    '<dola_tool_use>{"name":"Read","input":{"file_path":"a.js"}}</dola_tool_use>',
  ].join("\n"), TOOLS);
  assert.equal(parsed.stopReason, "tool_use");
  assert.equal(parsed.blocks[0].text, "I will inspect it.");
  assert.equal(parsed.blocks[1].name, "Read");
  assert.deepEqual(parsed.blocks[1].input, { file_path: "a.js" });
  assert.match(parsed.blocks[1].id, /^toolu_dola_/);
});

test("accepts a direct Anthropic message with multiple tool calls", () => {
  const parsed = parseAnthropicOutput(JSON.stringify({
    id: "msg_custom",
    type: "message",
    role: "assistant",
    content: [
      { type: "tool_use", id: "toolu_read1", name: "Read", input: { file_path: "Program.cs" } },
      { type: "tool_use", id: "toolu_read2", name: "Read", input: { file_path: "Startup.cs" } },
    ],
    stop_reason: "tool_use",
  }), TOOLS);
  assert.equal(parsed.stopReason, "tool_use");
  assert.deepEqual(parsed.blocks.map(({ id }) => id), ["toolu_read1", "toolu_read2"]);
  assert.deepEqual(parsed.blocks.map(({ input }) => input.file_path), ["Program.cs", "Startup.cs"]);
});

test("preserves multiple tool results and errors in the next model prompt", () => {
  const prompt = messagesToAnthropicPrompt({
    messages: [
      { role: "user", content: "Read both files" },
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_read1", name: "Read", input: { file_path: "Program.cs" } },
        { type: "tool_use", id: "toolu_read2", name: "Read", input: { file_path: "Startup.cs" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_read1", content: "program content" },
        { type: "tool_result", tool_use_id: "toolu_read2", is_error: true, content: "File not found" },
      ] },
    ],
    tools: TOOLS,
  });
  assert.match(prompt, /Tool result for toolu_read1\]\nprogram content/);
  assert.match(prompt, /Tool result for toolu_read2; error\]\nFile not found/);
});

test("serves an Anthropic non-streaming tool_use response", async (t) => {
  const { baseUrl, calls } = await start(t,
    '<dola_tool_use>{"name":"Read","input":{"file_path":"src/server.js"}}</dola_tool_use>');
  const response = await send(baseUrl, {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Read the server" }],
    tools: TOOLS,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, "message");
  assert.equal(body.model, "claude-sonnet-4-5");
  assert.equal(body.stop_reason, "tool_use");
  assert.equal(body.content[0].type, "tool_use");
  assert.equal(body.content[0].name, "Read");
  assert.equal(calls[0].options.model.id, "dola-pro");
});

test("streams Anthropic text events", async (t) => {
  const { baseUrl } = await start(t, "hello");
  const response = await send(baseUrl, {
    model: "dola-fast",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "Hello" }],
  });
  const stream = await response.text();
  assert.match(stream, /event: message_start/);
  assert.match(stream, /"type":"text_delta","text":"he"/);
  assert.match(stream, /event: message_delta/);
  assert.match(stream, /"stop_reason":"end_turn"/);
  assert.match(stream, /event: message_stop/);
  assert.doesNotMatch(stream, /\[DONE\]/);
});

test("streams tool input as input_json_delta without leaking private markup", async (t) => {
  const markup = '<dola_tool_use>{"name":"Read","input":{"file_path":"README.md"}}</dola_tool_use>';
  const { baseUrl } = await start(t, markup);
  const response = await send(baseUrl, {
    model: "dola-pro",
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: "Read README" }],
    tools: TOOLS,
  });
  const stream = await response.text();
  assert.match(stream, /"type":"tool_use"/);
  assert.match(stream, /"type":"input_json_delta"/);
  assert.match(stream, /"stop_reason":"tool_use"/);
  assert.doesNotMatch(stream, /dola_tool_use/);
});

test("returns Anthropic-shaped authentication errors", async (t) => {
  const { baseUrl } = await start(t, "unused");
  const response = await send(baseUrl, {
    model: "dola",
    max_tokens: 100,
    messages: [{ role: "user", content: "Hello" }],
  }, { "x-api-key": "wrong" });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "authentication_error");
});

test("estimates input tokens for Claude Code context budgeting", async (t) => {
  const { baseUrl } = await start(t, "unused");
  const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: "dola-pro",
      messages: [{ role: "user", content: "Count this request" }],
      tools: TOOLS,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Number.isInteger(body.input_tokens), true);
  assert.ok(body.input_tokens > 0);
});
