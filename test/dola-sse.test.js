import test from "node:test";
import assert from "node:assert/strict";
import { DolaSseParser, extractTextDelta } from "../src/dola-sse.js";

test("parses split Dola SSE frames and extracts text deltas", () => {
  const deltas = [];
  const parser = new DolaSseParser((event) => deltas.push(extractTextDelta(event)));
  parser.push('id: 1\nevent: STREAM_MSG_NOTIFY\ndata: {"content":{"content_block":[{"content":{"text_block":{"text":"hel"}}}]}}\n');
  parser.push('\nid: 2\nevent: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":1,"patch_value":{"content_block":[{"content":{"text_block":{"text":"lo"}}}]}}]}\n\n');
  parser.end();
  assert.equal(deltas.join(""), "hello");
});
