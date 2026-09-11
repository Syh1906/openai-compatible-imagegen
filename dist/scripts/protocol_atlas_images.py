"""Atlas image generation request contract; polling lives in image_transport."""

from protocol_contract import ImageProtocol, ImageRequest, image_response


def build(model, prompt, options, inputs, count):
    if inputs:
        raise ValueError("Atlas does not support image editing")
    if count != 1:
        raise ValueError("Atlas accepts one candidate per request")
    payload = {"model": model, "prompt": prompt}
    for key in ("size", "quality", "moderation"):
        if options.get(key) is not None:
            payload[key] = options[key]
    if options.get("format") is not None:
        payload["output_format"] = options["format"]
    return ImageRequest("api/v1/model/generateImage", payload, transport="atlas")


ADAPTER = ImageProtocol(build, image_response, frozenset({"size", "quality", "format", "moderation"}), single_image=True, edit=False)
