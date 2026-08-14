import assert from "node:assert/strict";
import test from "node:test";

import { rasterizeSvgPreview } from "../web/preview-rasterizer.mjs";


test("SVG annotation previews are rasterized to PNG before ui/message", async () => {
  const drawCalls = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...args) => drawCalls.push(args) }),
    toDataURL: (mimeType) => {
      assert.equal(mimeType, "image/png");
      return "data:image/png;base64,cG5nLXByZXZpZXc=";
    },
  };
  class LoadedImage {
    set src(value) {
      assert.match(value, /^data:image\/svg\+xml/);
      queueMicrotask(() => this.onload());
    }
  }

  const result = await rasterizeSvgPreview("<svg></svg>", {
    width: 1024,
    height: 768,
    documentRef: { createElement: (tag) => {
      assert.equal(tag, "canvas");
      return canvas;
    } },
    ImageCtor: LoadedImage,
  });

  assert.deepEqual(result, { mimeType: "image/png", data: "cG5nLXByZXZpZXc=" });
  assert.equal(canvas.width, 1024);
  assert.equal(canvas.height, 768);
  assert.equal(drawCalls.length, 1);
});
