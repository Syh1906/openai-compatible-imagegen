from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import re
import sys
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

from scripts.repository_fs import DirectoryLease, RepositoryMutation


ARTIFACT_ID_PATTERN = re.compile(r"^img_[0-9A-HJKMNP-TV-Z]{26}$")
ANNOTATION_ID_PATTERN = re.compile(r"^ann_[0-9A-HJKMNP-TV-Z]{26}$")
IMAGE_FILE_BY_MIME_TYPE = {
    "image/png": "image.png",
    "image/jpeg": "image.jpg",
    "image/webp": "image.webp",
}


def _require_id(value: Any, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"invalid {label} ID")
    return value


def _read_file(lease: DirectoryLease | RepositoryMutation, relative_path: Path) -> bytes:
    with lease.open_file(relative_path) as verified_file:
        return verified_file.read_bytes()


def _read_json(lease: DirectoryLease | RepositoryMutation, relative_path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(_read_file(lease, relative_path))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} has an unsupported schema")
    return value


def _read_artifact(lease: DirectoryLease, image_id: str) -> dict[str, Any]:
    index = _read_json(lease, Path("index.json"), "artifact index")
    artifacts = index.get("artifacts")
    if index.get("version") != 1 or not isinstance(artifacts, dict):
        raise ValueError("artifact index has an unsupported schema")
    entry = artifacts.get(image_id)
    if not isinstance(entry, dict):
        raise FileNotFoundError("artifact not found")
    if entry.get("id") != image_id:
        raise ValueError("artifact has an invalid identity")
    image_name = entry.get("imageFile")
    expected_name = IMAGE_FILE_BY_MIME_TYPE.get(entry.get("mimeType"))
    if image_name != expected_name:
        raise ValueError("artifact has an invalid image file")
    image_snapshot = _read_file(
        lease,
        Path("artifacts") / image_id / image_name,
    )
    metadata = {key: value for key, value in entry.items() if key != "imageFile"}
    metadata["childIds"] = sorted(
        candidate_id
        for candidate_id, candidate in artifacts.items()
        if isinstance(candidate, dict) and image_id in candidate.get("parentIds", [])
    )
    return {
        "metadata": metadata,
        "dataBase64": base64.b64encode(image_snapshot).decode("ascii"),
    }


def read_artifact(repository: Path, image_id: str) -> dict[str, Any]:
    image_id = _require_id(image_id, ARTIFACT_ID_PATTERN, "artifact")
    with DirectoryLease(repository) as lease:
        return _read_artifact(lease, image_id)


def _read_annotation(lease: DirectoryLease | RepositoryMutation, annotation_id: str) -> dict[str, Any]:
    root = Path("annotations") / annotation_id
    record = _read_json(lease, root / "annotation.json", "annotation record")
    if (
        record.get("id") != annotation_id
        or not isinstance(record.get("imageId"), str)
        or not isinstance(record.get("items"), list)
    ):
        raise ValueError("annotation record is invalid")
    preview_file = record.get("previewFile")
    mask_file = record.get("maskFile")
    if preview_file != "preview.svg" or mask_file not in {None, "mask.png"}:
        raise ValueError("annotation derivative file is invalid")
    _read_file(lease, root / preview_file)
    if mask_file:
        _read_file(lease, root / mask_file)
    return record


def read_annotation(repository: Path, annotation_id: str) -> dict[str, Any]:
    annotation_id = _require_id(annotation_id, ANNOTATION_ID_PATTERN, "annotation")
    with DirectoryLease(repository) as lease:
        return _read_annotation(lease, annotation_id)


def save_annotation_files(
    repository: Path,
    annotation_id: str,
    preview_snapshot: bytes,
    mask_snapshot: bytes | None,
    record: dict[str, Any],
) -> None:
    annotation_id = _require_id(annotation_id, ANNOTATION_ID_PATTERN, "annotation")
    if record.get("id") != annotation_id:
        raise ValueError("annotation record identity does not match")
    relative_root = Path("annotations") / annotation_id
    known_files = {"preview.svg", "annotation.json"}
    if mask_snapshot is not None:
        known_files.add("mask.png")
    created = False
    with RepositoryMutation(repository) as mutation:
        try:
            mutation.create_new_directory(relative_root)
            created = True
            mutation.publish_new_file(relative_root / "preview.svg", preview_snapshot)
            if mask_snapshot is not None:
                mutation.publish_new_file(relative_root / "mask.png", mask_snapshot)
            record_snapshot = (
                json.dumps(record, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
            mutation.publish_new_file(relative_root / "annotation.json", record_snapshot)
        except BaseException:
            if created:
                try:
                    mutation.remove_directory_if_known(relative_root, known_files)
                except FileNotFoundError:
                    pass
            raise


def delete_annotation(repository: Path, annotation_id: str) -> None:
    annotation_id = _require_id(annotation_id, ANNOTATION_ID_PATTERN, "annotation")
    with RepositoryMutation(repository) as mutation:
        record = _read_annotation(mutation, annotation_id)
        known_files = {"annotation.json", "preview.svg"}
        if record.get("maskFile") == "mask.png":
            known_files.add("mask.png")
        mutation.remove_directory_if_known(
            Path("annotations") / annotation_id,
            known_files,
        )


def execute(request: dict[str, Any]) -> dict[str, Any]:
    repository_value = request.get("artifactRoot")
    if not isinstance(repository_value, str) or not Path(repository_value).is_absolute():
        raise ValueError("artifact root is required")
    repository = Path(repository_value).absolute()
    operation = request.get("operation")
    if operation == "read-artifact":
        return read_artifact(repository, request.get("imageId"))
    if operation == "read-annotation":
        return read_annotation(repository, request.get("annotationId"))
    if operation == "save-annotation-files":
        preview = base64.b64decode(request.get("previewBase64"), validate=True)
        mask_value = request.get("maskBase64")
        mask = None if mask_value is None else base64.b64decode(mask_value, validate=True)
        record = request.get("record")
        if not isinstance(record, dict):
            raise ValueError("annotation record is required")
        save_annotation_files(
            repository,
            request.get("annotationId"),
            preview,
            mask,
            record,
        )
        return {"status": "saved"}
    if operation == "delete-annotation":
        delete_annotation(repository, request.get("annotationId"))
        return {"status": "deleted"}
    raise ValueError("repository operation is invalid")


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.parse_args()
    request = json.load(sys.stdin)
    result = execute(request)
    sys.stdout.write(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stdout.write(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
        sys.stdout.write("\n")
