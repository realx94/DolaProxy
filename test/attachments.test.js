import test from "node:test";
import assert from "node:assert/strict";
import { collectAttachments } from "../src/attachments.js";

test("collects OpenAI image_url data URLs", async () => {
  const attachments = await collectAttachments([{
    role: "user",
    content: [{
      type: "image_url",
      image_url: { url: "data:image/png;base64,aGVsbG8=" },
    }],
  }]);

  assert.deepEqual(attachments, [{
    name: "image-1.png",
    mimeType: "image/png",
    size: 5,
    data: "aGVsbG8=",
  }]);
});

test("collects file content parts and explicit attachments", async () => {
  const attachments = await collectAttachments([{
    role: "user",
    content: [{
      type: "file",
      file: { filename: "notes.txt", file_data: "data:text/plain;base64,b25l" },
    }],
  }], [{ filename: "notes.txt", data: "dHdv", mime_type: "text/plain" }]);

  assert.deepEqual(attachments.map(({ name, size }) => ({ name, size })), [
    { name: "notes.txt", size: 3 },
    { name: "notes-2.txt", size: 3 },
  ]);
});

test("rejects file types Dola does not accept", async () => {
  await assert.rejects(
    collectAttachments([], [{ filename: "run.exe", data: "eA==" }]),
    (error) => error.statusCode === 400 && error.code === "unsupported_attachment_type",
  );
});

test("enforces per-file limits", async () => {
  await assert.rejects(
    collectAttachments([], [{ filename: "large.txt", data: "aGVsbG8=" }], { maxFileBytes: 4 }),
    (error) => error.statusCode === 400 && error.code === "attachment_too_large",
  );
});
