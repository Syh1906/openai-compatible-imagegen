"""Staged publication for multi-file image deliveries."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import tempfile
from typing import Any


def remap_transaction_paths(value: Any, mapping: dict[str, str]) -> Any:
    normalized = {
        Path(source).resolve().as_posix(): Path(target).resolve().as_posix()
        for source, target in mapping.items()
    }
    if isinstance(value, str):
        try:
            key = Path(value).resolve().as_posix()
        except OSError:
            return value
        return normalized.get(key, value)
    if isinstance(value, list):
        return [remap_transaction_paths(item, mapping) for item in value]
    if isinstance(value, dict):
        return {key: remap_transaction_paths(item, mapping) for key, item in value.items()}
    return value


class OutputTransaction:
    def __init__(self) -> None:
        self._roots: dict[Path, Path] = {}
        self._entries: list[tuple[Path, Path]] = []
        self._committed = False

    def directory(self, final_dir: Path) -> Path:
        final_dir.mkdir(parents=True, exist_ok=True)
        resolved = final_dir.resolve()
        root = self._roots.get(resolved)
        if root is None:
            root = Path(tempfile.mkdtemp(prefix=".imagegen-stage-", dir=resolved))
            self._roots[resolved] = root
        return root

    def stage_path(self, final: Path) -> Path:
        stage = self.directory(final.parent) / final.name
        self.register(stage, final)
        return stage

    def register(self, stage: Path, final: Path) -> None:
        final = final.resolve()
        if any(existing_final == final for _, existing_final in self._entries):
            raise ValueError(f"duplicate delivery target: {final}")
        self._entries.append((stage, final))

    def checkpoint(self) -> int:
        """Return a marker that can discard later staged deliveries."""
        if self._committed:
            raise ValueError("cannot checkpoint staged deliveries after commit")
        return len(self._entries)

    def discard_since(self, checkpoint: int) -> None:
        """Discard every pending publication registered after a checkpoint."""
        if self._committed:
            raise ValueError("cannot discard staged deliveries after commit")
        if checkpoint < 0 or checkpoint > len(self._entries):
            raise ValueError("invalid delivery transaction checkpoint")
        del self._entries[checkpoint:]

    def discard_stages(self, stages: list[Path]) -> None:
        """Remove selected staged files from the pending publication set."""
        if self._committed:
            raise ValueError("cannot discard staged deliveries after commit")
        rejected = {stage.resolve() for stage in stages}
        self._entries = [
            (stage, final)
            for stage, final in self._entries
            if stage.resolve() not in rejected
        ]

    def commit(self) -> dict[str, str]:
        if self._committed:
            raise ValueError("cannot commit staged deliveries more than once")
        self._commit_entries(self._entries)
        self._committed = True
        return {str(stage.resolve()): str(final) for stage, final in self._entries}

    def commit_isolated(
        self,
        stage_groups: list[list[Path]],
    ) -> tuple[dict[str, str], list[str | None]]:
        """Commit each stage group atomically while preserving successful peers."""
        if self._committed:
            raise ValueError("cannot commit staged deliveries more than once")
        entry_by_stage = {stage.resolve(): (stage, final) for stage, final in self._entries}
        grouped_entries: list[list[tuple[Path, Path]]] = []
        assigned: set[Path] = set()
        for stages in stage_groups:
            entries: list[tuple[Path, Path]] = []
            for stage in stages:
                resolved = stage.resolve()
                entry = entry_by_stage.get(resolved)
                if entry is None:
                    continue
                if resolved in assigned:
                    raise ValueError(f"staged delivery belongs to multiple commit groups: {stage}")
                assigned.add(resolved)
                entries.append(entry)
            grouped_entries.append(entries)
        if assigned != set(entry_by_stage):
            missing = next(iter(set(entry_by_stage) - assigned))
            raise ValueError(f"staged delivery is missing a commit group: {missing}")

        mapping: dict[str, str] = {}
        failures: list[str | None] = []
        for entries in grouped_entries:
            try:
                self._commit_entries(entries)
            except Exception as exc:
                failures.append(str(exc))
                continue
            failures.append(None)
            mapping.update(
                {str(stage.resolve()): str(final) for stage, final in entries}
            )
        self._committed = True
        return mapping, failures

    def _commit_entries(self, entries: list[tuple[Path, Path]]) -> None:
        backups: list[tuple[Path, Path]] = []
        published: list[Path] = []
        try:
            self._validate_entries(entries)
            for stage, final in entries:
                if final.exists():
                    backup = self.directory(final.parent) / f"backup-{len(backups):04d}-{final.name}"
                    os.replace(final, backup)
                    backups.append((backup, final))
                os.replace(stage, final)
                published.append(final)
        except Exception:
            for final in reversed(published):
                if final.exists():
                    final.unlink()
            for backup, final in reversed(backups):
                if backup.exists():
                    os.replace(backup, final)
            raise

    def _validate_entries(self, entries: list[tuple[Path, Path]]) -> None:
        for stage, final in entries:
            if not stage.is_file() or stage.is_symlink():
                raise ValueError(f"staged delivery must be a regular file: {stage}")
            if final.is_symlink() or (final.exists() and not final.is_file()):
                raise ValueError(f"delivery target must be a regular file: {final}")

    def close(self) -> None:
        for root in self._roots.values():
            if root.exists():
                shutil.rmtree(root)

    def __enter__(self) -> "OutputTransaction":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()
