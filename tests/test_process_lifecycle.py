from __future__ import annotations

import ast
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
IMAGEGEN = SCRIPTS / "imagegen.py"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from image_png import read_png_rgba, write_png_rgba  # noqa: E402


class ScriptProcessLifecycleTests(unittest.TestCase):
    def test_scripts_do_not_spawn_processes_or_load_local_model_runtimes(self) -> None:
        forbidden_imports = {
            "multiprocessing",
            "onnxruntime",
            "rembg",
            "subprocess",
            "tensorflow",
            "torch",
            "transformers",
        }
        forbidden_calls = {"Popen", "Process", "ProcessPoolExecutor"}
        forbidden_os_calls = {"popen", "spawnl", "spawnle", "spawnlp", "spawnlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe", "startfile", "system"}
        violations: list[str] = []

        for path in sorted(SCRIPTS.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for item in node.names:
                        if item.name.split(".", 1)[0] in forbidden_imports:
                            violations.append(f"{path.name}:{node.lineno}: import {item.name}")
                elif isinstance(node, ast.ImportFrom) and node.module:
                    if node.module.split(".", 1)[0] in forbidden_imports:
                        violations.append(f"{path.name}:{node.lineno}: from {node.module}")
                elif isinstance(node, ast.Call):
                    if isinstance(node.func, ast.Name) and node.func.id in forbidden_calls:
                        violations.append(f"{path.name}:{node.lineno}: {node.func.id}")
                    if isinstance(node.func, ast.Attribute):
                        if node.func.attr in forbidden_calls:
                            violations.append(f"{path.name}:{node.lineno}: {node.func.attr}")
                        if (
                            isinstance(node.func.value, ast.Name)
                            and node.func.value.id == "os"
                            and node.func.attr in forbidden_os_calls
                        ):
                            violations.append(f"{path.name}:{node.lineno}: os.{node.func.attr}")

        self.assertEqual(violations, [])

    def test_apply_transparency_cli_finishes_and_exits(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "particles.png"
            target = root / "particles-alpha.png"
            width = height = 16
            pixels = [(0, 0, 0, 255)] * (width * height)
            for y in range(7, 9):
                for x in range(7, 9):
                    pixels[y * width + x] = (255, 180, 20, 255)
            write_png_rgba(source, width, height, pixels)

            process = subprocess.Popen(
                [
                    sys.executable,
                    str(IMAGEGEN),
                    "apply-transparency",
                    str(source),
                    "--out",
                    str(target),
                    "--route",
                    "emissive-alpha",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
            try:
                stdout, stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                self.fail("apply-transparency did not exit within 15 seconds")

            self.assertEqual(process.returncode, 0, stderr)
            self.assertIsNotNone(process.poll())
            result = json.loads(stdout)
            self.assertEqual(result["status"], "pass")
            self.assertTrue(result["delivery_ready"])
            self.assertTrue(target.is_file())
            self.assertTrue(any(pixel[3] == 0 for pixel in read_png_rgba(target)["pixels"]))

    def test_unmet_transparency_returns_original_and_exits_successfully(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "opaque.png"
            target = root / "opaque-result.png"
            original = [(220, 30, 40, 255)] * 64
            write_png_rgba(source, 8, 8, original)

            process = subprocess.run(
                [
                    sys.executable,
                    str(IMAGEGEN),
                    "apply-transparency",
                    str(source),
                    "--out",
                    str(target),
                    "--route",
                    "chroma-matting",
                    "--key",
                    "#00FF00",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=15,
                check=False,
            )

            self.assertEqual(process.returncode, 0, process.stderr)
            result = json.loads(process.stdout)
            self.assertEqual(result["status"], "unmet")
            self.assertFalse(result["delivery_ready"])
            self.assertIn("returned the original image", result["warnings"][0])
            self.assertEqual(read_png_rgba(target)["pixels"].packed(), read_png_rgba(source)["pixels"].packed())


if __name__ == "__main__":
    unittest.main()
