import test from "node:test";
import assert from "node:assert/strict";
import { messagesToPrompt } from "../src/prompt.js";

test("keeps a single user message unchanged", () => {
  assert.equal(messagesToPrompt([{ role: "user", content: "xin chào" }]), "xin chào");
});

test("serializes multi-turn conversations with roles", () => {
  const prompt = messagesToPrompt([
    { role: "system", content: "Be brief" },
    { role: "user", content: "Hello" },
  ]);
  assert.match(prompt, /<system>\nBe brief/);
  assert.match(prompt, /<user>\nHello/);
});

test("labels attached files without embedding their data in the prompt", () => {
  const prompt = messagesToPrompt([{
    role: "user",
    content: [
      { type: "text", text: "Summarize this" },
      { type: "file", file: { filename: "report.pdf", file_data: "data:application/pdf;base64,AAAA" } },
    ],
  }]);
  assert.equal(prompt, "Summarize this\n[Attached file: report.pdf]");
  assert.doesNotMatch(prompt, /AAAA/);
});
