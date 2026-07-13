export const DOLA_MODELS = Object.freeze([
  { id: "dola", mode: "Fast", description: "Default alias for Dola Fast" },
  { id: "dola-fast", mode: "Fast", description: "Dola Fast - solves most problems" },
  { id: "dola-pro", mode: "Pro", description: "Dola Pro - advanced model" },
  { id: "dola-image", mode: "Fast", skill: "image", description: "Dola image generation" },
  { id: "dola-video", mode: "Fast", skill: "video", description: "Dola video generation" },
]);

export function resolveDolaModel(model = "dola") {
  const normalized = typeof model === "string" && model ? model.toLowerCase() : "dola";
  const selected = DOLA_MODELS.find(({ id }) => id === normalized);
  if (!selected) {
    throw Object.assign(new Error(`Unknown model: ${model}. Use a model returned by /v1/models`), {
      statusCode: 400,
      code: "model_not_found",
    });
  }
  return selected;
}
