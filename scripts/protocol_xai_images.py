"""xAI image JSON protocol; model IDs and parameter values remain configured."""

from protocol_contract import ImageProtocol, ImageRequest, image_response
import re


def build(model, prompt, options, inputs, count):
    payload = {"model": model, "prompt": prompt, "n": count, "response_format": "b64_json"}
    for source, target in (("aspectRatio", "aspect_ratio"), ("resolution", "resolution"), ("quality", "quality")):
        if options.get(source) is not None:
            value = options[source]
            payload[target] = value.lower() if source == "resolution" and re.fullmatch(r"\d+[kK]", value) else value
    if inputs:
        objects = [{"url": f"data:{mime};base64,{data}", "type": "image_url"} for mime, data in inputs]
        payload["image" if len(objects) == 1 else "images"] = objects[0] if len(objects) == 1 else objects
    return ImageRequest("images/edits" if inputs else "images/generations", payload)


ADAPTER = ImageProtocol(build, image_response, frozenset({"aspectRatio", "resolution", "quality"}))
