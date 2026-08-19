from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CiPlatformTests(unittest.TestCase):
    def test_ci_runs_the_complete_gate_on_all_supported_platforms(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

        self.assertIn("matrix:", workflow)
        self.assertIn("windows-latest", workflow)
        self.assertIn("ubuntu-latest", workflow)
        self.assertIn("macos-latest", workflow)
        self.assertIn("runs-on: ${{ matrix.os }}", workflow)
        for command in (
            "npm run build",
            "npm test",
            "npm run check",
            "python -m compileall -q scripts",
            "git diff --check",
        ):
            with self.subTest(command=command):
                self.assertIn(command, workflow)


if __name__ == "__main__":
    unittest.main()
