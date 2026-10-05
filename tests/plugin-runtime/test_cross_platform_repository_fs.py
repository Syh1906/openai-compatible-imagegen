from __future__ import annotations

import concurrent.futures
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]


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


class PosixCachedDirectoryCleanupTests(unittest.TestCase):
    def test_cleanup_refreshes_cached_entries_and_preserves_unknown_files(self) -> None:
        from scripts import posix_repository_fs

        for entry in ("manifest.json", "unowned.json"):
            with self.subTest(entry=entry):
                entries = {entry}
                enumeration_refreshed = False
                mutation = object.__new__(posix_repository_fs.RepositoryMutation)
                mutation.repository = Path("repository")
                mutation._directory_handles = {("transactions", "pending"): 17}

                def rewind(descriptor, offset, whence):
                    nonlocal enumeration_refreshed
                    self.assertEqual((descriptor, offset, whence), (17, 0, os.SEEK_SET))
                    enumeration_refreshed = True
                    return 0

                def list_entries(descriptor):
                    self.assertEqual(descriptor, 17)
                    return list(entries) if enumeration_refreshed else []

                def unlink(name, *, dir_fd):
                    self.assertEqual(dir_fd, 17)
                    entries.remove(name)

                def remove_directory(name, *, dir_fd):
                    self.assertEqual((name, dir_fd), ("pending", 13))
                    if entries:
                        raise OSError("directory not empty")

                with (
                    mock.patch.object(mutation, "_parent_fd", return_value=13),
                    mock.patch.object(posix_repository_fs.os, "lseek", side_effect=rewind),
                    mock.patch.object(posix_repository_fs.os, "listdir", side_effect=list_entries),
                    mock.patch.object(posix_repository_fs.os, "stat", return_value=SimpleNamespace(st_mode=0o100600)),
                    mock.patch.object(posix_repository_fs.os, "unlink", side_effect=unlink) as unlink_call,
                    mock.patch.object(posix_repository_fs.os, "fsync"),
                    mock.patch.object(posix_repository_fs.os, "close") as close_call,
                    mock.patch.object(posix_repository_fs.os, "rmdir", side_effect=remove_directory) as rmdir_call,
                ):
                    if entry == "manifest.json":
                        mutation.remove_directory_if_known("transactions/pending", {"manifest.json"})
                        self.assertEqual(entries, set())
                        rmdir_call.assert_called_once()
                    else:
                        with self.assertRaisesRegex(OSError, "unknown entries"):
                            mutation.remove_directory_if_known("transactions/pending", {"manifest.json"})
                        self.assertEqual(entries, {"unowned.json"})
                        unlink_call.assert_not_called()
                        rmdir_call.assert_not_called()
                    close_call.assert_called_once_with(17)


class RepositoryFsContractTests(unittest.TestCase):
    def test_repository_mutation_publishes_immutable_artifacts_and_replaces_the_index(self) -> None:
        from scripts.repository_fs import DirectoryLease, RepositoryMutation, ensure_directory_tree_safely

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root).absolute()
            repository = project_root / "output" / "imagegen"
            ensure_directory_tree_safely(project_root, repository).close()

            with RepositoryMutation(repository) as mutation:
                mutation.create_directory("artifacts")
                mutation.create_new_directory(Path("artifacts") / "candidate")
                mutation.publish_new_file(Path("artifacts") / "candidate" / "image.png", b"image")
                mutation.publish_new_file("index.json", b"first")
                mutation.publish_replace_file("index.json", b"second")

            with DirectoryLease(repository) as lease:
                with lease.open_file(Path("artifacts") / "candidate" / "image.png") as snapshot:
                    self.assertEqual(snapshot.read_bytes(), b"image")
                with lease.open_file("index.json") as snapshot:
                    self.assertEqual(snapshot.read_bytes(), b"second")
                    self.assertEqual(snapshot.read_bytes(max_bytes=6), b"second")
                    with self.assertRaisesRegex(ValueError, "byte limit"):
                        snapshot.read_bytes(max_bytes=5)

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


@unittest.skipIf(sys.platform == "win32", "POSIX filesystem semantics require Linux or macOS")
class PosixRepositoryFsTests(unittest.TestCase):
    def test_repository_mutation_uses_the_verified_directory_after_path_replacement(self) -> None:
        from scripts.repository_fs import RepositoryMutation, ensure_directory_tree_safely

        with tempfile.TemporaryDirectory() as root:
            project_root = Path(root).absolute()
            repository = project_root / "output" / "imagegen"
            moved_repository = project_root / "output" / "verified-imagegen"

            with ensure_directory_tree_safely(project_root, repository) as lease:
                repository.rename(moved_repository)
                repository.mkdir()

                with RepositoryMutation(repository, directory_lease=lease) as mutation:
                    mutation.create_directory("artifacts")

            self.assertEqual(list(repository.iterdir()), [])
            self.assertTrue((moved_repository / "artifacts").is_dir())

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


class PosixRepositoryLockCoordinationTests(unittest.TestCase):
    def test_persistent_locks_open_a_file_created_by_another_process(self) -> None:
        from scripts import posix_repository_fs

        repository = Path("/")
        lease = SimpleNamespace(path=repository, _handles=[101])

        def racing_open(parent_fd, name, flags, mode=0o600):
            self.assertEqual(parent_fd, 101)
            self.assertIn(name, {".repository.lock", ".submission.lock"})
            if flags & os.O_CREAT:
                if flags & os.O_EXCL:
                    raise FileExistsError(name)
                raise FileNotFoundError(2, "concurrent create-or-open lost the file", name)
            return 200

        fake_fcntl = SimpleNamespace(LOCK_UN=8, flock=lambda descriptor, operation: None)
        with (
            mock.patch.object(posix_repository_fs, "_absolute_path", return_value=repository),
            mock.patch.object(posix_repository_fs, "_open_regular_file_at", side_effect=racing_open),
            mock.patch.object(posix_repository_fs, "_acquire_lock", return_value=None),
            mock.patch.object(posix_repository_fs, "_fcntl_module", return_value=fake_fcntl),
            mock.patch.object(posix_repository_fs.os, "fstat", return_value=SimpleNamespace(st_dev=1, st_ino=2)),
            mock.patch.object(posix_repository_fs.os, "close"),
        ):
            for kind in ("repository", "submission"):
                with self.subTest(kind=kind):
                    if kind == "repository":
                        with posix_repository_fs.RepositoryLock(repository, directory_lease=lease) as lock:
                            self.assertEqual(lock._handle, 200)
                    else:
                        key = (101, 200)
                        try:
                            self.assertEqual(posix_repository_fs._retain_submission_file_handle(lease, key), 200)
                        finally:
                            if key in posix_repository_fs._SUBMISSION_FILE_HANDLES:
                                posix_repository_fs._discard_submission_file_handle(key)

    def test_repository_lock_serializes_lock_file_opening_between_threads(self) -> None:
        from scripts import posix_repository_fs

        repository = Path("/")
        lease = SimpleNamespace(path=repository, _handles=[101])
        first_open_started = threading.Event()
        second_worker_started = threading.Event()
        release_first_open = threading.Event()
        overlap_observed = threading.Event()
        state_guard = threading.Lock()
        active_open = 0
        next_descriptor = 200

        def open_lock_file(parent_fd: int, name: str, flags: int, mode: int = 0o600) -> int:
            del parent_fd, flags, mode
            nonlocal active_open, next_descriptor
            self.assertEqual(name, ".repository.lock")
            with state_guard:
                if active_open:
                    overlap_observed.set()
                    raise FileNotFoundError(2, "No such file or directory", name)
                active_open += 1
                descriptor = next_descriptor
                next_descriptor += 1
            first_open_started.set()
            if not release_first_open.wait(timeout=2):
                raise TimeoutError("test did not release the first lock-file open")
            with state_guard:
                active_open -= 1
            return descriptor

        def acquire_repository_lock(*, second: bool) -> None:
            if second:
                second_worker_started.set()
            with posix_repository_fs.RepositoryLock(
                repository,
                timeout=1,
                directory_lease=lease,
            ):
                pass

        fake_fcntl = SimpleNamespace(LOCK_UN=8, flock=lambda descriptor, operation: None)
        with (
            mock.patch.object(posix_repository_fs, "_absolute_path", return_value=repository),
            mock.patch.object(posix_repository_fs, "_open_regular_file_at", side_effect=open_lock_file),
            mock.patch.object(posix_repository_fs, "_acquire_lock", return_value=None),
            mock.patch.object(posix_repository_fs, "_fcntl_module", return_value=fake_fcntl),
            mock.patch.object(
                posix_repository_fs.os,
                "fstat",
                return_value=SimpleNamespace(st_dev=1, st_ino=2),
            ),
            mock.patch.object(posix_repository_fs.os, "close", return_value=None),
            concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor,
        ):
            first = executor.submit(acquire_repository_lock, second=False)
            self.assertTrue(first_open_started.wait(timeout=1))
            second = executor.submit(acquire_repository_lock, second=True)
            self.assertTrue(second_worker_started.wait(timeout=1))
            overlap_observed.wait(timeout=0.5)
            release_first_open.set()
            first.result(timeout=2)
            second.result(timeout=2)

        self.assertFalse(overlap_observed.is_set())


if __name__ == "__main__":
    unittest.main()
