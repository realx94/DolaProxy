import test from "node:test";
import assert from "node:assert/strict";
import { resolveDolaModel } from "../src/models.js";

test("maps API model IDs to Dola modes", () => {
  assert.equal(resolveDolaModel("dola").mode, "Fast");
  assert.equal(resolveDolaModel("dola-fast").mode, "Fast");
  assert.equal(resolveDolaModel("dola-pro").mode, "Pro");
  assert.equal(resolveDolaModel("dola-image").skill, "image");
  assert.equal(resolveDolaModel("dola-video").skill, "video");
});

test("rejects unknown models", () => {
  assert.throws(() => resolveDolaModel("gpt-unknown"), (error) => (
    error.statusCode === 400 && error.code === "model_not_found"
  ));
});
