import test from "node:test";
import assert from "node:assert/strict";
import { MediaStore } from "../src/media-store.js";
import { createServer } from "../src/server.js";

const API_KEY = "test-key";
const IMAGE_BYTES = Buffer.from("fake-image-bytes");
const VIDEO_BYTES = Buffer.from("fake-video-bytes");

function createFixture({ inspection } = {}) {
  const client = {
    async status() { return { connected: true }; },
    async generate(messages, { model, onDelta } = {}) {
      if (model?.skill === "image") {
        onDelta?.("created");
        return {
          text: "created",
          media: [{
            id: "upstream-image",
            type: "image",
            sourceUrl: "https://signed.example/image.png?token=secret",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
            status: "completed",
          }],
        };
      }
      if (model?.skill === "video") {
        return { text: "Video is being generated", media: [], conversationId: "conversation-1", videoPending: true };
      }
      onDelta?.("hello");
      return { text: "hello", media: [] };
    },
    async inspectConversation() {
      return inspection || {
        status: "completed",
        media: [{
          id: "upstream-video",
          type: "video",
          sourceUrl: "https://signed.example/video.mp4?token=secret",
          mimeType: "video/mp4",
          duration: 10,
          status: "completed",
        }],
      };
    },
  };
  const mediaStore = new MediaStore({
    fetchImpl: async (url, options = {}) => {
      const video = url.includes("video.mp4");
      const bytes = video ? VIDEO_BYTES : IMAGE_BYTES;
      const headers = new Headers({
        "content-type": video ? "video/mp4" : "image/png",
        "content-length": String(bytes.length),
        "accept-ranges": "bytes",
      });
      if (options.headers?.Range === "bytes=0-3") {
        headers.set("content-length", "4");
        headers.set("content-range", `bytes 0-3/${bytes.length}`);
        return new Response(bytes.subarray(0, 4), { status: 206, headers });
      }
      return new Response(bytes, { headers });
    },
  });
  const server = createServer(client, {
    apiKey: API_KEY,
    maxRequestBytes: 1024 * 1024,
    maxFileBytes: 1024 * 1024,
    mediaTtlMs: 60_000,
    maxMediaBytes: 1024 * 1024,
  }, { mediaStore });
  return { server };
}

async function startFixture(t, options) {
  const { server } = createFixture(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function apiFetch(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${API_KEY}`, ...options.headers },
  });
}

test("lists text and media models and enforces authentication", async (t) => {
  const baseUrl = await startFixture(t);
  const unauthorized = await fetch(`${baseUrl}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const response = await apiFetch(baseUrl, "/v1/models");
  assert.equal(response.status, 200);
  const ids = (await response.json()).data.map(({ id }) => id);
  assert.ok(ids.includes("dola-image"));
  assert.ok(ids.includes("dola-video"));
});

test("returns proxied image URLs and base64 image data", async (t) => {
  const baseUrl = await startFixture(t);
  const generated = await apiFetch(baseUrl, "/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dola-image", prompt: "a blue circle" }),
  });
  assert.equal(generated.status, 200);
  const result = await generated.json();
  assert.match(result.data[0].url, new RegExp(`^${baseUrl}/v1/media/media_`));
  assert.doesNotMatch(JSON.stringify(result), /signed\.example|token=secret/);

  const media = await fetch(result.data[0].url);
  assert.equal(media.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), IMAGE_BYTES);
  const head = await fetch(result.data[0].url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(IMAGE_BYTES.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const base64 = await apiFetch(baseUrl, "/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "a blue circle", response_format: "b64_json" }),
  });
  assert.equal((await base64.json()).data[0].b64_json, IMAGE_BYTES.toString("base64"));
});

test("adds media to regular and streaming Chat Completions responses", async (t) => {
  const baseUrl = await startFixture(t);
  const body = { model: "dola-image", messages: [{ role: "user", content: "draw" }] };
  const regular = await apiFetch(baseUrl, "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await regular.json();
  assert.equal(result.choices[0].message.media[0].type, "image");
  assert.match(result.choices[0].message.content, /!\[Generated image 1\]\(http:/);

  const streamed = await apiFetch(baseUrl, "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const sse = await streamed.text();
  assert.match(sse, /"media":\[\{"id":"media_/);
  assert.match(sse, /data: \[DONE\]/);
});

test("creates, polls, ranges, and downloads asynchronous videos", async (t) => {
  const baseUrl = await startFixture(t);
  const created = await apiFetch(baseUrl, "/v1/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dola-video", prompt: "calm ocean" }),
  });
  const initial = await created.json();
  assert.equal(initial.status, "in_progress");

  const polled = await apiFetch(baseUrl, `/v1/videos/${initial.id}`);
  const completed = await polled.json();
  assert.equal(completed.status, "completed");
  assert.match(completed.url, /\/content$/);
  assert.doesNotMatch(JSON.stringify(completed), /signed\.example|token=secret/);

  const ranged = await apiFetch(baseUrl, `/v1/videos/${initial.id}/content`, { headers: { Range: "bytes=0-3" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${VIDEO_BYTES.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), VIDEO_BYTES.subarray(0, 4));

  const downloaded = await apiFetch(baseUrl, `/v1/videos/${initial.id}/content`);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), VIDEO_BYTES);
});

test("surfaces Dola video moderation failures through the job", async (t) => {
  const baseUrl = await startFixture(t, {
    inspection: { status: "failed", error: "The video cannot be generated because it may violate our policies." },
  });
  const created = await apiFetch(baseUrl, "/v1/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "test prompt" }),
  });
  const initial = await created.json();
  const polled = await apiFetch(baseUrl, `/v1/videos/${initial.id}`);
  const failed = await polled.json();
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "video_generation_failed");
  assert.match(failed.error.message, /violate our policies/);
});
