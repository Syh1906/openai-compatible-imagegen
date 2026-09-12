"""OpenAI-compatible image JSON and multipart request contract."""

from protocol_contract import ImageProtocol, ImageRequest, image_response


def build(model, prompt, options, inputs, count):
    payload = {"model": model, "prompt": prompt, "n": count}
    for source, target in (("size", "size"), ("quality", "quality"), ("format", "output_format"), ("background", "background"), ("compression", "output_compression"), ("moderation", "moderation")):
        if options.get(source) is not None:
            payload[target] = options[source]
    return ImageRequest("images/edits" if inputs else "images/generations", payload, transport="multipart" if inputs else "json")


ADAPTER = ImageProtocol(build, image_response, frozenset({"size", "quality", "format", "background", "compression", "moderation"}), mask=True)
