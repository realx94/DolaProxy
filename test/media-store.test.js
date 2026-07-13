import test from "node:test";
import assert from "node:assert/strict";
import { MediaStore } from "../src/media-store.js";

test("deduplicates media and returns base64 without exposing the source URL", async () => {
  const bytes = Buffer.from("generated-image");
  const store = new MediaStore({
    fetchImpl: async () => new Response(bytes, {
      headers: { "content-type": "image/png", "content-length": String(bytes.length) },
    }),
  });
  const first = store.register({ type: "image", sourceUrl: "https://signed.example/image", mimeType: "image/png" });
  const second = store.register({ type: "image", sourceUrl: "https://signed.example/image", mimeType: "image/png" });

  assert.equal(first.id, second.id);
  assert.doesNotMatch(store.publicUrl("http://localhost:3000", first.id), /signed\.example/);
  assert.deepEqual(await store.toBase64(first), { data: bytes.toString("base64"), mimeType: "image/png" });
  first.expiresAt = 0;
  assert.equal(store.get(first.id), null);
});

test("enforces the generated-media base64 limit", async () => {
  const store = new MediaStore({
    maxBufferBytes: 3,
    fetchImpl: async () => new Response(Buffer.from("large"), { headers: { "content-length": "5" } }),
  });
  const record = store.register({ type: "image", sourceUrl: "https://signed.example/large" });
  await assert.rejects(() => store.toBase64(record), (error) => error.statusCode === 413 && error.code === "media_too_large");
});
