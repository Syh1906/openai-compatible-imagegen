const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeHexColor(value) {
  const color = typeof value === "string" ? value.trim() : "";
  return HEX_COLOR.test(color) ? color.toLowerCase() : null;
}

export function hexToRgb(value) {
  const color = normalizeHexColor(value);
  if (!color) return null;
  return {
    red: Number.parseInt(color.slice(1, 3), 16),
    green: Number.parseInt(color.slice(3, 5), 16),
    blue: Number.parseInt(color.slice(5, 7), 16),
  };
}

export function rgbToHex(red, green, blue) {
  const channels = [red, green, blue].map(Number);
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function rgbToHsv(red, green, blue) {
  const channels = [red, green, blue].map(Number);
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return null;
  const [r, g, b] = channels.map((channel) => channel / 255);
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta && maximum === r) hue = 60 * (((g - b) / delta) % 6);
  else if (delta && maximum === g) hue = 60 * ((b - r) / delta + 2);
  else if (delta) hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  return {
    hue,
    saturation: maximum === 0 ? 0 : delta / maximum,
    value: maximum,
  };
}

export function hsvToRgb(hue, saturation, value) {
  const h = Number(hue);
  const s = Number(saturation);
  const v = Number(value);
  if (![h, s, v].every(Number.isFinite) || s < 0 || s > 1 || v < 0 || v > 1) return null;
  const normalizedHue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const secondary = chroma * (1 - Math.abs((normalizedHue / 60) % 2 - 1));
  const offset = v - chroma;
  let channels;
  if (normalizedHue < 60) channels = [chroma, secondary, 0];
  else if (normalizedHue < 120) channels = [secondary, chroma, 0];
  else if (normalizedHue < 180) channels = [0, chroma, secondary];
  else if (normalizedHue < 240) channels = [0, secondary, chroma];
  else if (normalizedHue < 300) channels = [secondary, 0, chroma];
  else channels = [chroma, 0, secondary];
  const [red, green, blue] = channels.map((channel) => Math.round((channel + offset) * 255));
  return { red, green, blue };
}

export function hexToHsv(value) {
  const rgb = hexToRgb(value);
  return rgb ? rgbToHsv(rgb.red, rgb.green, rgb.blue) : null;
}

export function hsvToHex(hue, saturation, value) {
  const rgb = hsvToRgb(hue, saturation, value);
  return rgb ? rgbToHex(rgb.red, rgb.green, rgb.blue) : null;
}
