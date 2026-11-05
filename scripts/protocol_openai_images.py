"""OpenAI-compatible image JSON and multipart request contract."""

from protocol_contract import ImageProtocol, ImageRequest, ProtocolError, image_response
from image_markup import validate_markup_uploads


def build(model, prompt, options, inputs, count):
    payload = {"model": model, "prompt": prompt, "n": count}
    for source, target in (("size", "size"), ("quality", "quality"), ("format", "output_format"), ("background", "background"), ("compression", "output_compression"), ("moderation", "moderation")):
        if options.get(source) is not None:
            payload[target] = options[source]
    return ImageRequest("images/edits" if inputs else "images/generations", payload, transport="multipart" if inputs else "json")


ADAPTER = ImageProtocol(build, image_response, frozenset({"size", "quality", "format", "background", "compression", "moderation"}), mask=True)


def validate_request(operation, payload, files):
    """Validate format-specific API contracts without inferring model capabilities."""
    try:
        _validate_request(operation, payload, files)
    except (ValueError, OSError) as error:
        raise ProtocolError(str(error), "invalid_task") from error


def _validate_request(operation, payload, files):
    fmt = payload.get("output_format", "png")
    if fmt in {"gif", "svg"}:
        if operation != "generate" or files:
            raise ValueError("GIF and SVG output require image generation")
        if any(payload.get(key) is not None for key in ("output_compression", "prompt_rewriter")) or payload.get("stream") or payload.get("partial_images"):
            raise ValueError("GIF and SVG do not support streaming, partial images, compression or prompt rewriting")
        if fmt == "svg" and payload.get("n", 1) != 1:
            raise ValueError("SVG generation requires n=1")
        if fmt == "gif" and payload.get("size", "auto") != "auto":
            size = str(payload["size"]).split("x")
            if len(size) != 2 or any(not edge.isdigit() or int(edge) <= 0 or int(edge) % 16 for edge in size):
                raise ValueError("GIF frame dimensions must be positive multiples of 16")
    for key, minimum, maximum in (("frame_count", 2, 64), ("frame_duration_ms", 20, 2000)):
        if key in payload:
            value = payload[key]
            if fmt != "gif" or type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"{key} requires GIF output and an integer between {minimum} and {maximum}")
    names = {upload[0] for upload in files or []}
    if "markup" in names and (operation != "edit" or "mask" in names or payload.get("prompt_rewriter") is not None):
        raise ValueError("markup requires an edit without mask or prompt_rewriter")
    if "markup" in names:
        validate_markup_uploads(files)
