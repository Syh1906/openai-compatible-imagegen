import json
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from scripts.reveal_in_explorer import (
    WindowsShellApi,
    WindowsWindowApi,
    ensure_target_explorer_visible,
    main,
    open_and_select_shell_item,
    reveal_artifact,
    reveal_in_explorer,
)


IMAGE_ID = "img_01J00000000000000000000000"


class FakeShellApi:
    def __init__(self):
        self.targets = []

    def select_file(self, target):
        self.targets.append(target)
        return {
            "targetSelected": True,
            "windowVisible": True,
            "windowForeground": True,
        }


class FakeWindowApi:
    def __init__(self, *, windows=None):
        self.windows = [{
            "handle": 42,
            "folder_path": "F:/artifacts/img_01J00000000000000000000000",
            "selected_paths": ["F:/artifacts/img_01J00000000000000000000000/image.png"],
            "visible": False,
            "foreground": False,
        }] if windows is None else windows
        self.restored = []
        self.foregrounded = []

    def is_window_visible(self, window):
        return next(item["visible"] for item in self.windows if item["handle"] == window)

    def restore_window(self, window):
        self.restored.append(window)
        next(item for item in self.windows if item["handle"] == window)["visible"] = True

    def set_foreground_window(self, window):
        self.foregrounded.append(window)
        for item in self.windows:
            item["foreground"] = item["handle"] == window

    def is_window_foreground(self, window):
        return next(item["foreground"] for item in self.windows if item["handle"] == window)

    def get_selected_paths(self, window, folder_path):
        return next(item["selected_paths"] for item in self.windows if item["handle"] == window)

    def find_explorer_windows(self, folder_path):
        expected = canonical_path(folder_path)
        return [
            item["handle"]
            for item in self.windows
            if canonical_path(item["folder_path"]) == expected
        ]


class RevealInExplorerTests(unittest.TestCase):
    def test_main_accepts_only_the_artifact_root_and_image_id(self):
        expected = {
            "status": "revealed",
            "targetSelected": True,
            "windowVisible": True,
            "windowForeground": True,
        }
        output = io.StringIO()
        with patch("scripts.reveal_in_explorer.reveal_artifact", return_value=expected) as reveal:
            with redirect_stdout(output):
                main(["--artifact-root", "F:/output/imagegen", "--image-id", IMAGE_ID])

        reveal.assert_called_once_with("F:/output/imagegen", IMAGE_ID)
        self.assertEqual(json.loads(output.getvalue()), expected)

    @unittest.skipUnless(os.name == "nt", "Windows repository leases are required")
    def test_reveal_artifact_resolves_the_fixed_mime_filename_from_one_repository_lease(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository, image_path = create_artifact_fixture(Path(temporary_directory))
            shell_api = FakeShellApi()

            result = reveal_artifact(
                repository,
                IMAGE_ID,
                os_name="nt",
                shell_api=shell_api,
            )

            self.assertEqual(result["status"], "revealed")
            self.assertEqual(shell_api.targets, [str(image_path.resolve(strict=False))])

    @unittest.skipUnless(os.name == "nt", "Windows handle sharing semantics are required")
    def test_reveal_holds_the_artifact_directory_and_image_until_shell_confirmation(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository, image_path = create_artifact_fixture(Path(temporary_directory))
            artifact_directory = image_path.parent
            renamed_directory = artifact_directory.with_name(f"{IMAGE_ID}-renamed")
            index_path = repository / "index.json"

            class LockCheckingShellApi(FakeShellApi):
                def __init__(self):
                    super().__init__()
                    self.directory_rename_blocked = False
                    self.image_rename_blocked = False
                    self.image_write_blocked = False
                    self.index_rename_blocked = False
                    self.index_write_blocked = False

                def select_file(self, target):
                    try:
                        artifact_directory.rename(renamed_directory)
                    except OSError:
                        self.directory_rename_blocked = True
                    try:
                        image_path.rename(image_path.with_name("image-renamed.png"))
                    except OSError:
                        self.image_rename_blocked = True
                    try:
                        image_path.write_bytes(b"changed during reveal")
                    except OSError:
                        self.image_write_blocked = True
                    try:
                        index_path.rename(index_path.with_name("index-renamed.json"))
                    except OSError:
                        self.index_rename_blocked = True
                    try:
                        index_path.write_text("{}", encoding="utf-8")
                    except OSError:
                        self.index_write_blocked = True
                    return super().select_file(target)

            shell_api = LockCheckingShellApi()
            result = reveal_artifact(
                repository,
                IMAGE_ID,
                os_name="nt",
                shell_api=shell_api,
            )

            self.assertEqual(result["status"], "revealed")
            self.assertTrue(shell_api.directory_rename_blocked)
            self.assertTrue(shell_api.image_rename_blocked)
            self.assertTrue(shell_api.image_write_blocked)
            self.assertTrue(shell_api.index_rename_blocked)
            self.assertTrue(shell_api.index_write_blocked)
            artifact_directory.rename(renamed_directory)
            renamed_image = renamed_directory / "image.png"
            renamed_image.write_bytes(b"changed after reveal")
            self.assertEqual(renamed_image.read_bytes(), b"changed after reveal")
            index_path.write_text("{}", encoding="utf-8")
            self.assertEqual(index_path.read_text(encoding="utf-8"), "{}")

    @unittest.skipUnless(os.name == "nt", "Windows repository leases are required")
    def test_reveal_artifact_rejects_a_mime_filename_mismatch_before_shell_selection(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            repository, _ = create_artifact_fixture(
                Path(temporary_directory),
                image_file="image.jpg",
                mime_type="image/png",
            )
            shell_api = FakeShellApi()

            with self.assertRaisesRegex(ValueError, "invalid image file"):
                reveal_artifact(repository, IMAGE_ID, os_name="nt", shell_api=shell_api)

            self.assertEqual(shell_api.targets, [])

    def test_shell_selection_passes_parent_folder_and_relative_child(self):
        class FakeShell32:
            def __init__(self):
                self.freed = []
                self.selection = None

            def ILCreateFromPathW(self, target):
                return 101

            def ILClone(self, file_id):
                return 202

            def ILRemoveLastID(self, folder_id):
                return True

            def ILFindLastID(self, file_id):
                return 303

            def SHOpenFolderAndSelectItems(self, folder_id, count, children, flags):
                self.selection = (folder_id, count, children[0], flags)
                return 0

            def ILFree(self, item_id):
                self.freed.append(item_id)

        shell32 = FakeShell32()

        result = open_and_select_shell_item(shell32, "F:/artifacts/image.png")

        self.assertEqual(result, 0)
        self.assertEqual(shell32.selection, (202, 1, 303, 0))
        self.assertEqual(shell32.freed, [202, 101])

    def test_reveal_uses_the_validated_absolute_file_once(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            target = Path(temporary_directory, "image.png")
            target.write_bytes(b"image")
            shell_api = FakeShellApi()

            result = reveal_in_explorer(target, os_name="nt", shell_api=shell_api)

            self.assertEqual(
                result,
                {
                    "status": "revealed",
                    "targetSelected": True,
                    "windowVisible": True,
                    "windowForeground": True,
                },
            )
            self.assertEqual(shell_api.targets, [str(target.resolve())])

    def test_reveal_rejects_unsupported_platforms_and_missing_files(self):
        shell_api = FakeShellApi()
        with self.assertRaisesRegex(RuntimeError, "not supported"):
            reveal_in_explorer(Path("image.png"), os_name="posix", shell_api=shell_api)
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            reveal_in_explorer(Path("image.png"), os_name="nt", shell_api=shell_api)
        self.assertEqual(shell_api.targets, [])

    def test_hidden_target_explorer_is_restored_even_when_another_window_has_focus(self):
        window_api = FakeWindowApi()

        result = ensure_target_explorer_visible(
            Path("F:/artifacts/img_01J00000000000000000000000/image.png"),
            window_api,
        )

        self.assertEqual(window_api.restored, [42])
        self.assertEqual(window_api.foregrounded, [42])
        self.assertEqual(
            result,
            {
                "targetSelected": True,
                "windowVisible": True,
                "windowForeground": True,
            },
        )
        self.assertTrue(window_api.is_window_visible(42))

    def test_hidden_target_explorer_is_visible_before_foreground_activation(self):
        target = Path("F:/artifacts/img_01J00000000000000000000000/image.png")

        class DelayedRestoreWindowApi(FakeWindowApi):
            def __init__(self):
                super().__init__(windows=[{
                    "handle": 42,
                    "folder_path": str(target.parent),
                    "selected_paths": [str(target)],
                    "visible": False,
                    "foreground": False,
                }])
                self.visibility_reads = 0
                self.foreground_visible = []

            def is_window_visible(self, window):
                self.visibility_reads += 1
                if self.visibility_reads >= 3:
                    next(item for item in self.windows if item["handle"] == window)["visible"] = True
                return super().is_window_visible(window)

            def restore_window(self, window):
                self.restored.append(window)

            def set_foreground_window(self, window):
                self.foreground_visible.append(self.is_window_visible(window))
                return super().set_foreground_window(window)

        window_api = DelayedRestoreWindowApi()

        result = ensure_target_explorer_visible(
            target,
            window_api,
            timeout_seconds=0.1,
            sleep_seconds=0.001,
        )

        self.assertEqual(result["windowVisible"], True)
        self.assertEqual(window_api.restored, [42])
        self.assertEqual(window_api.foregrounded, [42])
        self.assertEqual(window_api.foreground_visible, [True])

    def test_shell_selection_precedes_the_only_foreground_activation(self):
        target = Path("F:/artifacts/img_01J00000000000000000000000/image.png")
        events = []
        window_api = FakeWindowApi(windows=[
            {
                "handle": 11,
                "folder_path": str(target.parent),
                "selected_paths": [str(target.parent / "other.png")],
                "visible": True,
                "foreground": False,
            },
            {
                "handle": 12,
                "folder_path": str(target.parent),
                "selected_paths": [],
                "visible": False,
                "foreground": False,
            },
        ])

        class FakeOle32:
            def CoInitializeEx(self, reserved, mode):
                return 0

            def CoUninitialize(self):
                events.append("com-uninitialize")

        class FakeShell32:
            def ILCreateFromPathW(self, path):
                return 101

            def ILClone(self, file_id):
                return 202

            def ILRemoveLastID(self, folder_id):
                return True

            def ILFindLastID(self, file_id):
                return 303

            def SHOpenFolderAndSelectItems(self, folder_id, count, children, flags):
                events.append("shell-select")
                window_api.windows[1]["selected_paths"] = [str(target)]
                return 0

            def ILFree(self, item_id):
                return None

        original_set_foreground = window_api.set_foreground_window

        def set_foreground_window(window):
            events.append(f"foreground:{window}")
            return original_set_foreground(window)

        window_api.set_foreground_window = set_foreground_window
        shell_api = WindowsShellApi.__new__(WindowsShellApi)
        shell_api.ole32 = FakeOle32()
        shell_api.shell32 = FakeShell32()
        shell_api.window_api = window_api

        result = shell_api.select_file(str(target))

        self.assertEqual(result["targetSelected"], True)
        self.assertEqual(
            events,
            ["shell-select", "foreground:12", "com-uninitialize"],
        )
        self.assertEqual(window_api.restored, [12])
        self.assertEqual(window_api.foregrounded, [12])

    def test_same_name_explorer_window_cannot_claim_the_target(self):
        target = Path("F:/project-a/output/imagegen/artifacts/img_01J00000000000000000000000/image.png")
        window_api = FakeWindowApi(windows=[
            {
                "handle": 11,
                "folder_path": "F:/project-b/output/imagegen/artifacts/img_01J00000000000000000000000",
                "selected_paths": [
                    "F:/project-b/output/imagegen/artifacts/img_01J00000000000000000000000/image.png",
                ],
                "visible": True,
                "foreground": True,
            },
            {
                "handle": 12,
                "folder_path": str(target.parent),
                "selected_paths": [str(target)],
                "visible": False,
                "foreground": False,
            },
        ])

        result = ensure_target_explorer_visible(target, window_api)

        self.assertEqual(window_api.restored, [12])
        self.assertEqual(window_api.foregrounded, [12])
        self.assertEqual(
            result,
            {
                "targetSelected": True,
                "windowVisible": True,
                "windowForeground": True,
            },
        )

    def test_same_top_level_explorer_tabs_keep_selection_records_separate(self):
        target = Path("F:/project/output/imagegen/artifacts/img_01J00000000000000000000000/image.png")
        folder_path = str(target.parent)
        window_api = WindowsWindowApi.__new__(WindowsWindowApi)
        window_api._enumerate_explorer_windows = lambda: [
            {
                "handle": 42,
                "viewHandle": 100,
                "folderPath": folder_path,
                "selectedPaths": [str(target.parent / "other.png")],
            },
            {
                "handle": 42,
                "viewHandle": 101,
                "folderPath": folder_path,
                "selectedPaths": [str(target)],
            },
        ]

        records = window_api.find_explorer_windows(folder_path)

        self.assertEqual(len(records), 2)
        self.assertEqual(window_api.get_selected_paths(records[0], folder_path), [str(target.parent / "other.png")])
        self.assertEqual(window_api.get_selected_paths(records[1], folder_path), [str(target)])

    def test_background_tab_selection_cannot_claim_a_visible_top_level_window(self):
        target = Path("F:/project/output/imagegen/artifacts/img_01J00000000000000000000000/image.png")
        folder_path = str(target.parent)

        class FakeUser32:
            def __init__(self):
                self.foreground = 42
                self.foregrounded = []

            def IsWindowVisible(self, handle):
                return handle in {42, 100}

            def ShowWindowAsync(self, handle, command):
                return True

            def SetForegroundWindow(self, handle):
                self.foregrounded.append(handle)
                self.foreground = handle
                return True

            def GetForegroundWindow(self):
                return self.foreground

        window_api = WindowsWindowApi.__new__(WindowsWindowApi)
        window_api.user32 = FakeUser32()
        window_api._last_records = []
        window_api._enumerate_explorer_windows = lambda: [
            {
                "handle": 42,
                "viewHandle": 100,
                "folderPath": folder_path,
                "selectedPaths": [str(target.parent / "other.png")],
            },
            {
                "handle": 42,
                "viewHandle": 101,
                "folderPath": folder_path,
                "selectedPaths": [str(target)],
            },
        ]

        with self.assertRaisesRegex(RuntimeError, "visibility_failed"):
            ensure_target_explorer_visible(
                target,
                window_api,
                timeout_seconds=0.03,
                sleep_seconds=0.001,
            )

        self.assertEqual(window_api.user32.foregrounded, [])

    def test_target_window_without_exact_selection_does_not_report_success(self):
        target = Path("F:/project-a/output/imagegen/artifacts/img_01J00000000000000000000000/image.png")
        window_api = FakeWindowApi(windows=[{
            "handle": 12,
            "folder_path": str(target.parent),
            "selected_paths": [str(target.parent / "other.png")],
            "visible": True,
            "foreground": True,
        }])

        with self.assertRaisesRegex(RuntimeError, "visibility_failed"):
            ensure_target_explorer_visible(
                target,
                window_api,
                timeout_seconds=0.03,
                sleep_seconds=0.001,
            )

    def test_confirmation_polling_does_not_repeatedly_steal_the_foreground(self):
        target = Path("F:/project-a/output/imagegen/artifacts/img_01J00000000000000000000000/image.png")

        class DelayedSelectionWindowApi(FakeWindowApi):
            def __init__(self):
                super().__init__(windows=[{
                    "handle": 12,
                    "folder_path": str(target.parent),
                    "selected_paths": [],
                    "visible": True,
                    "foreground": False,
                }])
                self.selection_reads = 0

            def get_selected_paths(self, window, folder_path):
                self.selection_reads += 1
                if self.selection_reads < 2:
                    return []
                return [str(target)]

        window_api = DelayedSelectionWindowApi()

        result = ensure_target_explorer_visible(
            target,
            window_api,
            timeout_seconds=0.1,
            sleep_seconds=0.001,
        )

        self.assertEqual(result["targetSelected"], True)
        self.assertEqual(window_api.foregrounded, [12])

    def test_missing_target_explorer_window_fails_instead_of_claiming_success(self):
        window_api = FakeWindowApi(windows=[])

        with self.assertRaisesRegex(RuntimeError, "visibility_failed"):
            ensure_target_explorer_visible(
                Path("F:/artifacts/img_01J00000000000000000000000/image.png"),
                window_api,
                timeout_seconds=0.03,
                sleep_seconds=0.001,
            )


def canonical_path(value):
    return str(value).replace("\\", "/").rstrip("/").casefold()


def create_artifact_fixture(root, *, image_file="image.png", mime_type="image/png"):
    repository = root / "output" / "imagegen"
    artifact_directory = repository / "artifacts" / IMAGE_ID
    artifact_directory.mkdir(parents=True)
    image_path = artifact_directory / image_file
    image_path.write_bytes(b"image")
    (repository / "index.json").write_text(
        json.dumps({
            "version": 1,
            "artifacts": {
                IMAGE_ID: {
                    "id": IMAGE_ID,
                    "imageFile": image_file,
                    "mimeType": mime_type,
                },
            },
        }),
        encoding="utf-8",
    )
    return repository, image_path


if __name__ == "__main__":
    unittest.main()
