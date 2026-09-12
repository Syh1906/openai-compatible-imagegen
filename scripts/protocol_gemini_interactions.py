"""Stateless Gemini Interactions image requests and final-output parsing."""

from protocol_contract import ImageProtocol, ImageRequest, ProtocolError, final_inline_image


def build(model, prompt, options, inputs, count):
    output = {"type": "image"}
    for source, target in (("aspectRatio", "aspect_ratio"), ("resolution", "image_size")):
        if options.get(source) is not None:
            output[target] = options[source]
    if options.get("format") is not None:
        output["mime_type"] = "image/" + options["format"]
    return ImageRequest("interactions", {"model": model, "input": [{"type": "text", "text": prompt}] + [{"type": "image", "mime_type": mime, "data": data} for mime, data in inputs], "response_format": output, "store": False}, "x-goog-api-key")


def normalize(response):
    if response.get("status") != "completed":
        raise ProtocolError("Gemini interaction did not complete", "image_response_incomplete")
    images = []
    for step in response.get("steps", []):
        if not isinstance(step, dict) or step.get("type") != "model_output":
            continue
        for content in step.get("content", []):
            if isinstance(content, dict) and content.get("type") == "image" and not content.get("thought") and content.get("data"):
                images.append(final_inline_image(content["data"], content.get("mime_type")))
    if not images:
        raise ProtocolError("Gemini returned no final image", "image_response_empty")
    return {"data": images}


ADAPTER = ImageProtocol(build, normalize, frozenset({"aspectRatio", "resolution", "format"}), single_image=True)
