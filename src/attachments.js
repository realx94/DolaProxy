const ACCEPTED_EXTENSIONS = new Set([
  ".pdf", ".txt", ".csv", ".docx", ".doc", ".xlsx", ".xls",
  ".pptx", ".ppt", ".md", ".mobi", ".epub", ".png", ".jpeg",
  ".jpg", ".webp",
]);

const MIME_EXTENSIONS = new Map([
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/csv", ".csv"],
  ["text/markdown", ".md"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["application/epub+zip", ".epub"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
]);

export async function collectAttachments(messages, explicitAttachments = [], limits = {}) {
  const maxFileBytes = limits.maxFileBytes || 20 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes || 30 * 1024 * 1024;
  const specs = [];

  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const spec = contentPartToSpec(part, specs.length + 1);
      if (spec) specs.push(spec);
    }
  }

  if (explicitAttachments != null && !Array.isArray(explicitAttachments)) {
    throw attachmentError("attachments must be an array", "invalid_attachments");
  }
  for (const attachment of explicitAttachments || []) {
    specs.push(explicitAttachmentToSpec(attachment, specs.length + 1));
  }

  const attachments = [];
  let totalBytes = 0;
  for (const spec of specs) {
    const attachment = await materialize(spec, maxFileBytes);
    totalBytes += attachment.size;
    if (totalBytes > maxTotalBytes) {
      throw attachmentError(`Attachments exceed the ${formatMiB(maxTotalBytes)} MiB total limit`, "attachments_too_large");
    }
    attachments.push(attachment);
  }

  return deduplicateNames(attachments);
}

function contentPartToSpec(part, index) {
  if (!part || typeof part !== "object") return null;

  if (part.type === "image_url") {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (!url) throw attachmentError("image_url.url is required", "invalid_attachment");
    return { source: url, filename: filenameFromUrl(url) || `image-${index}`, mimeType: null };
  }

  if (part.type === "file") {
    const file = part.file || {};
    const source = file.file_data || file.data || file.url;
    if (!source) {
      const detail = file.file_id ? "file_id cannot be resolved by this local proxy; provide file_data instead" : "file.file_data is required";
      throw attachmentError(detail, "invalid_attachment");
    }
    return {
      source,
      filename: file.filename || filenameFromUrl(source) || `file-${index}`,
      mimeType: file.mime_type || file.content_type || null,
    };
  }

  if (part.type === "input_file") {
    const source = part.file_data || part.data || part.url;
    if (!source) {
      const detail = part.file_id ? "file_id cannot be resolved by this local proxy; provide file_data instead" : "input_file.file_data is required";
      throw attachmentError(detail, "invalid_attachment");
    }
    return {
      source,
      filename: part.filename || filenameFromUrl(source) || `file-${index}`,
      mimeType: part.mime_type || part.content_type || null,
    };
  }

  if (part.type === "image" || part.type === "document") {
    const source = part.source || {};
    let value;
    if (source.type === "base64" && source.data) {
      value = `data:${source.media_type || "application/octet-stream"};base64,${source.data}`;
    } else if (source.type === "url" && source.url) {
      value = source.url;
    } else {
      // Claude Code may send non-uploadable document references; keep those in the prompt only.
      return null;
    }
    return {
      source: value,
      filename: part.title || filenameFromUrl(value) || `${part.type}-${index}`,
      mimeType: source.media_type || null,
    };
  }

  return null;
}

function explicitAttachmentToSpec(attachment, index) {
  if (!attachment || typeof attachment !== "object") {
    throw attachmentError(`attachments[${index - 1}] must be an object`, "invalid_attachment");
  }
  const source = attachment.file_data || attachment.data || attachment.url;
  if (!source) throw attachmentError(`attachments[${index - 1}] requires file_data, data, or url`, "invalid_attachment");
  return {
    source,
    filename: attachment.filename || attachment.name || filenameFromUrl(source) || `file-${index}`,
    mimeType: attachment.mime_type || attachment.content_type || attachment.type || null,
  };
}

async function materialize(spec, maxFileBytes) {
  let buffer;
  let mimeType = normalizeMime(spec.mimeType);

  if (typeof spec.source !== "string") {
    throw attachmentError("Attachment data must be a string", "invalid_attachment");
  }

  if (spec.source.startsWith("data:")) {
    const decoded = decodeDataUrl(spec.source);
    buffer = decoded.buffer;
    mimeType ||= decoded.mimeType;
  } else if (/^https?:\/\//i.test(spec.source)) {
    const remote = await download(spec.source, maxFileBytes);
    buffer = remote.buffer;
    mimeType ||= remote.mimeType;
  } else {
    buffer = decodeBase64(spec.source);
  }

  if (buffer.length === 0) throw attachmentError("Attachment is empty", "invalid_attachment");
  if (buffer.length > maxFileBytes) {
    throw attachmentError(`${spec.filename} exceeds the ${formatMiB(maxFileBytes)} MiB per-file limit`, "attachment_too_large");
  }

  const filename = normalizeFilename(spec.filename, mimeType);
  return {
    name: filename,
    mimeType: mimeType || "application/octet-stream",
    size: buffer.length,
    data: buffer.toString("base64"),
  };
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) throw attachmentError("Invalid data URL", "invalid_attachment");
  try {
    return {
      mimeType: normalizeMime(match[1]),
      buffer: match[2] ? decodeBase64(match[3]) : Buffer.from(decodeURIComponent(match[3]), "utf8"),
    };
  } catch (error) {
    if (error.code === "invalid_attachment") throw error;
    throw attachmentError("Invalid data URL payload", "invalid_attachment");
  }
}

function decodeBase64(value) {
  const normalized = value.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw attachmentError("Attachment data must be valid base64 or a data URL", "invalid_attachment");
  }
  return Buffer.from(normalized, "base64");
}

async function download(url, maxFileBytes) {
  let response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw attachmentError(`Could not download attachment: ${error.message}`, "attachment_download_failed");
  }
  if (!response.ok) {
    throw attachmentError(`Attachment download returned HTTP ${response.status}`, "attachment_download_failed");
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxFileBytes) {
    throw attachmentError(`Remote attachment exceeds the ${formatMiB(maxFileBytes)} MiB per-file limit`, "attachment_too_large");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimeType: normalizeMime(response.headers.get("content-type")) };
}

function normalizeFilename(value, mimeType) {
  let filename = String(value || "attachment")
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  if (!filename || filename === "." || filename === "..") filename = "attachment";

  let extension = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!extension) {
    extension = MIME_EXTENSIONS.get(mimeType);
    if (!extension) throw attachmentError(`A supported filename extension is required for ${filename}`, "unsupported_attachment_type");
    filename += extension;
  }
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    throw attachmentError(`Dola does not accept ${extension} files`, "unsupported_attachment_type");
  }
  return filename.slice(0, 240);
}

function deduplicateNames(attachments) {
  const used = new Set();
  return attachments.map((attachment) => {
    let name = attachment.name;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      const dot = attachment.name.lastIndexOf(".");
      const stem = dot > 0 ? attachment.name.slice(0, dot) : attachment.name;
      const extension = dot > 0 ? attachment.name.slice(dot) : "";
      name = `${stem}-${suffix++}${extension}`;
    }
    used.add(name.toLowerCase());
    return { ...attachment, name };
  });
}

function filenameFromUrl(value) {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").pop() || "") || null;
  } catch {
    return null;
  }
}

function normalizeMime(value) {
  return value ? String(value).split(";", 1)[0].trim().toLowerCase() : null;
}

function formatMiB(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

function attachmentError(message, code) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}
