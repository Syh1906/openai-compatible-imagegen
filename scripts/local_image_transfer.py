from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

from scripts.artifact_repository import ArtifactRepository, FORMAT_MIME_TYPES, MIME_EXTENSIONS
from scripts.image_response import inspect_response_image
from scripts.repository_fs import DirectoryLease, ensure_directory_tree_safely, publish_new_file_safely


MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000


class LocalImageTransferError(Exception):
    pass


class LocalImageTransfer:
    def __init__(self, project_root: Path, artifact_root: Path) -> None:
        self.repository = ArtifactRepository(project_root, artifact_root)
        self.project_root = self.repository.project_root

    def _relative_path(self, value: str) -> Path:
        if not isinstance(value, str) or not value or "\\" in value or ":" in value:
            raise ValueError("a project-relative path using forward slashes is required")
        parts = value.split("/")
        if any(part in {"", ".", ".."} or any(ord(char) < 32 for char in part) for part in parts):
            raise ValueError("invalid project-relative path")
        relative = Path(PurePosixPath(value))
        target = self.project_root / relative
        if target.is_relative_to(self.repository.data_root):
            raise ValueError("use stable image IDs for the artifact repository")
        return relative

    def import_image(self, source_path: str) -> dict[str, Any]:
        relative = self._relative_path(source_path)
        with DirectoryLease(self.project_root) as lease:
            with lease.open_file(relative, protect_from_rename=True) as source:
                image = source.read_bytes(max_bytes=MAX_IMAGE_BYTES)
        inspection = inspect_response_image(image)
        if inspection.width * inspection.height > MAX_IMAGE_PIXELS:
            raise ValueError("local image exceeds the pixel limit")
        try:
            return self.repository.store_local_image(
                image, FORMAT_MIME_TYPES[inspection.image_format],
            ).metadata
        except (ValueError, OSError, KeyError) as error:
            raise LocalImageTransferError("local_image_import_failed") from error

    def export_image(self, image_id: str, destination_path: str) -> dict[str, Any]:
        relative = self._relative_path(destination_path)
        artifact = self.repository.get_artifact(image_id)
        mime_type = artifact.metadata["mimeType"]
        extensions = {"." + MIME_EXTENSIONS[mime_type]}
        if mime_type == "image/jpeg":
            extensions.add(".jpeg")
        if relative.suffix.lower() not in extensions:
            raise ValueError("destination extension must match the original image format")
        destination = self.project_root / relative
        directory = (
            DirectoryLease(self.project_root) if destination.parent == self.project_root
            else ensure_directory_tree_safely(self.project_root, destination.parent)
        )
        with directory as lease:
            try:
                publish_new_file_safely(lease, relative.name, artifact.image_bytes)
            except OSError as error:
                # The Windows adapter preserves native ERROR_FILE_EXISTS / ERROR_ALREADY_EXISTS.
                if sys.platform == "win32" and error.errno in {80, 183}:
                    raise FileExistsError("destination already exists") from error
                raise
        return {
            "imageId": image_id,
            "destinationPath": relative.as_posix(),
            "mimeType": mime_type,
            "byteLength": len(artifact.image_bytes),
            "sha256": hashlib.sha256(artifact.image_bytes).hexdigest(),
        }


def execute(request: dict[str, Any]) -> dict[str, Any]:
    operation = request.get("operation")
    try:
        project_root = request.get("projectRoot")
        artifact_root = request.get("artifactRoot")
        if not isinstance(project_root, str) or not Path(project_root).is_absolute():
            raise ValueError("project root is required")
        if not isinstance(artifact_root, str) or not Path(artifact_root).is_absolute():
            raise ValueError("artifact root is required")
        transfer = LocalImageTransfer(Path(project_root), Path(artifact_root))
        if operation == "import":
            return {"artifact": transfer.import_image(request.get("sourcePath"))}
        if operation == "export":
            return transfer.export_image(request.get("imageId"), request.get("destinationPath"))
        raise LocalImageTransferError("local_image_request_invalid")
    except LocalImageTransferError:
        raise
    except FileExistsError as error:
        code = "local_image_destination_exists" if operation == "export" else "local_image_import_failed"
        raise LocalImageTransferError(code) from error
    except (ValueError, OSError, KeyError) as error:
        code = "local_image_source_invalid" if operation == "import" else "local_image_export_failed"
        raise LocalImageTransferError(code) from error


if __name__ == "__main__":
    try:
        result = {"ok": True, "result": execute(json.load(sys.stdin))}
    except Exception as error:
        code = str(error) if isinstance(error, LocalImageTransferError) else "local_image_transfer_failed"
        result = {"ok": False, "error": code}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
