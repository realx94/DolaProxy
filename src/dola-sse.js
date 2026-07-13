export class DolaSseParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.#parseFrame(frame);
    }
  }

  end() {
    if (this.buffer.trim()) this.#parseFrame(this.buffer);
    this.buffer = "";
  }

  #parseFrame(frame) {
    let event = "message";
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const raw = data.join("\n");
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // Keep non-JSON data as text so upstream errors remain visible.
    }
    this.onEvent({ event, data: value });
  }
}

export function extractTextDelta({ event, data }) {
  if (!data || typeof data !== "object") return "";
  return textFromBlocks(blocksFromEvent(event, data));
}

export function extractMediaItems({ event, data }) {
  if (!data || typeof data !== "object") return [];
  return blocksFromEvent(event, data).flatMap((block) => {
    const creations = block?.content?.creation_block?.creations;
    if (!Array.isArray(creations)) return [];
    return creations.flatMap(mediaFromCreation);
  });
}

export function extractEventMeta({ event, data }) {
  if (!data || typeof data !== "object") return {};
  if (event === "STREAM_MSG_NOTIFY") {
    return {
      conversationId: data.meta?.conversation_id || null,
      messageId: data.meta?.message_id || null,
      videoPending: data.content?.ext?.has_video_gen === "1",
    };
  }
  if (event === "STREAM_CHUNK") {
    const ext = (data.patch_op || [])
      .filter((patch) => patch.patch_object === 50)
      .reduce((result, patch) => ({ ...result, ...patch.patch_value?.ext }), {});
    return {
      messageId: data.message_id || null,
      videoPending: ext.has_video_gen === "1",
    };
  }
  if (event === "FULL_MSG_NOTIFY") {
    return {
      conversationId: data.message?.conversation_id || null,
      messageId: data.message?.message_id || null,
    };
  }
  return {};
}

export function extractDolaError({ event, data }) {
  if (!/ERR|ERROR/.test(event)) return null;
  if (typeof data === "string") return data;
  return data?.error_detail?.message || data?.message || `Dola event ${event}`;
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => block?.content?.text_block?.text)
    .filter((text) => typeof text === "string")
    .join("");
}

function blocksFromEvent(event, data) {
  if (event === "STREAM_MSG_NOTIFY") return data.content?.content_block || [];
  if (event === "STREAM_CHUNK") {
    return (data.patch_op || [])
      .filter((patch) => patch.patch_object === 1)
      .flatMap((patch) => patch.patch_value?.content_block || []);
  }
  if (event === "FULL_MSG_NOTIFY" && data.message?.user_type === 2) {
    return data.message.content_block || [];
  }
  return [];
}

function mediaFromCreation(creation) {
  if (!creation || typeof creation !== "object") return [];
  const id = String(creation.id || creation.task_id || "");
  const image = creation.image;
  const imageSource = firstUrl(
    image?.image_ori_raw,
    image?.image_ori,
    image?.image_preview,
    image?.image_thumb,
  );
  if (imageSource) {
    const dimensions = firstObject(
      image?.image_ori_raw,
      image?.image_ori,
      image?.image_preview,
      image?.image_thumb,
      image?.placeholder,
    );
    return [{
      id: id || image?.key || imageSource,
      type: "image",
      sourceUrl: imageSource,
      mimeType: mimeTypeFromUrl(imageSource, "image/jpeg"),
      width: numberOrNull(dimensions?.width),
      height: numberOrNull(dimensions?.height),
      status: normalizeStatus(image?.status),
    }];
  }

  const videoRoot = creation.video || creation.video_info || (creation.type === 2 ? creation : null);
  if (!videoRoot) return [];
  const videoSource = bestVideoUrl(videoRoot);
  if (!videoSource) return [];
  const posterUrl = bestPosterUrl(videoRoot);
  return [{
    id: id || videoRoot.key || videoSource,
    type: "video",
    sourceUrl: videoSource,
    mimeType: mimeTypeFromUrl(videoSource, "video/mp4"),
    width: numberOrNull(videoRoot.width || videoRoot.video_width || videoRoot?.metadata?.width),
    height: numberOrNull(videoRoot.height || videoRoot.video_height || videoRoot?.metadata?.height),
    duration: numberOrNull(videoRoot.duration || videoRoot.duration_ms || videoRoot?.metadata?.duration),
    posterUrl,
    status: normalizeStatus(videoRoot.status || creation.status),
  }];
}

function firstUrl(...values) {
  for (const value of values) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    if (typeof value?.url === "string" && /^https?:\/\//i.test(value.url)) return value.url;
  }
  return null;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object") || null;
}

function bestVideoUrl(value) {
  const candidates = collectUrls(value);
  return candidates
    .map((candidate) => ({ ...candidate, score: videoUrlScore(candidate) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)[0]?.url || null;
}

function bestPosterUrl(value) {
  return collectUrls(value)
    .map((candidate) => ({
      ...candidate,
      score: (/poster|cover|thumb|preview|image/i.test(candidate.path) ? 10 : 0)
        + (/\.(png|jpe?g|webp)(?:$|[?~])/i.test(candidate.url) ? 5 : 0)
        - (/\.mp4(?:$|[?~])/i.test(candidate.url) ? 20 : 0),
    }))
    .sort((left, right) => right.score - left.score)
    .find(({ score }) => score > 0)?.url || null;
}

function collectUrls(value, path = "", results = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return results;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (typeof item === "string" && /^https?:\/\//i.test(item)) results.push({ path: childPath, url: item });
    else if (item && typeof item === "object") collectUrls(item, childPath, results, seen);
  }
  return results;
}

function videoUrlScore({ path, url }) {
  let score = 0;
  if (/\.mp4(?:$|[?~])/i.test(url)) score += 100;
  if (/video|play|download|origin|source/i.test(path)) score += 30;
  if (/url|uri|src/i.test(path)) score += 10;
  if (/poster|cover|thumb|preview|image/i.test(path)) score -= 80;
  if (/\.(png|jpe?g|webp)(?:$|[?~])/i.test(url)) score -= 100;
  return score;
}

function mimeTypeFromUrl(value, fallback) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (pathname.includes(".png")) return "image/png";
    if (pathname.includes(".webp")) return "image/webp";
    if (pathname.includes(".jpeg") || pathname.includes(".jpg")) return "image/jpeg";
    if (pathname.includes(".mp4")) return "video/mp4";
    if (pathname.includes(".webm")) return "video/webm";
  } catch {
    // Use the media-kind fallback for malformed URLs.
  }
  return fallback;
}

function normalizeStatus(value) {
  if (value === 2 || value === 4 || value === "completed" || value === "success") return "completed";
  if (value === 3 || value === "failed" || value === "error") return "failed";
  return "in_progress";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
