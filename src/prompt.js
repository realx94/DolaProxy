export function messagesToPrompt(messages) {
  const normalized = messages.map((message) => ({
    role: String(message.role || "user"),
    content: contentToText(message.content),
  }));

  if (normalized.length === 1 && normalized[0].role === "user") {
    return normalized[0].content;
  }

  const transcript = normalized
    .map(({ role, content }) => `<${role}>\n${content}\n</${role}>`)
    .join("\n\n");

  return [
    "Continue the following conversation. Obey system and developer instructions, then answer the final user message as the assistant.",
    "Do not quote the transcript or add role labels unless the user asks for them.",
    "",
    transcript,
  ].join("\n");
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);

  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" || part?.type === "input_text") return part.text || "";
    if (part?.type === "image_url") return `[Attached image: ${attachmentName(part.image_url?.url || part.image_url, "image")}]`;
    if (part?.type === "file") return `[Attached file: ${part.file?.filename || "file"}]`;
    if (part?.type === "input_file") return `[Attached file: ${part.filename || "file"}]`;
    return `[Unsupported content: ${part?.type || "unknown"}]`;
  }).join("\n");
}

function attachmentName(value, fallback) {
  if (typeof value !== "string" || value.startsWith("data:")) return fallback;
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").pop()) || fallback;
  } catch {
    return fallback;
  }
}
