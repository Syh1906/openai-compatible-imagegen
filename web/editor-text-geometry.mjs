const MAX_TEXT_LINES = 4;


export function textAnnotationLayout(item, dimensions = {}) {
  const width = positiveDimension(dimensions.width);
  const height = positiveDimension(dimensions.height);
  const shortEdge = Math.min(width, height);
  const fontSize = 30 * shortEdge / 1000;
  const marginPx = fontSize * 0.6;
  const maxWidthPx = Math.max(fontSize * 2, Math.min(width - (marginPx * 2), width * 0.72));
  const allLines = wrapText(item?.text || "标注文字", maxWidthPx, fontSize);
  const truncated = allLines.length > MAX_TEXT_LINES;
  const lines = allLines.slice(0, MAX_TEXT_LINES);
  if (truncated) lines[lines.length - 1] = ellipsize(lines.at(-1), maxWidthPx, fontSize);
  const widthPx = Math.max(fontSize * 1.5, ...lines.map((line) => measureText(line, fontSize)));
  const ascentPx = fontSize * 1.05;
  const descentPx = fontSize * 0.28;
  const lineHeightPx = fontSize * 1.2;
  const heightPx = ascentPx + descentPx + (Math.max(1, lines.length) - 1) * lineHeightPx;
  return { width, height, fontSize, marginPx, widthPx, heightPx, ascentPx, descentPx, lineHeightPx, lines, truncated };
}

export function textAnnotationBounds(item, dimensions = {}) {
  const layout = textAnnotationLayout(item, dimensions);
  return {
    left: Number(item?.x) || 0,
    right: (Number(item?.x) || 0) + layout.widthPx / layout.width,
    top: (Number(item?.y) || 0) - layout.ascentPx / layout.height,
    bottom: (Number(item?.y) || 0) + (layout.heightPx - layout.ascentPx) / layout.height,
  };
}

export function constrainTextAnnotation(item, dimensions = {}) {
  const layout = textAnnotationLayout(item, dimensions);
  const marginX = Math.min(0.02, layout.marginPx / layout.width);
  const marginY = Math.min(0.02, layout.marginPx / layout.height);
  const minimumX = marginX;
  const maximumX = Math.max(minimumX, 1 - marginX - (layout.widthPx / layout.width));
  const minimumY = marginY + (layout.ascentPx / layout.height);
  const maximumY = Math.max(minimumY, 1 - marginY - ((layout.heightPx - layout.ascentPx) / layout.height));
  return {
    ...item,
    x: round(clamp(Number(item?.x) || 0, minimumX, maximumX)),
    y: round(clamp(Number(item?.y) || 0, minimumY, maximumY)),
  };
}

function positiveDimension(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function isWideCharacter(character) {
  const codePoint = character.codePointAt(0) || 0;
  return (codePoint >= 0x2e80 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af);
}

function wrapText(value, maximumWidth, fontSize) {
  const lines = [];
  let line = "";
  let lineWidth = 0;
  for (const character of Array.from(String(value || "标注文字").replace(/\r/g, ""))) {
    if (character === "\n") {
      lines.push(line || " ");
      line = "";
      lineWidth = 0;
      continue;
    }
    const characterWidth = measureCharacter(character, fontSize);
    if (line && lineWidth + characterWidth > maximumWidth) {
      lines.push(line);
      line = character;
      lineWidth = characterWidth;
    } else {
      line += character;
      lineWidth += characterWidth;
    }
  }
  if (line || !lines.length) lines.push(line || "标注文字");
  return lines;
}

function ellipsize(value, maximumWidth, fontSize) {
  const suffix = "...";
  const characters = Array.from(value || "");
  while (characters.length && measureText(`${characters.join("")}${suffix}`, fontSize) > maximumWidth) characters.pop();
  return `${characters.join("")}${suffix}`;
}

function measureText(value, fontSize) {
  return Array.from(value || "").reduce((total, character) => total + measureCharacter(character, fontSize), 0);
}

function measureCharacter(character, fontSize) {
  return isWideCharacter(character) ? fontSize : fontSize * 0.62;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
