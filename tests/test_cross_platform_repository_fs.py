from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CrossPlatformRepositoryImportTests(unittest.TestCase):
    def test_plugin_runtime_imports_without_loading_the_windows_adapter_on_macos(self) -> None:
        script = """
import importlib
import importlib.abc
import sys
import urllib.request

class RejectWindowsAdapter(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in {"scripts.windows_repository_fs", "windows_repository_fs"}:
            raise ModuleNotFoundError("Windows repository adapter must not load on macOS")
        return None

sys.platform = "darwin"
sys.meta_path.insert(0, RejectWindowsAdapter())
for module_name in (
    "scripts.image_runtime",
    "scripts.repository_fs_helper",
    "scripts.migrate_image_config",
):
    importlib.import_module(module_name)
"""
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(ROOT)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"

        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)


@unittest.skipIf(sys.platform == "win32", "POSIX filesystem semantics require Linux or macOS")
class PosixRepositoryFsTests(unittest.TestCase):
    def test_repository_mutation_publishes_and_replaces_files(self) -> None:
        from scripts.repository_fs import DirectoryLease, RepositoryMutation, ensure_directory_tree_safely

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root).absolute()
            repository = project_root / "output" / "imagegen"
            ensure_directory_tree_safely(project_root, repository).close()

            with RepositoryMutation(repository) as mutation:
                mutation.create_directory("artifacts")
                mutation.create_new_directory(Path("artifacts") / "candidate")
                mutation.publish_new_file(Path("artifacts") / "candidate" / "image.png", b"first")
                mutation.publish_replace_file(Path("artifacts") / "candidate" / "image.png", b"second")

            with DirectoryLease(repository) as lease:
                with lease.open_file(Path("artifacts") / "candidate" / "image.png") as snapshot:
                    self.assertEqual(snapshot.read_bytes(), b"second")

    def test_repository_and_submission_locks_reject_conflicting_owners(self) -> None:
        from scripts.repository_fs import RepositoryLock, SubmissionLock, ensure_directory_tree_safely

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root).absolute()
            repository = project_root / "output" / "imagegen"
            ensure_directory_tree_safely(project_root, repository).close()

            with RepositoryLock(repository, timeout=0):
                with self.assertRaisesRegex(TimeoutError, "locked by another image task"):
                    RepositoryLock(repository, timeout=0).acquire()

            first_id = "sub_" + "1" * 32
            second_id = "sub_" + "2" * 32
            with SubmissionLock(repository, first_id, timeout=0):
                with SubmissionLock(repository, second_id, timeout=0):
                    with self.assertRaisesRegex(TimeoutError, "edit submission is still in progress"):
                        SubmissionLock(repository, first_id, timeout=0).acquire()

    def test_repository_rejects_symbolic_link_components(self) -> None:
        from scripts.repository_fs import DirectoryLease

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root).absolute()
            target = project_root / "target"
            linked = project_root / "linked"
            target.mkdir()
            linked.symlink_to(target, target_is_directory=True)

            with self.assertRaises((OSError, ValueError)):
                DirectoryLease(linked)


if __name__ == "__main__":
    unittest.main()
