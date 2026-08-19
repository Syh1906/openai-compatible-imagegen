from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == "win32", "Windows filesystem semantics only")
class WindowsRepositoryFsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_directory_lease_prevents_renaming_itself_and_its_parent(self) -> None:
        from scripts.windows_repository_fs import DirectoryLease

        parent = self.root / "parent"
        repository = parent / "repository"
        repository.mkdir(parents=True)

        with DirectoryLease(repository):
            with self.assertRaises(OSError):
                repository.rename(parent / "renamed-repository")
            with self.assertRaises(OSError):
                parent.rename(self.root / "renamed-parent")

        repository.rename(parent / "renamed-repository")
        (parent / "renamed-repository").rename(repository)
        parent.rename(self.root / "renamed-parent")

    def test_verified_file_reads_original_object_after_path_replacement(self) -> None:
        from scripts.windows_repository_fs import DirectoryLease

        repository = self.root / "repository"
        repository.mkdir()
        image_path = repository / "image.bin"
        image_path.write_bytes(b"original")

        with DirectoryLease(repository) as lease:
            verified_file = lease.open_file("image.bin")
        with verified_file:
            original_path = repository / "original.bin"
            image_path.rename(original_path)
            replacement = repository / "replacement.bin"
            replacement.write_bytes(b"replacement")
            replacement.rename(image_path)

            self.assertEqual(verified_file.read_bytes(), b"original")
            self.assertEqual(image_path.read_bytes(), b"replacement")

    def test_open_file_protects_every_nested_directory_from_replacement(self) -> None:
        from scripts.windows_repository_fs import DirectoryLease

        repository = self.root / "repository"
        artifact_dir = repository / "artifacts" / "img_01J00000000000000000000000"
        artifact_dir.mkdir(parents=True)
        image_path = artifact_dir / "image.bin"
        image_path.write_bytes(b"original")

        with DirectoryLease(repository) as lease:
            with lease.open_file(
                Path("artifacts") / "img_01J00000000000000000000000" / "image.bin"
            ) as verified_file:
                with self.assertRaises(OSError):
                    artifact_dir.rename(artifact_dir.with_name("replaced-artifact"))
                with self.assertRaises(OSError):
                    artifact_dir.parent.rename(repository / "replaced-artifacts")
                self.assertEqual(verified_file.read_bytes(), b"original")

    def test_live_process_lock_causes_competitor_timeout(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()
        process = self._start_lock_holder(repository, exit_without_cleanup=False)
        try:
            self.assertEqual(process.stdout.readline().strip(), "locked")
            from scripts.windows_repository_fs import RepositoryLock

            with self.assertRaises(TimeoutError):
                RepositoryLock(repository, timeout=0.05).acquire()
        finally:
            if process.poll() is None:
                process.stdin.write("release\n")
                process.stdin.flush()
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stdout + stderr)

    def test_lock_is_released_when_child_process_exits_abruptly(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()
        process = self._start_lock_holder(repository, exit_without_cleanup=True)
        self.assertEqual(process.stdout.readline().strip(), "locked")
        process.wait(timeout=5)
        self.assertEqual(process.returncode, 0)
        process.communicate()

        from scripts.windows_repository_fs import RepositoryLock

        with RepositoryLock(repository, timeout=0.5):
            self.assertTrue((repository / ".repository.lock").is_file())

    def test_submission_lock_blocks_only_the_same_submission_across_processes(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()
        submission_id = "sub_11111111111111111111111111111111"
        process = self._start_submission_lock_holder(repository, submission_id, exit_without_cleanup=False)
        try:
            self.assertEqual(process.stdout.readline().strip(), "locked")
            same_submission = self._run_submission_lock_contender(
                repository,
                submission_id,
                timeout=0.05,
            )
            self.assertEqual(same_submission.returncode, 2, same_submission.stdout + same_submission.stderr)
            self.assertEqual(same_submission.stdout.strip(), "timeout")
            different_submission = self._run_submission_lock_contender(
                repository,
                "sub_22222222222222222222222222222222",
                timeout=0.05,
            )
            self.assertEqual(
                different_submission.returncode,
                0,
                different_submission.stdout + different_submission.stderr,
            )
            self.assertEqual(different_submission.stdout.strip(), "locked")
        finally:
            process.stdin.write("release\n")
            process.stdin.flush()
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stdout + stderr)

    def test_submission_lock_is_released_when_holder_exits_abruptly(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()
        submission_id = "sub_33333333333333333333333333333333"
        process = self._start_submission_lock_holder(repository, submission_id, exit_without_cleanup=True)
        self.assertEqual(process.stdout.readline().strip(), "locked")
        process.wait(timeout=5)
        self.assertEqual(process.returncode, 0)
        process.communicate()

        from scripts.windows_repository_fs import SubmissionLock

        with SubmissionLock(repository, submission_id, timeout=0.5):
            self.assertTrue((repository / ".submission.lock").is_file())

    def test_rejects_reparse_file_leaf_and_directory_segment(self) -> None:
        from scripts.windows_repository_fs import DirectoryLease

        repository = self.root / "repository"
        repository.mkdir()
        target_file = self.root / "target.bin"
        target_file.write_bytes(b"outside")
        file_link = repository / "linked.bin"
        target_directory = self.root / "target-directory"
        target_directory.mkdir()
        directory_link = repository / "linked-directory"
        try:
            file_link.symlink_to(target_file)
            directory_link.symlink_to(target_directory, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"creating Windows symlinks is unavailable: {exc}")

        with DirectoryLease(repository) as lease:
            with self.assertRaisesRegex(ValueError, "reparse point"):
                lease.open_file("linked.bin")
        with self.assertRaisesRegex(ValueError, "reparse point"):
            DirectoryLease(directory_link)

    def test_repository_mutation_publishes_and_removes_only_known_files(self) -> None:
        from scripts.windows_repository_fs import RepositoryMutation

        repository = self.root / "repository"
        repository.mkdir()
        with RepositoryMutation(repository, timeout=0.5) as mutation:
            with self.assertRaises(OSError):
                repository.rename(self.root / "replaced-repository")
            mutation.create_directory(Path("artifacts") / "img_01J00000000000000000000000")
            mutation.publish_new_file(
                Path("artifacts") / "img_01J00000000000000000000000" / "image.png",
                b"image",
            )
            mutation.publish_replace_file("index.json", b'{"version":1,"artifacts":{}}\n')

        self.assertEqual(
            (repository / "artifacts" / "img_01J00000000000000000000000" / "image.png").read_bytes(),
            b"image",
        )
        self.assertEqual((repository / "index.json").read_bytes(), b'{"version":1,"artifacts":{}}\n')

        unknown = repository / "artifacts" / "img_01J00000000000000000000000" / "unknown.bin"
        unknown.write_bytes(b"keep")
        with RepositoryMutation(repository, timeout=0.5) as mutation:
            with self.assertRaisesRegex(OSError, "unknown entries"):
                mutation.remove_directory_if_known(
                    Path("artifacts") / "img_01J00000000000000000000000",
                    {"image.png"},
                )
        self.assertEqual(unknown.read_bytes(), b"keep")

    def test_repository_mutation_removes_a_directory_with_only_known_files(self) -> None:
        from scripts.windows_repository_fs import RepositoryMutation

        repository = self.root / "repository"
        target = repository / "artifacts" / "img_01J00000000000000000000000"
        target.mkdir(parents=True)
        (target / "image.png").write_bytes(b"image")
        (target / "meta.json").write_bytes(b"metadata")

        with RepositoryMutation(repository, timeout=0.5) as mutation:
            mutation.remove_directory_if_known(
                Path("artifacts") / "img_01J00000000000000000000000",
                {"image.png", "meta.json"},
            )

        self.assertFalse(target.exists())

    def test_repository_mutation_rolls_back_a_directory_created_in_the_same_transaction(self) -> None:
        from scripts.windows_repository_fs import RepositoryMutation

        repository = self.root / "repository"
        repository.mkdir()
        relative = Path("artifacts") / "img_01J00000000000000000000000"
        target = repository / relative

        with RepositoryMutation(repository, timeout=0.5) as mutation:
            mutation.create_directory(relative)
            mutation.publish_new_file(relative / "image.png", b"image")
            mutation.remove_directory_if_known(relative, {"image.png"})

        self.assertFalse(target.exists())

    def test_safe_directory_tree_creation_returns_a_lease_for_the_created_identity(self) -> None:
        from unittest import mock

        from scripts import windows_repository_fs as secure_fs
        from scripts.windows_repository_fs import ensure_directory_tree_safely

        project_root = self.root / "project"
        project_root.mkdir()
        existing_parent = project_root / ".imagegen"
        existing_parent.mkdir()
        artifact_root = project_root / ".imagegen" / "artifacts"
        protected_during_creation = []
        original_open_relative = secure_fs._open_directory_relative

        def observe_open(parent_handle, name, path, **kwargs):
            handle = original_open_relative(parent_handle, name, path, **kwargs)
            try:
                Path(path).rename(Path(path).with_name(f"replaced-{name}"))
            except OSError:
                protected_during_creation.append(name)
            else:
                self.fail(f"directory identity was replaceable during creation: {name}")
            return handle

        with mock.patch.object(secure_fs, "_open_directory_relative", side_effect=observe_open):
            with ensure_directory_tree_safely(project_root, artifact_root) as lease:
                self.assertEqual(lease.path, artifact_root)
                with self.assertRaises(OSError):
                    artifact_root.rename(project_root / "replacement-artifacts")
                with self.assertRaises(OSError):
                    artifact_root.parent.rename(project_root / "replacement-imagegen")

        self.assertEqual(protected_during_creation, [".imagegen", "artifacts"])
        self.assertTrue(artifact_root.is_dir())

    def test_safe_directory_tree_creation_rejects_a_reparse_segment_without_writing_outside(self) -> None:
        from scripts.windows_repository_fs import ensure_directory_tree_safely

        project_root = self.root / "project"
        project_root.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        linked = project_root / ".imagegen"
        try:
            linked.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"creating Windows directory links is unavailable: {exc}")

        with self.assertRaisesRegex(ValueError, "reparse point"):
            ensure_directory_tree_safely(project_root, linked / "artifacts")

        self.assertEqual(list(outside.iterdir()), [])

    def test_remove_reuses_the_verified_directory_handle_without_a_reopen_window(self) -> None:
        from unittest import mock

        from scripts import windows_repository_fs as secure_fs

        repository = self.root / "repository"
        target = repository / "annotations" / "ann_01J00000000000000000000000"
        target.mkdir(parents=True)
        (target / "annotation.json").write_bytes(b"record")
        renamed = target.with_name("original-annotation")
        replacement_attempted = False
        original_open = secure_fs._open_handle

        def observe_delete_open(path, **kwargs):
            nonlocal replacement_attempted
            if Path(path) == target and kwargs.get("delete_access"):
                replacement_attempted = True
                target.rename(renamed)
                target.mkdir()
                (target / "unknown.bin").write_bytes(b"replacement")
            return original_open(path, **kwargs)

        with secure_fs.RepositoryMutation(repository, timeout=0.5) as mutation:
            mutation.create_directory(Path("annotations") / target.name)
            with mock.patch.object(secure_fs, "_open_handle", side_effect=observe_delete_open):
                mutation.remove_directory_if_known(
                    Path("annotations") / target.name,
                    {"annotation.json"},
                )

        self.assertFalse(replacement_attempted)
        self.assertFalse(target.exists())
        self.assertFalse(renamed.exists())

    def test_failed_replacement_keeps_the_existing_file_and_cleans_its_temp(self) -> None:
        from unittest import mock

        from scripts import windows_repository_fs as secure_fs

        repository = self.root / "repository"
        repository.mkdir()
        index_path = repository / "index.json"
        index_path.write_bytes(b"old")

        def fail_after_validating_source(*args):
            raise OSError("publish failed")

        with secure_fs.RepositoryMutation(repository, timeout=0.5) as mutation:
            with mock.patch.object(
                secure_fs,
                "_replace_file_by_handle",
                side_effect=fail_after_validating_source,
            ):
                with self.assertRaisesRegex(OSError, "publish failed"):
                    mutation.publish_replace_file("index.json", b"new")

        self.assertEqual(index_path.read_bytes(), b"old")
        self.assertEqual(
            sorted(path.name for path in repository.iterdir()),
            [".repository.lock", "index.json"],
        )

    def test_existing_target_is_replaced_from_the_verified_source_handle(self) -> None:
        from scripts.windows_repository_fs import RepositoryMutation

        repository = self.root / "repository"
        repository.mkdir()
        target = repository / "index.json"
        target.write_bytes(b"old")

        with RepositoryMutation(repository, timeout=0.5) as mutation:
            mutation.publish_replace_file("index.json", b"new")

        self.assertEqual(target.read_bytes(), b"new")
        self.assertEqual(
            sorted(path.name for path in repository.iterdir()),
            [".repository.lock", "index.json"],
        )

    def test_all_public_paths_reject_windows_qualified_and_reserved_names(self) -> None:
        from scripts.windows_repository_fs import DirectoryLease, RepositoryMutation

        repository = self.root / "repository"
        repository.mkdir()
        invalid_paths = [
            r"C:Windows\win.ini",
            r"\Windows\win.ini",
            r"folder\stream:secret",
            r"folder\NUL.txt",
            r"folder\trailing. ",
        ]
        with DirectoryLease(repository) as lease:
            for invalid in invalid_paths:
                with self.subTest(operation="read", invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "simple relative path"):
                        lease.open_file(invalid)
        with RepositoryMutation(repository, timeout=0.5) as mutation:
            for invalid in invalid_paths:
                with self.subTest(operation="write", invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "simple relative path"):
                        mutation.publish_new_file(invalid, b"blocked")

    def test_mutation_rejects_reparse_segments_without_writing_outside(self) -> None:
        from scripts.windows_repository_fs import RepositoryMutation

        repository = self.root / "repository"
        repository.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        link = repository / "linked"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"creating Windows symlinks is unavailable: {exc}")

        with RepositoryMutation(repository, timeout=0.5) as mutation:
            with self.assertRaisesRegex(ValueError, "reparse point"):
                mutation.publish_new_file(Path("linked") / "escaped.bin", b"outside")

        self.assertEqual(list(outside.iterdir()), [])

    def test_mutation_rejects_a_reparse_repository_root_before_creating_its_lock(self) -> None:
        from scripts.windows_repository_fs import RepositoryMutation

        outside = self.root / "outside-repository"
        outside.mkdir()
        linked_repository = self.root / "linked-repository"
        try:
            linked_repository.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"creating Windows directory links is unavailable: {exc}")

        with self.assertRaisesRegex(ValueError, "reparse point"):
            with RepositoryMutation(linked_repository, timeout=0.5):
                pass

        self.assertEqual(list(outside.iterdir()), [])

    def test_all_public_paths_reject_extended_windows_reserved_names(self) -> None:
        from scripts.windows_repository_fs import DirectoryLease, RepositoryMutation

        repository = self.root / "repository"
        repository.mkdir()
        invalid_paths = [
            r".\file.bin",
            r"folder\.",
            r"NUL .txt",
            r"CONIN$",
            r"CONOUT$",
            "COM¹.txt",
            "LPT²",
        ]
        with DirectoryLease(repository) as lease:
            for invalid in invalid_paths:
                with self.subTest(operation="read", invalid=invalid):
                    with self.assertRaisesRegex(ValueError, "simple relative path"):
                        lease.open_file(invalid)
        with RepositoryMutation(repository, timeout=0.5) as mutation:
            for invalid in invalid_paths:
                operations = [
                    lambda value=invalid: mutation.create_directory(value),
                    lambda value=invalid: mutation.publish_new_file(value, b"blocked"),
                    lambda value=invalid: mutation.publish_replace_file(value, b"blocked"),
                    lambda value=invalid: mutation.remove_directory_if_known(value, set()),
                ]
                for index, operation in enumerate(operations):
                    with self.subTest(operation=index, invalid=invalid):
                        with self.assertRaisesRegex(ValueError, "simple relative path"):
                            operation()

    def test_verified_file_blocks_concurrent_in_place_writers(self) -> None:
        from scripts.windows_repository_fs import DirectoryLease

        repository = self.root / "repository"
        repository.mkdir()
        image_path = repository / "image.bin"
        image_path.write_bytes(b"original")

        with DirectoryLease(repository) as lease:
            with lease.open_file("image.bin") as verified_file:
                with self.assertRaises(OSError):
                    image_path.write_bytes(b"replacement")
                self.assertEqual(verified_file.read_bytes(), b"original")

    def _start_lock_holder(self, repository: Path, *, exit_without_cleanup: bool) -> subprocess.Popen[str]:
        exit_line = "os._exit(0)" if exit_without_cleanup else "sys.stdin.readline()"
        program = "\n".join(
            [
                "import os",
                "from pathlib import Path",
                "import sys",
                "from scripts.windows_repository_fs import RepositoryLock",
                "lock = RepositoryLock(Path(sys.argv[1]), timeout=0.5)",
                "lock.acquire()",
                "print('locked', flush=True)",
                exit_line,
                "lock.release()",
            ]
        )
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(ROOT)
        return subprocess.Popen(
            [sys.executable, "-c", program, str(repository)],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def _start_submission_lock_holder(
        self,
        repository: Path,
        submission_id: str,
        *,
        exit_without_cleanup: bool,
    ) -> subprocess.Popen[str]:
        exit_line = "os._exit(0)" if exit_without_cleanup else "sys.stdin.readline()"
        program = "\n".join(
            [
                "import os",
                "from pathlib import Path",
                "import sys",
                "from scripts.windows_repository_fs import SubmissionLock",
                "lock = SubmissionLock(Path(sys.argv[1]), sys.argv[2], timeout=0.5)",
                "lock.acquire()",
                "print('locked', flush=True)",
                exit_line,
                "lock.release()",
            ]
        )
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(ROOT)
        return subprocess.Popen(
            [sys.executable, "-c", program, str(repository), submission_id],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def _run_submission_lock_contender(
        self,
        repository: Path,
        submission_id: str,
        *,
        timeout: float,
    ) -> subprocess.CompletedProcess[str]:
        program = "\n".join(
            [
                "from pathlib import Path",
                "import sys",
                "from scripts.windows_repository_fs import SubmissionLock",
                "try:",
                "    with SubmissionLock(Path(sys.argv[1]), sys.argv[2], timeout=float(sys.argv[3])):",
                "        print('locked', flush=True)",
                "except TimeoutError:",
                "    print('timeout', flush=True)",
                "    raise SystemExit(2)",
            ]
        )
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(ROOT)
        return subprocess.run(
            [sys.executable, "-c", program, str(repository), submission_id, str(timeout)],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )


if __name__ == "__main__":
    unittest.main()
