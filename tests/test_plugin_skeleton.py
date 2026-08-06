from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / ".codex-plugin" / "plugin.json"
MCP_PATH = ROOT / ".mcp.json"
PACKAGE_PATH = ROOT / "package.json"
PACKAGE_LOCK_PATH = ROOT / "package-lock.json"
PLUGIN_ID = "openai-compatible-imagegen-v2"
SKILL_PATH = ROOT / "skills" / PLUGIN_ID / "SKILL.md"
V1_SKILL_PATH = ROOT / "SKILL.md"
SERVER_PATH = ROOT / "dist" / "server.mjs"
WIDGET_PATH = ROOT / "dist" / "widget" / "index.html"
PROBE_PATH = ROOT / "scripts" / "probe-plugin.mjs"
RUNTIME_BRIDGE_PATH = ROOT / "mcp" / "image-runtime.mjs"
DIST_RUNTIME_PATHS = [
    ROOT / "dist" / "scripts" / "imagegen.py",
    ROOT / "dist" / "scripts" / "artifact_repository.py",
    ROOT / "dist" / "scripts" / "provider_config.py",
]


class PluginSkeletonTests(unittest.TestCase):
    def test_manifest_points_to_bundled_components(self) -> None:
        self.assertTrue(MANIFEST_PATH.is_file())
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

        self.assertEqual(manifest["name"], PLUGIN_ID)
        self.assertEqual(manifest["skills"], "./skills/")
        self.assertEqual(manifest["mcpServers"], "./.mcp.json")
        self.assertTrue((ROOT / manifest["skills"]).is_dir())
        self.assertTrue((ROOT / manifest["mcpServers"]).is_file())

    def test_product_copy_is_session_first_and_focus_canvas(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        interface = manifest["interface"]
        manifest_copy = " ".join(
            [
                interface["shortDescription"],
                interface["longDescription"],
                *interface["defaultPrompt"],
            ]
        )

        self.assertIn("会话", manifest_copy)
        self.assertIn("聚焦画布", manifest_copy)
        self.assertNotIn("独立画布", manifest_copy)
        self.assertNotIn("图片工作台", manifest_copy)

        server_text = (ROOT / "mcp" / "create-server.mjs").read_text(encoding="utf-8")
        self.assertIn("会话结果", server_text)
        self.assertIn("同一宿主", server_text)
        self.assertNotIn("独立画布的入口", server_text)

    def test_plugin_and_node_package_identity_match(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        package = json.loads(PACKAGE_PATH.read_text(encoding="utf-8"))
        package_lock = json.loads(PACKAGE_LOCK_PATH.read_text(encoding="utf-8"))

        self.assertEqual(package["name"], manifest["name"])
        self.assertEqual(package["version"], manifest["version"])
        self.assertEqual(package_lock["name"], manifest["name"])
        self.assertEqual(package_lock["version"], manifest["version"])
        self.assertEqual(package_lock["packages"][""]["name"], manifest["name"])
        self.assertEqual(package_lock["packages"][""]["version"], manifest["version"])

    def test_mcp_manifest_starts_prebuilt_server(self) -> None:
        self.assertTrue(MCP_PATH.is_file())
        config = json.loads(MCP_PATH.read_text(encoding="utf-8"))
        server = config["mcpServers"][PLUGIN_ID]

        self.assertEqual(server["command"], "node")
        self.assertEqual(server["args"], ["dist/server.mjs"])
        self.assertTrue(SERVER_PATH.is_file())
        server_text = SERVER_PATH.read_text(encoding="utf-8")
        self.assertNotRegex(
            server_text,
            r'(?m)^import\s+.*["\']@modelcontextprotocol/sdk',
        )
        self.assertNotRegex(server_text, r'(?m)^import\s+.*["\']zod["\']')

    def test_prebuilt_server_includes_its_python_runtime(self) -> None:
        for runtime_path in DIST_RUNTIME_PATHS:
            self.assertTrue(runtime_path.is_file(), runtime_path)
        server_text = SERVER_PATH.read_text(encoding="utf-8")
        self.assertIn('./scripts/imagegen.py', server_text)

    def test_runtime_disables_python_bytecode_writes(self) -> None:
        runtime_text = RUNTIME_BRIDGE_PATH.read_text(encoding="utf-8")

        self.assertIn('PYTHONDONTWRITEBYTECODE: "1"', runtime_text)

    def test_distribution_contains_no_python_bytecode_cache(self) -> None:
        bytecode_files = sorted((ROOT / "dist").rglob("*.pyc"))

        self.assertEqual(bytecode_files, [])

    def test_skill_is_migrated_to_plugin_directory(self) -> None:
        self.assertTrue(SKILL_PATH.is_file())
        text = SKILL_PATH.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"))
        self.assertIn(f"name: {PLUGIN_ID}", text)

    def test_v1_and_v2_skill_names_remain_independent(self) -> None:
        v1_text = V1_SKILL_PATH.read_text(encoding="utf-8")
        v2_text = SKILL_PATH.read_text(encoding="utf-8")

        self.assertIn("name: openai-compatible-imagegen\n", v1_text)
        self.assertIn(f"name: {PLUGIN_ID}\n", v2_text)
        self.assertNotEqual(
            next(line for line in v1_text.splitlines() if line.startswith("name:")),
            next(line for line in v2_text.splitlines() if line.startswith("name:")),
        )

    def test_skill_routes_canvas_submissions_back_to_edit_image(self) -> None:
        text = SKILL_PATH.read_text(encoding="utf-8")
        self.assertIn("画布提交消息", text)
        self.assertIn("annotationId", text)
        self.assertIn("完整目标图片", text)

    def test_static_widget_is_packaged(self) -> None:
        self.assertTrue(WIDGET_PATH.is_file())
        html = WIDGET_PATH.read_text(encoding="utf-8")
        self.assertIn("open_image_editor", html)
        self.assertNotIn("open_image_workspace", html)

    def test_plugin_probe_reports_valid_skeleton(self) -> None:
        result = subprocess.run(
            ["node", str(PROBE_PATH)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["plugin"], PLUGIN_ID)
        self.assertTrue(payload["packageIdentityChecked"])
        self.assertEqual(
            payload["tools"],
            [
                "destroy_image_editor",
                "edit_image",
                "finalize_image_editor_session",
                "generate_image",
                "get_image_artifact",
                "get_image_editor_session",
                "inspect_imagegen_runtime",
                "list_image_models",
                "open_image_editor",
                "read_image_artifact_data",
                "render_image_results",
                "save_image_annotations",
            ],
        )
        self.assertEqual(
            payload["resources"],
            sorted(payload["releaseIdentity"]["resourceUris"].values()),
        )
        self.assertRegex(payload["releaseIdentity"]["fingerprint"], r"^[a-f0-9]{20}$")
        runtime = payload["runtimeDiagnostic"]
        self.assertEqual(runtime["projectRootSource"], "process.cwd")
        self.assertRegex(runtime["cwdFingerprint"], r"^[a-f0-9]{20}$")
        self.assertRegex(runtime["pluginRootFingerprint"], r"^[a-f0-9]{20}$")
        self.assertRegex(runtime["projectRootFingerprint"], r"^[a-f0-9]{20}$")
        self.assertIn(runtime["cwdRelationToPlugin"], {"same", "descendant", "outside"})
        self.assertIn(runtime["projectRootRelationToPlugin"], {"same", "descendant", "outside"})
        self.assertEqual(runtime["roots"]["status"], "unsupported")
        serialized_payload = json.dumps(payload).replace("\\\\", "/")
        self.assertNotIn(str(ROOT).replace("\\", "/"), serialized_payload)
        self.assertEqual(
            payload["appOnlyTools"],
            [
                "finalize_image_editor_session",
                "get_image_editor_session",
                "open_image_editor",
                "read_image_artifact_data",
                "save_image_annotations",
            ],
        )
        self.assertTrue(payload["missingImageIdRejected"])
        self.assertEqual(payload["artifactReads"], [])
        self.assertIsNone(payload["modelCatalog"])
        self.assertIsNone(payload["resultRender"])
        self.assertIsNone(payload["remoteSmoke"])
        self.assertIsNone(payload["annotationSmoke"])

        probe_text = PROBE_PATH.read_text(encoding="utf-8")
        self.assertIn('name: "render_image_results"', probe_text)
        self.assertIn("resultRender", probe_text)
        self.assertNotIn("readArtifactResources", probe_text)

    def test_remote_smoke_requires_the_isolated_project_root(self) -> None:
        result = subprocess.run(
            [
                "node",
                str(PROBE_PATH),
                "--project-root",
                str(ROOT),
                "--remote-smoke",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".local/smoke", result.stderr)

    def test_plugin_probe_reads_the_explicit_plugin_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            plugin_root = Path(directory)
            manifest_directory = plugin_root / ".codex-plugin"
            manifest_directory.mkdir()
            (manifest_directory / "plugin.json").write_text(
                json.dumps({"name": "wrong-plugin-root"}),
                encoding="utf-8",
            )

            result = subprocess.run(
                ["node", str(PROBE_PATH), "--plugin-root", str(plugin_root)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected plugin name", result.stderr)

    def test_plugin_probe_separates_plugin_project_and_source_roots(self) -> None:
        result = subprocess.run(
            [
                "node",
                str(PROBE_PATH),
                "--plugin-root",
                str(ROOT),
                "--project-root",
                str(ROOT),
                "--source-root",
                str(ROOT),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["pluginRootFingerprint"], path_fingerprint(ROOT))
        self.assertEqual(payload["projectRootFingerprint"], path_fingerprint(ROOT))
        self.assertEqual(payload["sourceRootFingerprint"], path_fingerprint(ROOT))
        self.assertEqual(payload["projectRootRelationToPlugin"], "same")
        self.assertTrue(payload["sourceConsistent"])

    def test_plugin_probe_resolves_marketplace_source_from_catalog_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            catalog_root = Path(directory)
            plugin_root = catalog_root / "plugins" / PLUGIN_ID
            marketplace_path = (
                catalog_root / ".agents" / "plugins" / "marketplace.json"
            )
            for name in [".codex-plugin", "dist", "skills"]:
                shutil.copytree(ROOT / name, plugin_root / name)
            for name in [".mcp.json", "LICENSE"]:
                shutil.copy2(ROOT / name, plugin_root / name)
            marketplace_path.parent.mkdir(parents=True)
            marketplace_path.write_text(
                json.dumps(
                    {
                        "name": "personal",
                        "plugins": [
                            {
                                "name": PLUGIN_ID,
                                "source": {
                                    "source": "local",
                                    "path": f"./plugins/{PLUGIN_ID}",
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                [
                    "node",
                    str(PROBE_PATH),
                    "--plugin-root",
                    str(plugin_root),
                    "--project-root",
                    str(ROOT),
                    "--source-root",
                    str(ROOT),
                    "--marketplace-path",
                    str(marketplace_path),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(
            payload["marketplace"]["marketplaceRootFingerprint"],
            path_fingerprint(catalog_root),
        )
        self.assertEqual(
            payload["marketplace"]["marketplacePluginRootFingerprint"],
            path_fingerprint(plugin_root),
        )


def path_fingerprint(value: Path) -> str:
    normalized = str(value.resolve()).replace("\\", "/").lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:20]


if __name__ == "__main__":
    unittest.main()
