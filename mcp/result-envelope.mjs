export const IMAGE_RESULT_ENVELOPE_PREFIX = "IMAGEGEN_RESULT_V1:";
const IMAGE_ID_PATTERN = /^img_[0-9A-HJKMNP-TV-Z]{26}$/;

export function createImageResultEnvelope(imageIds) {
  return `${IMAGE_RESULT_ENVELOPE_PREFIX}${JSON.stringify({ imageIds })}`;
}

export function extractImageResultEnvelopeIds(result) {
  const firstContent = Array.isArray(result?.content) ? result.content[0] : null;
  if (firstContent?.type !== "text" || typeof firstContent.text !== "string") return [];
  if (!firstContent.text.startsWith(IMAGE_RESULT_ENVELOPE_PREFIX)) return [];

  let envelope;
  try {
    envelope = JSON.parse(firstContent.text.slice(IMAGE_RESULT_ENVELOPE_PREFIX.length));
  } catch {
    return [];
  }
  if (
    !envelope
    || typeof envelope !== "object"
    || Array.isArray(envelope)
    || Object.keys(envelope).length !== 1
    || !Array.isArray(envelope.imageIds)
    || envelope.imageIds.length < 1
    || envelope.imageIds.length > 10
    || !envelope.imageIds.every((imageId) => typeof imageId === "string" && IMAGE_ID_PATTERN.test(imageId))
    || new Set(envelope.imageIds).size !== envelope.imageIds.length
  ) return [];

  return [...envelope.imageIds];
}
