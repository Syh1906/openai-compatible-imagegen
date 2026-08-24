from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time
from typing import Any, Callable


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

from scripts.artifact_repository import (
    ArtifactRepository,
    FORMAT_MIME_TYPES,
    reject_reparse_points,
)
from scripts.image_response import inspect_response_image
from scripts.repository_fs import DirectoryLease, RepositoryMutation, ensure_directory_tree_safely


HANDOFF_ID_PATTERN = re.compile(r"^handoff_[0-9a-f]{64}$")
MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000
ACQUISITION = {
    "route": "chatgpt",
    "provenance": "agent-declared-host-output",
    "trustLevel": "declared",
}


class HostImageImportError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class HostImageImportManager:
    def __init__(
        self,
        project_root: Path,
        artifact_root: Path,
        *,
        handoff_id_factory: Callable[[], str] | None = None,
        artifact_id_factory: Callable[[], str] | None = None,
        epoch_ms_factory: Callable[[], int] | None = None,
    ) -> None:
        self.repository = ArtifactRepository(
            project_root,
            artifact_root,
            id_factory=artifact_id_factory,
        )
        self.project_root = self.repository.project_root
        self.artifact_root = self.repository.data_root
        self.handoff_id_factory = handoff_id_factory or (
            lambda: f"handoff_{secrets.token_hex(32)}"
        )
        self.epoch_ms_factory = epoch_ms_factory or (lambda: time.time_ns() // 1_000_000)

    def prepare(self, *, route: str, intent: str, prompt: str, count: int) -> dict[str, Any]:
        if route != "chatgpt":
            raise ValueError("host image import route is invalid")
        if intent != "generate":
            raise ValueError("host image import intent is not implemented")
        if count != 1:
            raise ValueError("host image import count must be one")
        if not isinstance(prompt, str) or not prompt.strip() or prompt != prompt.strip():
            raise ValueError("host image import prompt is invalid")
        handoff_id = self.handoff_id_factory()
        self._require_handoff_id(handoff_id)
        record = {
            "schemaVersion": "host-image-handoff.v1",
            "handoffId": handoff_id,
            "status": "prepared",
            "route": route,
            "intent": intent,
            "prompt": prompt,
            "count": count,
            "preparedEpochMs": self.epoch_ms_factory(),
        }
        relative_root = self._relative_root(handoff_id)
        with ensure_directory_tree_safely(self.project_root, self.artifact_root) as lease:
            with RepositoryMutation(self.artifact_root, directory_lease=lease) as mutation:
                mutation.create_directory(".handoffs")
                mutation.create_new_directory(relative_root)
                mutation.publish_new_file(relative_root / "handoff.json", self._encode(record))
        return {"handoffId": handoff_id, "status": "prepared"}

    def stage(self, handoff_id: str, *, host_output: dict[str, Any]) -> dict[str, Any]:
        self._require_handoff_id(handoff_id)
        if not isinstance(host_output, dict) or set(host_output) != {"type", "savedPath"}:
            raise ValueError("host image output is invalid")
        if host_output.get("type") != "codex-imagegen-saved-path":
            raise ValueError("host image output type is invalid")
        saved_path = host_output.get("savedPath")
        if not isinstance(saved_path, str) or not Path(saved_path).is_absolute():
            raise ValueError("host image output path is invalid")
        relative_root = self._relative_root(handoff_id)
        with ensure_directory_tree_safely(self.project_root, self.artifact_root) as lease:
            with RepositoryMutation(self.artifact_root, directory_lease=lease) as mutation:
                record = self._read_record(lease, relative_root)
                if record["status"] == "aborted":
                    raise ValueError("host image handoff is aborted")
                if record["status"] == "committed":
                    raise ValueError("host image handoff is already committed")
                snapshot, mime_type, width, height = self._read_host_image(
                    Path(saved_path),
                    minimum_mtime_ms=record["preparedEpochMs"],
                )
                digest = hashlib.sha256(snapshot).hexdigest()
                if record["status"] == "staged":
                    if record.get("sha256") != digest:
                        raise ValueError("host image handoff already contains another output")
                    return {"handoffId": handoff_id, "status": "staged", "imageCount": 1}
                image_path = relative_root / "image.bin"
                try:
                    mutation.publish_new_file(image_path, snapshot)
                except FileExistsError:
                    with mutation.open_file(image_path) as verified_file:
                        if verified_file.read_bytes() != snapshot:
                            raise ValueError("host image handoff contains an incomplete output")
                staged = {
                    **record,
                    "status": "staged",
                    "mimeType": mime_type,
                    "width": width,
                    "height": height,
                    "byteLength": len(snapshot),
                    "sha256": digest,
                }
                mutation.publish_new_file(relative_root / "staged.json", self._encode(staged))
        return {"handoffId": handoff_id, "status": "staged", "imageCount": 1}

    def finalize(self, handoff_id: str, *, action: str) -> dict[str, Any]:
        self._require_handoff_id(handoff_id)
        if action not in {"commit", "abort"}:
            raise ValueError("host image finalize action is invalid")
        if action == "abort":
            return self._abort(handoff_id)
        return self._commit(handoff_id)

    def _commit(self, handoff_id: str) -> dict[str, Any]:
        relative_root = self._relative_root(handoff_id)
        try:
            with DirectoryLease(self.artifact_root) as lease:
                record = self._read_record(lease, relative_root)
                if record["status"] == "aborted":
                    raise ValueError("host image handoff is aborted")
                if record["status"] == "committed":
                    artifact = self.repository.get_artifact(record["artifactId"])
                    return self._committed_result(handoff_id, artifact.metadata)
                if record["status"] != "staged":
                    raise ValueError("host image handoff has not been staged")
                with lease.open_file(relative_root / "image.bin") as verified_file:
                    snapshot = verified_file.read_bytes()
        except FileNotFoundError:
            recovered = self.repository.get_import_by_handoff_id(handoff_id)
            if recovered is None:
                raise ValueError("host image handoff was not found")
            return self._committed_result(handoff_id, recovered.metadata)

        artifact = self.repository.store_imported_image(
            image=snapshot,
            mime_type=record["mimeType"],
            prompt=record["prompt"],
            handoff_id=handoff_id,
            acquisition=ACQUISITION,
        )
        terminal = {
            "schemaVersion": "host-image-handoff.v1",
            "handoffId": handoff_id,
            "status": "committed",
            "artifactId": artifact.metadata["id"],
        }
        self._replace_with_terminal_record(
            relative_root,
            terminal,
            {"handoff.json", "staged.json", "image.bin"},
        )
        return self._committed_result(handoff_id, artifact.metadata)

    def _abort(self, handoff_id: str) -> dict[str, Any]:
        relative_root = self._relative_root(handoff_id)
        with DirectoryLease(self.artifact_root) as lease:
            record = self._read_record(lease, relative_root)
        if record["status"] == "committed":
            raise ValueError("host image handoff is already committed")
        if record["status"] == "aborted":
            return {"handoffId": handoff_id, "status": "aborted"}
        known_files = {"handoff.json"}
        if record["status"] == "staged":
            known_files.update({"staged.json", "image.bin"})
        terminal = {
            "schemaVersion": "host-image-handoff.v1",
            "handoffId": handoff_id,
            "status": "aborted",
        }
        self._replace_with_terminal_record(relative_root, terminal, known_files)
        return {"handoffId": handoff_id, "status": "aborted"}

    def _replace_with_terminal_record(
        self,
        relative_root: Path,
        record: dict[str, Any],
        known_files: set[str],
    ) -> None:
        with RepositoryMutation(self.artifact_root) as mutation:
            mutation.remove_directory_if_known(relative_root, known_files)
            mutation.create_new_directory(relative_root)
            mutation.publish_new_file(relative_root / "handoff.json", self._encode(record))

    @staticmethod
    def _read_host_image(source: Path, *, minimum_mtime_ms: int) -> tuple[bytes, str, int, int]:
        reject_reparse_points(source)
        before = source.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("host image output is not a regular file")
        if before.st_mtime_ns // 1_000_000 < minimum_mtime_ms:
            raise ValueError("host image output was not created for the current handoff")
        with source.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError("host image output is not a regular file")
            snapshot = stream.read(MAX_IMAGE_BYTES + 1)
        after = source.lstat()
        if len(snapshot) > MAX_IMAGE_BYTES:
            raise ValueError("host image output exceeds the byte limit")
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            opened.st_dev,
            opened.st_ino,
            opened.st_size,
            opened.st_mtime_ns,
        ) or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise ValueError("host image output changed while it was being read")
        inspection = inspect_response_image(snapshot)
        if inspection.width * inspection.height > MAX_IMAGE_PIXELS:
            raise ValueError("host image output exceeds the pixel limit")
        return (
            snapshot,
            FORMAT_MIME_TYPES[inspection.image_format],
            inspection.width,
            inspection.height,
        )

    @staticmethod
    def _read_record(reader: DirectoryLease | RepositoryMutation, relative_root: Path) -> dict[str, Any]:
        try:
            with reader.open_file(relative_root / "staged.json") as verified_file:
                record = json.loads(verified_file.read_bytes())
        except FileNotFoundError:
            with reader.open_file(relative_root / "handoff.json") as verified_file:
                record = json.loads(verified_file.read_bytes())
        if not isinstance(record, dict) or record.get("schemaVersion") != "host-image-handoff.v1":
            raise ValueError("host image handoff state is invalid")
        return record

    @staticmethod
    def _committed_result(handoff_id: str, metadata: dict[str, Any]) -> dict[str, Any]:
        return {"handoffId": handoff_id, "status": "committed", "artifacts": [metadata]}

    @staticmethod
    def _relative_root(handoff_id: str) -> Path:
        return Path(".handoffs") / handoff_id

    @staticmethod
    def _require_handoff_id(value: str) -> None:
        if not isinstance(value, str) or not HANDOFF_ID_PATTERN.fullmatch(value):
            raise ValueError("invalid host image handoff ID")

    @staticmethod
    def _encode(record: dict[str, Any]) -> bytes:
        return (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def execute(request: dict[str, Any]) -> dict[str, Any]:
    project_root = request.get("projectRoot")
    artifact_root = request.get("artifactRoot")
    if not isinstance(project_root, str) or not Path(project_root).is_absolute():
        raise ValueError("project root is required")
    if not isinstance(artifact_root, str) or not Path(artifact_root).is_absolute():
        raise ValueError("artifact root is required")
    manager = HostImageImportManager(Path(project_root), Path(artifact_root))
    operation = request.get("operation")
    try:
        if operation == "prepare":
            return manager.prepare(
                route=request.get("route"),
                intent=request.get("intent"),
                prompt=request.get("prompt"),
                count=request.get("count"),
            )
        if operation == "stage":
            return manager.stage(request.get("handoffId"), host_output=request.get("hostOutput"))
        if operation == "finalize":
            return manager.finalize(request.get("handoffId"), action=request.get("action"))
        raise HostImageImportError("host_image_request_invalid")
    except HostImageImportError:
        raise
    except Exception as error:
        raise HostImageImportError(_stable_error_code(manager, request, operation, error)) from error


def _stable_error_code(
    manager: HostImageImportManager,
    request: dict[str, Any],
    operation: Any,
    error: Exception,
) -> str:
    if operation == "prepare":
        return "host_image_request_invalid"
    if operation not in {"stage", "finalize"}:
        return "host_image_request_invalid"
    handoff_id = request.get("handoffId")
    if isinstance(handoff_id, str) and HANDOFF_ID_PATTERN.fullmatch(handoff_id):
        handoff_root = manager.artifact_root / ".handoffs" / handoff_id
        if not (handoff_root / "handoff.json").is_file() and not (handoff_root / "staged.json").is_file():
            if manager.repository.get_import_by_handoff_id(handoff_id) is None:
                return "host_image_handoff_not_found"
    message = str(error).lower()
    if operation == "stage":
        if "handoff" in message and any(word in message for word in ("aborted", "committed", "contains", "state")):
            return "host_image_handoff_state_invalid"
        return "host_image_output_invalid"
    if "action" in message or "invalid host image handoff id" in message:
        return "host_image_request_invalid"
    if "not found" in message:
        return "host_image_handoff_not_found"
    if "handoff" in message:
        return "host_image_handoff_state_invalid"
    return "host_image_import_failed"


def main() -> None:
    request = json.load(sys.stdin)
    result = execute(request)
    sys.stdout.write(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = error.code if isinstance(error, HostImageImportError) else "host_image_import_failed"
        sys.stdout.write(json.dumps({"ok": False, "error": code}, separators=(",", ":")))
        sys.stdout.write("\n")
