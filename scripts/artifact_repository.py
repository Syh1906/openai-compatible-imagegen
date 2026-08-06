from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import struct
import time
from typing import Any, Callable


ARTIFACT_ID_PATTERN = re.compile(r"^img_[0-9A-HJKMNP-TV-Z]{26}$")
CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
MIME_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


@dataclass(frozen=True)
class ArtifactRecord:
    metadata: dict[str, Any]
    image_bytes: bytes


class ArtifactRepository:
    def __init__(
        self,
        project_root: Path,
        *,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.project_root = Path(project_root).absolute()
        self.data_root = self.project_root / "output" / "imagegen"
        self.artifacts_root = self.data_root / "artifacts"
        self.index_path = self.data_root / "index.json"
        self.id_factory = id_factory or new_artifact_id
        reject_reparse_points(self.project_root)

    def store_images(
        self,
        *,
        images: list[bytes],
        mime_type: str,
        provider: str,
        model: str,
        operation: str,
        prompt: str,
        parameters: dict[str, Any],
        parent_ids: list[str] | None = None,
        annotation_id: str | None = None,
    ) -> list[ArtifactRecord]:
        if not images:
            raise ValueError("at least one image is required")
        if mime_type not in MIME_EXTENSIONS:
            raise ValueError(f"unsupported image MIME type: {mime_type}")
        if operation not in {"generate", "edit"}:
            raise ValueError(f"unsupported artifact operation: {operation}")

        parent_ids = list(parent_ids or [])
        for parent_id in parent_ids:
            validate_artifact_id(parent_id)

        inspected = [inspect_image(image, mime_type) for image in images]
        artifact_ids = [self.id_factory() for _ in images]
        for artifact_id in artifact_ids:
            validate_artifact_id(artifact_id)
        if len(set(artifact_ids)) != len(artifact_ids):
            raise ValueError("artifact ID factory returned a duplicate ID")

        self.artifacts_root.mkdir(parents=True, exist_ok=True)
        reject_reparse_points(self.data_root)
        with self._index_lock():
            return self._store_images_locked(
                images=images,
                mime_type=mime_type,
                provider=provider,
                model=model,
                operation=operation,
                prompt=prompt,
                parameters=parameters,
                parent_ids=parent_ids,
                annotation_id=annotation_id,
                inspected=inspected,
                artifact_ids=artifact_ids,
            )

    def _store_images_locked(
        self,
        *,
        images: list[bytes],
        mime_type: str,
        provider: str,
        model: str,
        operation: str,
        prompt: str,
        parameters: dict[str, Any],
        parent_ids: list[str],
        annotation_id: str | None,
        inspected: list[tuple[int, int]],
        artifact_ids: list[str],
    ) -> list[ArtifactRecord]:
        index = self._read_index()
        for parent_id in parent_ids:
            if parent_id not in index["artifacts"]:
                raise KeyError(f"artifact not found: {parent_id}")
        for artifact_id in artifact_ids:
            if artifact_id in index["artifacts"] or (self.artifacts_root / artifact_id).exists():
                raise FileExistsError(f"artifact already exists: {artifact_id}")

        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        records: list[ArtifactRecord] = []
        index_entries: dict[str, dict[str, Any]] = {}
        for artifact_id, image_bytes, dimensions in zip(artifact_ids, images, inspected, strict=True):
            extension = MIME_EXTENSIONS[mime_type]
            artifact_dir = self.artifacts_root / artifact_id
            artifact_dir.mkdir()
            image_name = f"image.{extension}"
            image_path = artifact_dir / image_name
            image_path.write_bytes(image_bytes)

            metadata = {
                "id": artifact_id,
                "parentIds": parent_ids,
                "mimeType": mime_type,
                "width": dimensions[0],
                "height": dimensions[1],
                "provider": provider,
                "model": model,
                "operation": operation,
                "prompt": prompt,
                "parameters": dict(parameters),
                "annotationId": annotation_id,
                "createdAt": created_at,
            }
            stored_metadata = {**metadata, "imageFile": image_name}
            write_json_atomic(artifact_dir / "meta.json", stored_metadata)
            index_entries[artifact_id] = stored_metadata
            records.append(ArtifactRecord(metadata=metadata, image_bytes=image_bytes))

        index["artifacts"].update(index_entries)
        write_json_atomic(self.index_path, index)
        return records

    @contextmanager
    def _index_lock(self):
        lock_path = self.data_root / ".index.lock"
        deadline = time.monotonic() + 10
        while True:
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(descriptor)
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("artifact index is locked by another image task")
                time.sleep(0.01)
        try:
            yield
        finally:
            lock_path.unlink(missing_ok=True)

    def get_artifact(self, artifact_id: str) -> ArtifactRecord:
        validate_artifact_id(artifact_id)
        index = self._read_index()
        entry = index["artifacts"].get(artifact_id)
        if not isinstance(entry, dict):
            raise KeyError(f"artifact not found: {artifact_id}")

        artifact_dir = self.artifacts_root / artifact_id
        reject_reparse_points(artifact_dir)
        image_name = entry.get("imageFile")
        if not isinstance(image_name, str) or Path(image_name).name != image_name:
            raise ValueError(f"artifact has invalid image file: {artifact_id}")
        image_path = artifact_dir / image_name
        if not image_path.is_file():
            raise FileNotFoundError(f"artifact image is missing: {artifact_id}")

        metadata = {key: value for key, value in entry.items() if key != "imageFile"}
        metadata["childIds"] = sorted(
            candidate_id
            for candidate_id, candidate in index["artifacts"].items()
            if artifact_id in candidate.get("parentIds", [])
        )
        return ArtifactRecord(metadata=metadata, image_bytes=image_path.read_bytes())

    def get_image_path(self, artifact_id: str) -> Path:
        validate_artifact_id(artifact_id)
        index = self._read_index()
        entry = index["artifacts"].get(artifact_id)
        if not isinstance(entry, dict):
            raise KeyError(f"artifact not found: {artifact_id}")
        image_name = entry.get("imageFile")
        if not isinstance(image_name, str) or Path(image_name).name != image_name:
            raise ValueError(f"artifact has invalid image file: {artifact_id}")
        image_path = self.artifacts_root / artifact_id / image_name
        reject_reparse_points(image_path)
        if not image_path.is_file():
            raise FileNotFoundError(f"artifact image is missing: {artifact_id}")
        return image_path

    def _read_index(self) -> dict[str, Any]:
        if not self.index_path.exists():
            return {"version": 1, "artifacts": {}}
        reject_reparse_points(self.index_path)
        try:
            index = json.loads(self.index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("artifact index is not valid JSON") from exc
        if index.get("version") != 1 or not isinstance(index.get("artifacts"), dict):
            raise ValueError("artifact index has an unsupported schema")
        return index


def validate_artifact_id(artifact_id: str) -> None:
    if not ARTIFACT_ID_PATTERN.fullmatch(str(artifact_id)):
        raise ValueError(f"invalid artifact ID: {artifact_id}")


def new_artifact_id() -> str:
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    value = (timestamp_ms << 80) | int.from_bytes(secrets.token_bytes(10), "big")
    encoded = "".join(CROCKFORD_BASE32[(value >> shift) & 31] for shift in range(125, -1, -5))
    return f"img_{encoded}"


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.tmp")
    with temp_path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp_path, path)


def reject_reparse_points(path: Path) -> None:
    candidate = Path(path).absolute()
    existing: list[Path] = []
    while True:
        if candidate.exists() or candidate.is_symlink():
            existing.append(candidate)
        if candidate.parent == candidate:
            break
        candidate = candidate.parent
    for item in existing:
        is_junction = getattr(os.path, "isjunction", lambda _: False)
        if item.is_symlink() or is_junction(item):
            raise ValueError(f"artifact path contains a reparse point: {item.name}")


def inspect_image(data: bytes, mime_type: str) -> tuple[int, int]:
    if mime_type == "image/png":
        if len(data) < 24 or not data.startswith(b"\x89PNG\r\n\x1a\n") or data[12:16] != b"IHDR":
            raise ValueError("invalid PNG image")
        return struct.unpack(">II", data[16:24])
    if mime_type == "image/jpeg":
        return inspect_jpeg(data)
    if mime_type == "image/webp":
        return inspect_webp(data)
    raise ValueError(f"unsupported image MIME type: {mime_type}")


def inspect_jpeg(data: bytes) -> tuple[int, int]:
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise ValueError("invalid JPEG image")
    offset = 2
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in {0xD8, 0xD9}:
            continue
        length = int.from_bytes(data[offset : offset + 2], "big")
        if length < 2 or offset + length > len(data):
            break
        if marker in sof_markers and length >= 7:
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            if width and height:
                return width, height
        offset += length
    raise ValueError("JPEG image dimensions are missing")


def inspect_webp(data: bytes) -> tuple[int, int]:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("invalid WebP image")
    chunk = data[12:16]
    if chunk == b"VP8X":
        return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
    if chunk == b"VP8L" and data[20] == 0x2F:
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
        return int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
    raise ValueError("WebP image dimensions are missing")
