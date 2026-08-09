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

    def commit(self) -> dict[str, str]:
        backups: list[tuple[Path, Path]] = []
        published: list[Path] = []
        try:
            for stage, final in self._entries:
                if not stage.is_file():
                    raise ValueError(f"staged delivery is missing: {stage}")
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
        self._committed = True
        return {str(stage.resolve()): str(final) for stage, final in self._entries}

    def close(self) -> None:
        for root in self._roots.values():
            if root.exists():
                shutil.rmtree(root)

    def __enter__(self) -> "OutputTransaction":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()
