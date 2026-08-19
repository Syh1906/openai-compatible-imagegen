from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import zlib


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "image_runtime.py"


def load_imagegen():
    spec = importlib.util.spec_from_file_location("imagegen_runtime_under_test", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load image_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def make_png(width: int, height: int, alpha: int = 255) -> bytes:
    raw = bytearray()
    for _ in range(height):
        raw.append(0)
        raw.extend((0, 128, 255, alpha) * width)

    def chunk(kind: bytes, data: bytes) -> bytes:
        checksum = zlib.crc32(kind + data) & 0xFFFFFFFF
        return len(data).to_bytes(4, "big") + kind + data + checksum.to_bytes(4, "big")

    return b"\x89PNG\r\n\x1a\n" + b"".join(
        [
            chunk(
                b"IHDR",
                width.to_bytes(4, "big")
                + height.to_bytes(4, "big")
                + b"\x08\x06\x00\x00\x00",
            ),
            chunk(b"IDAT", zlib.compress(bytes(raw))),
            chunk(b"IEND", b""),
        ]
    )
