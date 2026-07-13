import test from "node:test";
import assert from "node:assert/strict";
import {
  DolaSseParser,
  extractEventMeta,
  extractMediaItems,
  extractTextDelta,
} from "../src/dola-sse.js";

test("parses split Dola SSE frames and extracts text deltas", () => {
  const deltas = [];
  const parser = new DolaSseParser((event) => deltas.push(extractTextDelta(event)));
  parser.push('id: 1\nevent: STREAM_MSG_NOTIFY\ndata: {"content":{"content_block":[{"content":{"text_block":{"text":"hel"}}}]}}\n');
  parser.push('\nid: 2\nevent: STREAM_CHUNK\ndata: {"patch_op":[{"patch_object":1,"patch_value":{"content_block":[{"content":{"text_block":{"text":"lo"}}}]}}]}\n\n');
  parser.end();
  assert.equal(deltas.join(""), "hello");
});

test("extracts completed images from Dola creation blocks", () => {
  const event = {
    event: "STREAM_CHUNK",
    data: {
      message_id: "message-1",
      patch_op: [{
        patch_object: 1,
        patch_value: {
          content_block: [{
            block_type: 2074,
            content: {
              creation_block: {
                creations: [{
                  id: "image-1",
                  type: 1,
                  image: {
                    status: 2,
                    image_ori_raw: { url: "https://cdn.example/generated.jpeg", width: 2048, height: 2048 },
                  },
                }],
              },
            },
          }],
        },
      }],
    },
  };

  assert.deepEqual(extractMediaItems(event), [{
    id: "image-1",
    type: "image",
    sourceUrl: "https://cdn.example/generated.jpeg",
    mimeType: "image/jpeg",
    width: 2048,
    height: 2048,
    status: "completed",
  }]);
  assert.equal(extractEventMeta(event).messageId, "message-1");
});

test("extracts video media and asynchronous job metadata", () => {
  const event = {
    event: "STREAM_MSG_NOTIFY",
    data: {
      meta: { conversation_id: "conversation-1", message_id: "message-2" },
      content: {
        ext: { has_video_gen: "1" },
        content_block: [{
          content: {
            creation_block: {
              creations: [{
                id: "video-1",
                type: 2,
                video: {
                  status: "completed",
                  video_url: { url: "https://cdn.example/generated.mp4" },
                  cover: { url: "https://cdn.example/poster.webp" },
                  width: 1280,
                  height: 720,
                  duration: 10,
                },
              }],
            },
          },
        }],
      },
    },
  };

  const [media] = extractMediaItems(event);
  assert.equal(media.type, "video");
  assert.equal(media.sourceUrl, "https://cdn.example/generated.mp4");
  assert.equal(media.posterUrl, "https://cdn.example/poster.webp");
  assert.equal(media.status, "completed");
  assert.deepEqual(extractEventMeta(event), {
    conversationId: "conversation-1",
    messageId: "message-2",
    videoPending: true,
  });
});
