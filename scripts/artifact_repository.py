from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import struct
import time
from typing import Any, Callable

from scripts.windows_repository_fs import (
    DirectoryLease,
    RepositoryMutation,
    ensure_directory_tree_safely,
)


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
        artifact_root: Path,
        *,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.project_root = Path(project_root).absolute()
        self.data_root = validate_artifact_root(self.project_root, artifact_root)
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

        with ensure_directory_tree_safely(self.project_root, self.data_root):
            with RepositoryMutation(self.data_root) as mutation:
                mutation.create_directory("artifacts")
                return self._store_images_locked(
                    mutation=mutation,
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
        mutation: RepositoryMutation,
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
        created_dirs: list[Path] = []
        try:
            for result_index, (artifact_id, image_bytes, dimensions) in enumerate(
                zip(artifact_ids, images, inspected, strict=True)
            ):
                extension = MIME_EXTENSIONS[mime_type]
                artifact_dir = Path("artifacts") / artifact_id
                mutation.create_new_directory(artifact_dir)
                created_dirs.append(artifact_dir)
                image_name = f"image.{extension}"
                image_path = artifact_dir / image_name
                mutation.publish_new_file(image_path, image_bytes)

                artifact_parameters = dict(parameters)
                if isinstance(artifact_parameters.get("submissionId"), str):
                    artifact_parameters["submissionResultIndex"] = result_index
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
                    "parameters": artifact_parameters,
                    "annotationId": annotation_id,
                    "createdAt": created_at,
                }
                stored_metadata = {**metadata, "imageFile": image_name}
                metadata_path = artifact_dir / "meta.json"
                mutation.publish_new_file(metadata_path, encode_json(stored_metadata))
                index_entries[artifact_id] = stored_metadata
                records.append(ArtifactRecord(metadata=metadata, image_bytes=image_bytes))

            index["artifacts"].update(index_entries)
            mutation.publish_replace_file("index.json", encode_json(index))
            return records
        except Exception:
            self._rollback_created_artifacts(mutation, created_dirs, extension=MIME_EXTENSIONS[mime_type])
            raise

    def _rollback_created_artifacts(
        self,
        mutation: RepositoryMutation,
        created_dirs: list[Path],
        *,
        extension: str,
    ) -> None:
        for artifact_dir in reversed(created_dirs):
            mutation.remove_directory_if_known(
                artifact_dir,
                {f"image.{extension}", "meta.json"},
            )

    def get_artifact(self, artifact_id: str) -> ArtifactRecord:
        validate_artifact_id(artifact_id)
        self._reject_unsafe_repository_paths()
        with DirectoryLease(self.data_root) as lease:
            return self._read_artifact_with_lease(lease, artifact_id)

    def get_image_path(self, artifact_id: str) -> Path:
        image_path, _ = self.get_image_snapshot(artifact_id)
        return image_path

    def get_image_snapshot(self, artifact_id: str) -> tuple[Path, bytes]:
        validate_artifact_id(artifact_id)
        self._reject_unsafe_repository_paths()
        with DirectoryLease(self.data_root) as lease:
            index = self._read_index(lease=lease)
            entry = self._require_artifact_entry(index, artifact_id)
            image_name = self._require_image_name(entry, artifact_id)
            relative_path = Path("artifacts") / artifact_id / image_name
            try:
                with lease.open_file(relative_path) as verified_file:
                    image_bytes = verified_file.read_bytes()
            except FileNotFoundError as exc:
                raise FileNotFoundError(f"artifact image is missing: {artifact_id}") from exc
            return self.data_root / relative_path, image_bytes

    def find_edits_by_submission_id(
        self,
        submission_id: str,
        *,
        parent_id: str,
        annotation_id: str | None,
        request_fingerprint: str,
    ) -> list[dict[str, Any]] | None:
        validate_artifact_id(parent_id)
        self._reject_unsafe_repository_paths()
        with DirectoryLease(self.data_root) as lease:
            index = self._read_index(lease=lease)
            matches = [
                artifact_id
                for artifact_id, entry in index["artifacts"].items()
                if entry.get("operation") == "edit"
                and isinstance(entry.get("parameters"), dict)
                and entry["parameters"].get("submissionId") == submission_id
            ]
            if not matches:
                return None
            indexed_matches: list[tuple[int, str]] = []
            for artifact_id in matches:
                entry = index["artifacts"][artifact_id]
                parameters = entry["parameters"]
                if (
                    entry.get("parentIds") != [parent_id]
                    or entry.get("annotationId") != annotation_id
                    or parameters.get("submissionRequestFingerprint") != request_fingerprint
                ):
                    raise ValueError("edit submission does not match the requested edit")
                result_index = parameters.get("submissionResultIndex")
                if result_index is None and len(matches) == 1:
                    result_index = 0
                if type(result_index) is not int or result_index < 0:
                    raise ValueError("edit submission result order is missing or invalid")
                indexed_matches.append((result_index, artifact_id))

            indexed_matches.sort()
            if [result_index for result_index, _ in indexed_matches] != list(range(len(matches))):
                raise ValueError("edit submission result order is incomplete or duplicated")
            return [
                self._artifact_metadata(index, artifact_id, index["artifacts"][artifact_id])
                for _, artifact_id in indexed_matches
            ]

    def _read_index(self, *, lease: DirectoryLease | None = None) -> dict[str, Any]:
        self._reject_unsafe_repository_paths()
        try:
            if lease is None:
                with DirectoryLease(self.data_root) as owned_lease:
                    with owned_lease.open_file("index.json") as verified_file:
                        payload = verified_file.read_bytes()
            else:
                with lease.open_file("index.json") as verified_file:
                    payload = verified_file.read_bytes()
            index = json.loads(payload.decode("utf-8"))
        except FileNotFoundError:
            return {"version": 1, "artifacts": {}}
        except json.JSONDecodeError as exc:
            raise ValueError("artifact index is not valid JSON") from exc
        if index.get("version") != 1 or not isinstance(index.get("artifacts"), dict):
            raise ValueError("artifact index has an unsupported schema")
        return index

    def _read_artifact_with_lease(self, lease: DirectoryLease, artifact_id: str) -> ArtifactRecord:
        index = self._read_index(lease=lease)
        entry = self._require_artifact_entry(index, artifact_id)
        image_name = self._require_image_name(entry, artifact_id)
        relative_path = Path("artifacts") / artifact_id / image_name
        try:
            with lease.open_file(relative_path) as verified_file:
                image_bytes = verified_file.read_bytes()
        except FileNotFoundError as exc:
            raise FileNotFoundError(f"artifact image is missing: {artifact_id}") from exc
        return ArtifactRecord(
            metadata=self._artifact_metadata(index, artifact_id, entry),
            image_bytes=image_bytes,
        )

    @staticmethod
    def _require_artifact_entry(index: dict[str, Any], artifact_id: str) -> dict[str, Any]:
        entry = index["artifacts"].get(artifact_id)
        if not isinstance(entry, dict):
            raise KeyError(f"artifact not found: {artifact_id}")
        return entry

    @staticmethod
    def _require_image_name(entry: dict[str, Any], artifact_id: str) -> str:
        extension = MIME_EXTENSIONS.get(entry.get("mimeType"))
        image_name = entry.get("imageFile")
        if extension is None or image_name != f"image.{extension}":
            raise ValueError(f"artifact has invalid image file: {artifact_id}")
        return image_name

    @staticmethod
    def _artifact_metadata(
        index: dict[str, Any],
        artifact_id: str,
        entry: dict[str, Any],
    ) -> dict[str, Any]:
        metadata = {key: value for key, value in entry.items() if key != "imageFile"}
        metadata["childIds"] = sorted(
            candidate_id
            for candidate_id, candidate in index["artifacts"].items()
            if isinstance(candidate, dict) and artifact_id in candidate.get("parentIds", [])
        )
        return metadata

    def _reject_unsafe_repository_paths(self, *paths: Path) -> None:
        for path in (self.data_root, self.artifacts_root, self.index_path, *paths):
            reject_reparse_points(path)


def validate_artifact_id(artifact_id: str) -> None:
    if not ARTIFACT_ID_PATTERN.fullmatch(str(artifact_id)):
        raise ValueError(f"invalid artifact ID: {artifact_id}")


def new_artifact_id() -> str:
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    value = (timestamp_ms << 80) | int.from_bytes(secrets.token_bytes(10), "big")
    encoded = "".join(CROCKFORD_BASE32[(value >> shift) & 31] for shift in range(125, -1, -5))
    return f"img_{encoded}"


def encode_json(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


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


def validate_artifact_root(project_root: Path, artifact_root: Path) -> Path:
    raw_project_root = Path(project_root).absolute()
    candidate = Path(artifact_root)
    if not candidate.is_absolute():
        raise ValueError("artifact root must be absolute")
    raw_artifact_root = candidate.absolute()
    reject_reparse_points(raw_project_root)
    reject_reparse_points(raw_artifact_root)
    resolved_project_root = raw_project_root.resolve(strict=False)
    resolved_artifact_root = raw_artifact_root.resolve(strict=False)
    try:
        relative = resolved_artifact_root.relative_to(resolved_project_root)
    except ValueError as exc:
        raise ValueError("artifact root must be inside the project root") from exc
    if not relative.parts:
        raise ValueError("artifact root must be a strict descendant of the project root")
    if resolved_artifact_root.exists() and not resolved_artifact_root.is_dir():
        raise ValueError("artifact root must be a directory")
    return resolved_artifact_root


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
