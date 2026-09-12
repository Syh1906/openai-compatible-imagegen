"""Gemini generateContent is independent of the Interactions wire format."""

from urllib.parse import quote

from protocol_contract import ImageProtocol, ImageRequest, ProtocolError, final_inline_image


def build(model, prompt, options, inputs, count):
    parts = [{"text": prompt}] + [{"inlineData": {"mimeType": mime, "data": data}} for mime, data in inputs]
    generation_config = {"responseModalities": ["IMAGE"]}
    image_config = {target: options[source] for source, target in (("aspectRatio", "aspectRatio"), ("resolution", "imageSize")) if options.get(source) is not None}
    if image_config:
        generation_config["imageConfig"] = image_config
    return ImageRequest(f"models/{quote(model, safe='')}:generateContent", {"contents": [{"parts": parts}], "generationConfig": generation_config}, "x-goog-api-key")


def normalize(response):
    if response.get("promptFeedback", {}).get("blockReason"):
        raise ProtocolError("Gemini image request was blocked", "image_content_blocked")
    images = []
    for candidate in response.get("candidates", []):
        if not isinstance(candidate, dict):
            raise ProtocolError("invalid Gemini candidate")
        if candidate.get("finishReason") in {"SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"}:
            raise ProtocolError("Gemini image request was blocked", "image_content_blocked")
        for part in candidate.get("content", {}).get("parts", []):
            if not isinstance(part, dict) or part.get("thought"):
                continue
            inline = part.get("inlineData", part.get("inline_data"))
            if isinstance(inline, dict) and inline.get("data"):
                images.append(final_inline_image(inline["data"], inline.get("mimeType", inline.get("mime_type"))))
    if not images:
        raise ProtocolError("Gemini returned no final image", "image_response_empty")
    return {"data": images}


ADAPTER = ImageProtocol(build, normalize, frozenset({"aspectRatio", "resolution"}), single_image=True)
