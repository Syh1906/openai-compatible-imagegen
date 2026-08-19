from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import time
from typing import Any, Callable

from scripts.image_response import inspect_response_image
from scripts.repository_fs import (
    DirectoryLease,
    RepositoryMutation,
    ensure_directory_tree_safely,
)


ARTIFACT_ID_PATTERN = re.compile(r"^img_[0-9A-HJKMNP-TV-Z]{26}$")
DELIVERY_KIND_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
DELIVERY_RECEIPT_ID_PATTERN = re.compile(r"^delivery_[0-9a-f]{64}$")
BATCH_ID_PATTERN = re.compile(r"^batch_[0-9A-HJKMNP-TV-Z]{26}$")
BATCH_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TRANSACTION_ID_PATTERN = re.compile(r"^txn_[0-9a-f]{64}$")
MAX_PENDING_TRANSACTIONS = 64
CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
MIME_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
FORMAT_MIME_TYPES = {
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
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
        self.project_root = Path(project_root).resolve(strict=False)
        self.data_root = validate_artifact_root(self.project_root, artifact_root)
        self.artifacts_root = self.data_root / "artifacts"
        self.batches_root = self.data_root / "batches"
        self.transactions_root = self.data_root / ".transactions"
        self.index_path = self.data_root / "index.json"
        self.id_factory = id_factory or new_artifact_id
        reject_reparse_points(self.project_root)

    def _recover_incomplete_transactions(
        self,
        mutation: RepositoryMutation,
        index: dict[str, Any],
    ) -> None:
        if not mutation.directory_exists(".transactions"):
            return
        entry_names = mutation.list_directory(".transactions")
        if len(entry_names) > MAX_PENDING_TRANSACTIONS:
            raise ValueError("artifact repository has too many pending transactions")
        manifests = index.get("batchManifests", {})
        if not isinstance(manifests, dict):
            raise ValueError("artifact index has invalid batch manifests")
        for marker_name in entry_names:
            if not TRANSACTION_ID_PATTERN.fullmatch(marker_name):
                raise ValueError("artifact transaction directory contains an unknown entry")
            relative_dir = Path(".transactions") / marker_name
            if not mutation.directory_exists(relative_dir):
                raise ValueError("artifact transaction directory contains an unknown entry")
            try:
                with mutation.open_file(relative_dir / "manifest.json") as verified_file:
                    payload = json.loads(verified_file.read_bytes().decode("utf-8"))
            except (FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError):
                mutation.remove_directory_if_known(relative_dir, {"manifest.json"})
                continue
            resources = normalize_transaction_resources(payload)

            indexed = []
            for resource in resources:
                if resource["kind"] == "artifact":
                    indexed.append(resource["id"] in index["artifacts"])
                else:
                    indexed.append(resource["id"] in manifests)
            if any(indexed) and not all(indexed):
                raise ValueError("artifact transaction has a partially committed index")
            if not any(indexed):
                for resource in resources:
                    relative = (
                        Path("artifacts") / resource["id"]
                        if resource["kind"] == "artifact"
                        else Path("batches") / resource["id"]
                    )
                    if mutation.directory_exists(relative):
                        mutation.remove_directory_if_known(relative, set(resource["files"]))
            mutation.remove_directory_if_known(relative_dir, {"manifest.json"})

    def _begin_transaction(
        self,
        mutation: RepositoryMutation,
        resources: list[dict[str, Any]],
    ) -> Path:
        transaction_id = f"txn_{secrets.token_hex(32)}"
        marker_dir = Path(".transactions") / transaction_id
        mutation.create_directory(".transactions")
        mutation.create_new_directory(marker_dir)
        mutation.publish_new_file(
            marker_dir / "manifest.json",
            encode_json({"version": 1, "resources": resources}),
        )
        return marker_dir

    @staticmethod
    def _finish_transaction(mutation: RepositoryMutation, marker_dir: Path) -> None:
        mutation.remove_directory_if_known(marker_dir, {"manifest.json"})

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

        with ensure_directory_tree_safely(self.project_root, self.data_root) as lease:
            with RepositoryMutation(self.data_root, directory_lease=lease) as mutation:
                self._recover_incomplete_transactions(mutation, self._read_index(lease=lease))
                marker_dir = self._begin_transaction(
                    mutation,
                    transaction_resources(artifact_ids, [mime_type] * len(images)),
                )
                mutation.create_directory("artifacts")
                records = self._store_images_locked(
                    mutation=mutation,
                    images=images,
                    mime_types=[mime_type] * len(images),
                    provider=provider,
                    model=model,
                    operation=operation,
                    prompt=prompt,
                    parameters=parameters,
                    parent_ids=parent_ids,
                    annotation_id=annotation_id,
                    inspected=inspected,
                    artifact_ids=artifact_ids,
                    derived_from=None,
                    delivery_kinds=None,
                    parameters_by_image=None,
                    directory_lease=lease,
                )
                self._finish_transaction(mutation, marker_dir)
                return records

    def store_response_images(
        self,
        *,
        images: list[bytes],
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
        if operation not in {"generate", "edit"}:
            raise ValueError(f"unsupported artifact operation: {operation}")

        parent_ids = list(parent_ids or [])
        for parent_id in parent_ids:
            validate_artifact_id(parent_id)

        inspections = [inspect_response_image(image) for image in images]
        mime_types = [FORMAT_MIME_TYPES[item.image_format] for item in inspections]
        inspected = [(item.width, item.height) for item in inspections]
        artifact_ids = [self.id_factory() for _ in images]
        for artifact_id in artifact_ids:
            validate_artifact_id(artifact_id)
        if len(set(artifact_ids)) != len(artifact_ids):
            raise ValueError("artifact ID factory returned a duplicate ID")

        with ensure_directory_tree_safely(self.project_root, self.data_root) as lease:
            with RepositoryMutation(self.data_root, directory_lease=lease) as mutation:
                self._recover_incomplete_transactions(mutation, self._read_index(lease=lease))
                marker_dir = self._begin_transaction(
                    mutation,
                    transaction_resources(artifact_ids, mime_types),
                )
                mutation.create_directory("artifacts")
                records = self._store_images_locked(
                    mutation=mutation,
                    images=images,
                    mime_types=mime_types,
                    provider=provider,
                    model=model,
                    operation=operation,
                    prompt=prompt,
                    parameters=parameters,
                    parent_ids=parent_ids,
                    annotation_id=annotation_id,
                    inspected=inspected,
                    artifact_ids=artifact_ids,
                    derived_from=None,
                    delivery_kinds=None,
                    parameters_by_image=None,
                    directory_lease=lease,
                )
                self._finish_transaction(mutation, marker_dir)
                return records

    def store_derived_images(
        self,
        *,
        images: list[bytes],
        mime_type: str,
        derived_from: str,
        delivery_kinds: list[str],
        parameters: list[dict[str, Any]],
        receipt_id: str | None = None,
        receipt: dict[str, Any] | None = None,
    ) -> list[ArtifactRecord]:
        if not images and receipt_id is None:
            raise ValueError("at least one derived image is required")
        if mime_type not in MIME_EXTENSIONS:
            raise ValueError(f"unsupported image MIME type: {mime_type}")
        validate_artifact_id(derived_from)
        if len(delivery_kinds) != len(images):
            raise ValueError("delivery kinds must match derived images")
        if len(parameters) != len(images):
            raise ValueError("derived parameters must match derived images")
        if any(not DELIVERY_KIND_PATTERN.fullmatch(str(kind)) for kind in delivery_kinds):
            raise ValueError("invalid delivery kind")
        if any(not isinstance(item, dict) for item in parameters):
            raise ValueError("derived parameters must be JSON objects")
        if (receipt_id is None) != (receipt is None):
            raise ValueError("delivery receipt ID and payload must be provided together")
        if receipt_id is not None:
            validate_delivery_receipt_id(receipt_id)
        if receipt is not None and not isinstance(receipt, dict):
            raise ValueError("delivery receipt must be a JSON object")
        if receipt is not None and receipt.get("sourceArtifactId") != derived_from:
            raise ValueError("delivery receipt source does not match derived source")

        inspected = [inspect_image(image, mime_type) for image in images]
        artifact_ids = [self.id_factory() for _ in images]
        for artifact_id in artifact_ids:
            validate_artifact_id(artifact_id)
        if len(set(artifact_ids)) != len(artifact_ids):
            raise ValueError("artifact ID factory returned a duplicate ID")

        with ensure_directory_tree_safely(self.project_root, self.data_root) as lease:
            with RepositoryMutation(self.data_root, directory_lease=lease) as mutation:
                self._recover_incomplete_transactions(mutation, self._read_index(lease=lease))
                marker_dir = (
                    self._begin_transaction(
                        mutation,
                        transaction_resources(artifact_ids, [mime_type] * len(images)),
                    )
                    if artifact_ids
                    else None
                )
                mutation.create_directory("artifacts")
                records = self._store_images_locked(
                    mutation=mutation,
                    images=images,
                    mime_types=[mime_type] * len(images),
                    provider="",
                    model="",
                    operation="derive",
                    prompt="",
                    parameters={},
                    parent_ids=[],
                    annotation_id=None,
                    inspected=inspected,
                    artifact_ids=artifact_ids,
                    derived_from=derived_from,
                    delivery_kinds=list(delivery_kinds),
                    parameters_by_image=[dict(item) for item in parameters],
                    receipt_id=receipt_id,
                    receipt=dict(receipt) if receipt is not None else None,
                    directory_lease=lease,
                )
                if marker_dir is not None:
                    self._finish_transaction(mutation, marker_dir)
                return records

    def _store_images_locked(
        self,
        *,
        mutation: RepositoryMutation,
        images: list[bytes],
        mime_types: list[str],
        provider: str,
        model: str,
        operation: str,
        prompt: str,
        parameters: dict[str, Any],
        parent_ids: list[str],
        annotation_id: str | None,
        inspected: list[tuple[int, int]],
        artifact_ids: list[str],
        derived_from: str | None,
        delivery_kinds: list[str] | None,
        parameters_by_image: list[dict[str, Any]] | None,
        receipt_id: str | None = None,
        receipt: dict[str, Any] | None = None,
        directory_lease: DirectoryLease,
    ) -> list[ArtifactRecord]:
        index = self._read_index(lease=directory_lease)
        receipts = index.get("deliveryReceipts")
        if receipts is not None and not isinstance(receipts, dict):
            raise ValueError("artifact index has invalid delivery receipts")
        if receipt_id is not None and isinstance(receipts, dict) and receipt_id in receipts:
            raise FileExistsError(f"delivery receipt already exists: {receipt_id}")
        for parent_id in parent_ids:
            if parent_id not in index["artifacts"]:
                raise KeyError(f"artifact not found: {parent_id}")
        for artifact_id in artifact_ids:
            if artifact_id in index["artifacts"] or mutation.directory_exists(Path("artifacts") / artifact_id):
                raise FileExistsError(f"artifact already exists: {artifact_id}")
        if derived_from is not None:
            source = index["artifacts"].get(derived_from)
            if not isinstance(source, dict):
                raise KeyError(f"artifact not found: {derived_from}")
            provider = str(source.get("provider") or "")
            model = str(source.get("model") or "")
            prompt = str(source.get("prompt") or "")

        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        records: list[ArtifactRecord] = []
        index_entries: dict[str, dict[str, Any]] = {}
        created_dirs: list[tuple[Path, set[str]]] = []
        try:
            for result_index, (artifact_id, image_bytes, dimensions, mime_type) in enumerate(
                zip(artifact_ids, images, inspected, mime_types, strict=True)
            ):
                extension = MIME_EXTENSIONS[mime_type]
                artifact_dir = Path("artifacts") / artifact_id
                mutation.create_new_directory(artifact_dir)
                image_name = f"image.{extension}"
                created_dirs.append((artifact_dir, {image_name, "meta.json"}))
                image_path = artifact_dir / image_name
                mutation.publish_new_file(image_path, image_bytes)

                artifact_parameters = dict(
                    parameters_by_image[result_index]
                    if parameters_by_image is not None
                    else parameters
                )
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
                if derived_from is not None and delivery_kinds is not None:
                    metadata["derivedFrom"] = derived_from
                    metadata["deliveryKind"] = delivery_kinds[result_index]
                stored_metadata = {**metadata, "imageFile": image_name}
                metadata_path = artifact_dir / "meta.json"
                mutation.publish_new_file(metadata_path, encode_json(stored_metadata))
                index_entries[artifact_id] = stored_metadata
                records.append(ArtifactRecord(metadata=metadata, image_bytes=image_bytes))

            index["artifacts"].update(index_entries)
            if receipt_id is not None and receipt is not None:
                receipt_entry = dict(receipt)
                receipt_entry["artifactIds"] = list(artifact_ids)
                receipt_entry["artifacts"] = [
                    {
                        **{
                            key: value
                            for key, value in index_entries[artifact_id].items()
                            if key != "imageFile"
                        },
                        "childIds": [],
                    }
                    for artifact_id in artifact_ids
                ]
                index.setdefault("deliveryReceipts", {})[receipt_id] = receipt_entry
            mutation.publish_replace_file("index.json", encode_json(index))
            return records
        except Exception:
            self._rollback_created_artifacts(mutation, created_dirs)
            raise

    def _rollback_created_artifacts(
        self,
        mutation: RepositoryMutation,
        created_dirs: list[tuple[Path, set[str]]],
    ) -> None:
        for artifact_dir, known_files in reversed(created_dirs):
            mutation.remove_directory_if_known(
                artifact_dir,
                known_files,
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

    def get_delivery_receipt(self, receipt_id: str) -> dict[str, Any] | None:
        validate_delivery_receipt_id(receipt_id)
        self._reject_unsafe_repository_paths()
        with DirectoryLease(self.data_root) as lease:
            index = self._read_index(lease=lease)
            receipts = index.get("deliveryReceipts")
            if receipts is None:
                return None
            if not isinstance(receipts, dict):
                raise ValueError("artifact index has invalid delivery receipts")
            entry = receipts.get(receipt_id)
            if entry is None:
                return None
            if not isinstance(entry, dict):
                raise ValueError("artifact index has an invalid delivery receipt")
            artifact_ids = entry.get("artifactIds")
            if not isinstance(artifact_ids, list):
                raise ValueError("delivery receipt artifact order is missing")
            artifacts = entry.get("artifacts")
            if not isinstance(artifacts, list) or len(artifacts) != len(artifact_ids):
                raise ValueError("delivery receipt artifact snapshots are missing")
            source_id = entry.get("sourceArtifactId")
            validate_artifact_id(str(source_id))
            self._require_artifact_entry(index, source_id)
            for artifact_id, artifact in zip(artifact_ids, artifacts, strict=True):
                validate_artifact_id(artifact_id)
                indexed_artifact = self._require_artifact_entry(index, artifact_id)
                if not isinstance(artifact, dict) or artifact.get("id") != artifact_id:
                    raise ValueError("delivery receipt artifact snapshot is invalid")
                if (
                    artifact.get("derivedFrom") != source_id
                    or indexed_artifact.get("derivedFrom") != source_id
                ):
                    raise ValueError("delivery receipt source relationship is invalid")
            return {
                **{key: value for key, value in entry.items() if key != "artifactIds"},
            }

    def store_batch_manifest(self, manifest: dict[str, Any]) -> dict[str, Any]:
        normalized = normalize_batch_manifest(manifest)
        batch_id = new_batch_id()
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        stored = {
            **normalized,
            "batchId": batch_id,
            "createdAt": created_at,
        }
        manifest_bytes = encode_json(stored)

        with ensure_directory_tree_safely(self.project_root, self.data_root) as lease:
            with RepositoryMutation(self.data_root, directory_lease=lease) as mutation:
                index = self._read_index(lease=lease)
                self._recover_incomplete_transactions(mutation, index)
                artifact_ids, receipt_ids = self._validate_batch_manifest_relationships(
                    index,
                    normalized,
                )
                manifests = index.get("batchManifests", {})
                if not isinstance(manifests, dict):
                    raise ValueError("artifact index has invalid batch manifests")
                batch_dir = Path("batches") / batch_id
                if batch_id in manifests or mutation.directory_exists(Path("batches") / batch_id):
                    raise FileExistsError(f"batch manifest already exists: {batch_id}")

                marker_dir = self._begin_transaction(
                    mutation,
                    [{
                        "kind": "batch",
                        "id": batch_id,
                        "files": ["manifest.json"],
                    }],
                )
                mutation.create_directory("batches")
                mutation.create_new_directory(batch_dir)
                try:
                    manifest_file = batch_dir / "manifest.json"
                    mutation.publish_new_file(manifest_file, manifest_bytes)
                    index.setdefault("batchManifests", {})[batch_id] = {
                        "id": batch_id,
                        "createdAt": created_at,
                        "manifestFile": manifest_file.as_posix(),
                        "artifactIds": list(dict.fromkeys(artifact_ids)),
                        "deliveryReceiptIds": list(dict.fromkeys(receipt_ids)),
                    }
                    mutation.publish_replace_file("index.json", encode_json(index))
                except Exception:
                    mutation.remove_directory_if_known(batch_dir, {"manifest.json"})
                    raise
                self._finish_transaction(mutation, marker_dir)
        return json.loads(manifest_bytes.decode("utf-8"))

    def get_batch_manifest(self, batch_id: str) -> dict[str, Any]:
        validate_batch_id(batch_id)
        self._reject_unsafe_repository_paths()
        with DirectoryLease(self.data_root) as lease:
            index = self._read_index(lease=lease)
            manifests = index.get("batchManifests")
            if not isinstance(manifests, dict):
                raise KeyError(f"batch manifest not found: {batch_id}")
            entry = manifests.get(batch_id)
            if not isinstance(entry, dict):
                raise KeyError(f"batch manifest not found: {batch_id}")
            expected_file = (Path("batches") / batch_id / "manifest.json").as_posix()
            if entry.get("id") != batch_id or entry.get("manifestFile") != expected_file:
                raise ValueError("batch manifest index entry is invalid")
            try:
                with lease.open_file(expected_file) as verified_file:
                    payload = json.loads(verified_file.read_bytes().decode("utf-8"))
            except FileNotFoundError as exc:
                raise FileNotFoundError(f"batch manifest is missing: {batch_id}") from exc
            except json.JSONDecodeError as exc:
                raise ValueError("batch manifest is not valid JSON") from exc
            if not isinstance(payload, dict):
                raise ValueError("batch manifest must be a JSON object")
            if payload.get("batchId") != batch_id or payload.get("createdAt") != entry.get("createdAt"):
                raise ValueError("batch manifest identity is invalid")
            _require_exact_fields(
                payload,
                required={
                    "schemaVersion",
                    "summary",
                    "results",
                    "batchId",
                    "createdAt",
                },
                label="stored batch manifest",
            )
            normalized = normalize_batch_manifest({
                "schemaVersion": payload["schemaVersion"],
                "summary": payload["summary"],
                "results": payload["results"],
            })
            artifact_ids, receipt_ids = self._validate_batch_manifest_relationships(
                index,
                normalized,
            )
            if entry.get("artifactIds") != artifact_ids:
                raise ValueError("batch manifest artifact IDs do not match index")
            if entry.get("deliveryReceiptIds") != receipt_ids:
                raise ValueError("batch manifest delivery receipt IDs do not match index")
            return {
                **normalized,
                "batchId": batch_id,
                "createdAt": payload["createdAt"],
            }

    @staticmethod
    def _validate_batch_manifest_relationships(
        index: dict[str, Any],
        manifest: dict[str, Any],
    ) -> tuple[list[str], list[str]]:
        receipts = index.get("deliveryReceipts", {})
        if not isinstance(receipts, dict):
            raise ValueError("artifact index has invalid delivery receipts")
        artifact_ids: list[str] = []
        receipt_ids: list[str] = []
        for result in manifest["results"]:
            if not result["ok"]:
                continue
            source_ids = result["artifactIds"]
            for source_id in source_ids:
                if source_id not in index["artifacts"]:
                    raise KeyError(f"artifact not found: {source_id}")
            expected_delivery_ids: list[str] = []
            for receipt_id in result["deliveryReceiptIds"]:
                receipt_entry = receipts.get(receipt_id)
                if not isinstance(receipt_entry, dict):
                    raise KeyError(f"delivery receipt not found: {receipt_id}")
                source_id = receipt_entry.get("sourceArtifactId")
                if source_id not in source_ids:
                    raise ValueError("batch manifest receipt references an unrelated source")
                receipt_artifact_ids = receipt_entry.get("artifactIds")
                if not isinstance(receipt_artifact_ids, list):
                    raise ValueError("batch manifest receipt artifacts are invalid")
                for artifact_id in receipt_artifact_ids:
                    validate_artifact_id(str(artifact_id))
                    artifact_entry = index["artifacts"].get(artifact_id)
                    if not isinstance(artifact_entry, dict):
                        raise KeyError(f"artifact not found: {artifact_id}")
                    if artifact_entry.get("derivedFrom") != source_id:
                        raise ValueError("batch manifest derived artifact has an invalid source")
                    expected_delivery_ids.append(artifact_id)
            if expected_delivery_ids != result["deliveryArtifactIds"]:
                raise ValueError("batch manifest delivery artifacts do not match receipts")
            artifact_ids.extend(source_ids)
            artifact_ids.extend(result["deliveryArtifactIds"])
            receipt_ids.extend(result["deliveryReceiptIds"])
        return list(dict.fromkeys(artifact_ids)), list(dict.fromkeys(receipt_ids))

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
        if "deliveryReceipts" in index and not isinstance(index["deliveryReceipts"], dict):
            raise ValueError("artifact index has invalid delivery receipts")
        if "batchManifests" in index and not isinstance(index["batchManifests"], dict):
            raise ValueError("artifact index has invalid batch manifests")
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
        for path in (
            self.data_root,
            self.artifacts_root,
            self.batches_root,
            self.transactions_root,
            self.index_path,
            *paths,
        ):
            reject_reparse_points(path, within=self.project_root)


def validate_artifact_id(artifact_id: str) -> None:
    if not ARTIFACT_ID_PATTERN.fullmatch(str(artifact_id)):
        raise ValueError(f"invalid artifact ID: {artifact_id}")


def validate_batch_id(batch_id: str) -> None:
    if not BATCH_ID_PATTERN.fullmatch(str(batch_id)):
        raise ValueError("invalid batch ID")


def transaction_resources(
    artifact_ids: list[str],
    mime_types: list[str],
) -> list[dict[str, Any]]:
    if len(artifact_ids) != len(mime_types):
        raise ValueError("transaction resources do not match artifact MIME types")
    resources = []
    for artifact_id, mime_type in zip(artifact_ids, mime_types, strict=True):
        validate_artifact_id(artifact_id)
        extension = MIME_EXTENSIONS.get(mime_type)
        if extension is None:
            raise ValueError(f"unsupported image MIME type: {mime_type}")
        resources.append({
            "kind": "artifact",
            "id": artifact_id,
            "files": [f"image.{extension}", "meta.json"],
        })
    return resources


def normalize_transaction_resources(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("artifact transaction manifest must be a JSON object")
    _require_exact_fields(
        payload,
        required={"version", "resources"},
        label="artifact transaction manifest",
    )
    if payload["version"] != 1:
        raise ValueError("unsupported artifact transaction manifest")
    raw_resources = payload["resources"]
    if not isinstance(raw_resources, list) or not 1 <= len(raw_resources) <= 256:
        raise ValueError("artifact transaction resources are invalid")
    resources: list[dict[str, Any]] = []
    identities: set[tuple[str, str]] = set()
    for resource in raw_resources:
        if not isinstance(resource, dict):
            raise ValueError("artifact transaction resource must be a JSON object")
        _require_exact_fields(
            resource,
            required={"kind", "id", "files"},
            label="artifact transaction resource",
        )
        kind = resource["kind"]
        resource_id = resource["id"]
        files = resource["files"]
        if kind == "artifact":
            validate_artifact_id(resource_id)
            allowed_files = [
                ["image.jpg", "meta.json"],
                ["image.png", "meta.json"],
                ["image.webp", "meta.json"],
            ]
            if files not in allowed_files:
                raise ValueError("artifact transaction files are invalid")
        elif kind == "batch":
            validate_batch_id(resource_id)
            if files != ["manifest.json"]:
                raise ValueError("batch transaction files are invalid")
        else:
            raise ValueError("artifact transaction resource kind is invalid")
        identity = (kind, resource_id)
        if identity in identities:
            raise ValueError("artifact transaction resources must be unique")
        identities.add(identity)
        resources.append({"kind": kind, "id": resource_id, "files": list(files)})
    return resources


def normalize_batch_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        raise ValueError("batch manifest must be a JSON object")
    _require_exact_fields(
        manifest,
        required={"schemaVersion", "summary", "results"},
        label="batch manifest",
    )
    if manifest["schemaVersion"] != "batch-manifest.v1":
        raise ValueError("unsupported batch manifest schema")
    raw_results = manifest["results"]
    if not isinstance(raw_results, list) or not 1 <= len(raw_results) <= 64:
        raise ValueError("batch manifest results must contain between 1 and 64 items")
    results = [_normalize_batch_result(result) for result in raw_results]
    request_ids = [result["requestId"] for result in results]
    if len(set(request_ids)) != len(request_ids):
        raise ValueError("batch manifest request IDs must be unique")

    raw_summary = manifest["summary"]
    if not isinstance(raw_summary, dict):
        raise ValueError("batch manifest summary must be a JSON object")
    _require_exact_fields(
        raw_summary,
        required={"total", "succeeded", "failed", "artifactCount"},
        label="batch manifest summary",
    )
    summary = {
        key: _bounded_integer(raw_summary[key], 0, 64, f"batch manifest summary {key}")
        for key in ("total", "succeeded", "failed", "artifactCount")
    }
    succeeded = sum(1 for result in results if result["ok"])
    artifact_count = sum(len(result.get("artifactIds", [])) for result in results)
    if (
        summary["total"] != len(results)
        or summary["succeeded"] != succeeded
        or summary["failed"] != len(results) - succeeded
        or summary["artifactCount"] != artifact_count
    ):
        raise ValueError("batch manifest summary does not match its results")
    return {
        "schemaVersion": "batch-manifest.v1",
        "summary": summary,
        "results": results,
    }


def _normalize_batch_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("batch manifest result must be a JSON object")
    request_id = value.get("requestId")
    if not isinstance(request_id, str) or not BATCH_REQUEST_ID_PATTERN.fullmatch(request_id):
        raise ValueError("batch manifest result has an invalid request ID")
    operation = value.get("operation")
    if operation not in {"generate", "edit"}:
        raise ValueError("batch manifest result has an invalid operation")
    if value.get("ok") is False:
        _require_exact_fields(
            value,
            required={"requestId", "operation", "ok", "errorCode"},
            label="failed batch manifest result",
        )
        error_code = value["errorCode"]
        if not isinstance(error_code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", error_code):
            raise ValueError("batch manifest result has an invalid error code")
        return {
            "requestId": request_id,
            "operation": operation,
            "ok": False,
            "errorCode": error_code,
        }
    if value.get("ok") is not True:
        raise ValueError("batch manifest result ok must be a boolean")
    _require_exact_fields(
        value,
        required={"requestId", "operation", "ok", "artifactIds"},
        optional={"apiDelivery", "deliveryReceiptIds", "deliveryArtifactIds"},
        label="successful batch manifest result",
    )
    artifact_ids = _normalize_id_list(value["artifactIds"], validate_artifact_id, 16, "artifact IDs")
    if not artifact_ids:
        raise ValueError("successful batch manifest result must contain an artifact ID")
    receipt_ids = _normalize_id_list(
        value.get("deliveryReceiptIds", []),
        validate_delivery_receipt_id,
        16,
        "delivery receipt IDs",
    )
    delivery_ids = _normalize_id_list(
        value.get("deliveryArtifactIds", []),
        validate_artifact_id,
        160,
        "delivery artifact IDs",
    )
    result = {
        "requestId": request_id,
        "operation": operation,
        "ok": True,
        "artifactIds": artifact_ids,
        "deliveryReceiptIds": receipt_ids,
        "deliveryArtifactIds": delivery_ids,
    }
    if "apiDelivery" in value:
        result["apiDelivery"] = _normalize_api_delivery(value["apiDelivery"], artifact_ids)
    return result


def _normalize_api_delivery(value: Any, artifact_ids: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("API delivery receipt must be a JSON object")
    _require_exact_fields(
        value,
        required={
            "status",
            "requestedCount",
            "returnedCount",
            "publishedCount",
            "items",
            "issues",
        },
        label="API delivery receipt",
    )
    status = value["status"]
    if status not in {"published", "published_with_warnings", "partial"}:
        raise ValueError("API delivery receipt has an invalid status")
    requested_count = _bounded_integer(value["requestedCount"], 1, 16, "requested count")
    returned_count = _bounded_integer(
        value["returnedCount"],
        0,
        2**31 - 1,
        "returned count",
    )
    published_count = _bounded_integer(value["publishedCount"], 1, 16, "published count")
    if returned_count < published_count or published_count != len(artifact_ids):
        raise ValueError("API delivery counts do not match published artifacts")
    raw_items = value["items"]
    if not isinstance(raw_items, list) or len(raw_items) > 16:
        raise ValueError("API delivery items are invalid")
    items: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            raise ValueError("API delivery item must be a JSON object")
        _require_exact_fields(
            item,
            required={"responseIndex", "artifactId", "actualFormat", "width", "height"},
            label="API delivery item",
        )
        artifact_id = item["artifactId"]
        validate_artifact_id(artifact_id)
        if artifact_id not in artifact_ids:
            raise ValueError("API delivery item references an unrelated artifact")
        actual_format = item["actualFormat"]
        if actual_format not in {"png", "jpeg", "webp"}:
            raise ValueError("API delivery item has an invalid format")
        items.append({
            "responseIndex": _bounded_integer(item["responseIndex"], 1, 16, "response index"),
            "artifactId": artifact_id,
            "actualFormat": actual_format,
            "width": _bounded_integer(item["width"], 1, 2**31 - 1, "image width"),
            "height": _bounded_integer(item["height"], 1, 2**31 - 1, "image height"),
        })
    if len(items) != published_count:
        raise ValueError("API delivery published count does not match its items")
    if [item["artifactId"] for item in items] != artifact_ids:
        raise ValueError("API delivery items do not match published artifacts")
    response_indexes = [item["responseIndex"] for item in items]
    if len(set(response_indexes)) != len(response_indexes):
        raise ValueError("API delivery items must have unique response indexes")
    if any(index > requested_count or index > returned_count for index in response_indexes):
        raise ValueError("API delivery item response index is out of range")

    raw_issues = value["issues"]
    if not isinstance(raw_issues, list) or len(raw_issues) > 64:
        raise ValueError("API delivery issues are invalid")
    allowed_codes = {
        "count_mismatch",
        "format_mismatch",
        "item_publish_failed",
        "item_unusable",
        "size_mismatch",
        "total_bytes_exceeded",
    }
    issues: list[dict[str, Any]] = []
    for issue in raw_issues:
        if not isinstance(issue, dict):
            raise ValueError("API delivery issue must be a JSON object")
        _require_exact_fields(
            issue,
            required={"code"},
            optional={"responseIndex"},
            label="API delivery issue",
        )
        if issue["code"] not in allowed_codes:
            raise ValueError("API delivery issue has an invalid code")
        normalized_issue = {"code": issue["code"]}
        if "responseIndex" in issue:
            normalized_issue["responseIndex"] = _bounded_integer(
                issue["responseIndex"],
                1,
                16,
                "response index",
            )
        issues.append(normalized_issue)
    has_count_mismatch = any(issue["code"] == "count_mismatch" for issue in issues)
    if has_count_mismatch != (returned_count != requested_count):
        raise ValueError("API delivery count mismatch issue is inconsistent")
    expected_status = "partial" if published_count != requested_count else (
        "published_with_warnings" if issues else "published"
    )
    if status != expected_status:
        raise ValueError("API delivery status does not match counts and issues")
    return {
        "status": status,
        "requestedCount": requested_count,
        "returnedCount": returned_count,
        "publishedCount": published_count,
        "items": items,
        "issues": issues,
    }


def _normalize_id_list(
    value: Any,
    validator: Callable[[str], None],
    limit: int,
    label: str,
) -> list[str]:
    if not isinstance(value, list) or len(value) > limit or any(not isinstance(item, str) for item in value):
        raise ValueError(f"batch manifest {label} are invalid")
    for item in value:
        validator(item)
    if len(set(value)) != len(value):
        raise ValueError(f"batch manifest {label} must be unique")
    return list(value)


def _require_exact_fields(
    value: dict[str, Any],
    *,
    required: set[str],
    optional: set[str] | None = None,
    label: str,
) -> None:
    allowed = required | set(optional or ())
    if set(value) != required | (set(value) & set(optional or ())):
        missing = required - set(value)
        unknown = set(value) - allowed
        detail = "missing" if missing else "unknown"
        raise ValueError(f"{label} fields are invalid ({detail})")


def _bounded_integer(value: Any, minimum: int, maximum: int, label: str) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise ValueError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


def validate_delivery_receipt_id(receipt_id: str) -> None:
    if not DELIVERY_RECEIPT_ID_PATTERN.fullmatch(str(receipt_id)):
        raise ValueError("invalid delivery receipt ID")


def new_artifact_id() -> str:
    timestamp_ms = int(time.time() * 1000) & ((1 << 48) - 1)
    value = (timestamp_ms << 80) | int.from_bytes(secrets.token_bytes(10), "big")
    encoded = "".join(CROCKFORD_BASE32[(value >> shift) & 31] for shift in range(125, -1, -5))
    return f"img_{encoded}"


def new_batch_id() -> str:
    return f"batch_{new_artifact_id()[4:]}"


def new_delivery_receipt_id() -> str:
    return f"delivery_{secrets.token_hex(32)}"


def encode_json(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def reject_reparse_points(path: Path, *, within: Path | None = None) -> None:
    candidate = Path(path).absolute()
    boundary = Path(within).absolute() if within is not None else None
    boundary_real = Path(os.path.realpath(boundary)) if boundary is not None else None
    existing: list[Path] = []
    while True:
        if candidate.exists() or candidate.is_symlink():
            existing.append(candidate)
        if boundary is not None and (
            candidate == boundary
            or (boundary_real is not None and Path(os.path.realpath(candidate)) == boundary_real)
        ):
            break
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
    reject_reparse_points(raw_artifact_root, within=raw_project_root)
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
    if mime_type not in MIME_EXTENSIONS:
        raise ValueError(f"unsupported image MIME type: {mime_type}")
    inspection = inspect_response_image(data)
    actual_mime_type = FORMAT_MIME_TYPES[inspection.image_format]
    if actual_mime_type != mime_type:
        raise ValueError(
            f"image MIME type mismatch: expected {mime_type}, got {actual_mime_type}"
        )
    return inspection.width, inspection.height


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
