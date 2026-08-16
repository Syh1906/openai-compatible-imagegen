from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CiPlatformTests(unittest.TestCase):
    def test_ci_uses_the_supported_windows_runtime(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

        self.assertIn("runs-on: windows-latest", workflow)
        self.assertNotIn("runs-on: ubuntu-latest", workflow)


if __name__ == "__main__":
    unittest.main()
