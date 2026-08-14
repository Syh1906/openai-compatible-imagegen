import assert from "node:assert/strict";
import test from "node:test";

import { hexToHsv, hsvToHex, hsvToRgb, rgbToHsv } from "../web/editor-color.mjs";


test("HSV helpers keep the controlled color panel in sync with RGB and HEX", () => {
  assert.deepEqual(rgbToHsv(255, 0, 0), { hue: 0, saturation: 1, value: 1 });
  assert.deepEqual(hsvToRgb(120, 1, 1), { red: 0, green: 255, blue: 0 });
  assert.equal(hsvToHex(240, 1, 1), "#0000ff");

  const green = hexToHsv("#22c55e");
  assert.ok(green);
  assert.equal(hsvToHex(green.hue, green.saturation, green.value), "#22c55e");
});

test("HSV helpers reject invalid saturation and value inputs", () => {
  assert.equal(hsvToRgb(120, -0.1, 1), null);
  assert.equal(hsvToRgb(120, 1, 1.1), null);
  assert.equal(hexToHsv("not-a-color"), null);
});
