export async function rasterizeSvgPreview(svg, {
  width,
  height,
  documentRef = document,
  ImageCtor = Image,
} = {}) {
  const canvas = documentRef.createElement("canvas");
  canvas.width = Math.max(1, Number(width) || 1);
  canvas.height = Math.max(1, Number(height) || 1);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PNG preview canvas is unavailable");

  const previewImage = new ImageCtor();
  await new Promise((resolve, reject) => {
    previewImage.onload = resolve;
    previewImage.onerror = () => reject(new Error("SVG preview could not be rendered"));
    previewImage.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  context.drawImage(previewImage, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/png");
  const separator = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/png;base64,") || separator < 0) {
    throw new Error("PNG preview encoding failed");
  }
  return { mimeType: "image/png", data: dataUrl.slice(separator + 1) };
}
