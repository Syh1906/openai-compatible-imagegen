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
README_PATH = ROOT / "README.md"
README_ZH_PATH = ROOT / "README.zh-CN.md"
INSTALLATION_GUIDE_PATH = ROOT / "docs" / "guides" / "installation.md"
CONFIGURATION_GUIDE_PATH = ROOT / "docs" / "guides" / "configuration.md"
MIGRATION_GUIDE_PATH = ROOT / "docs" / "guides" / "migration.md"
TROUBLESHOOTING_GUIDE_PATH = ROOT / "docs" / "guides" / "troubleshooting.md"
AUTH_EXAMPLE_PATH = ROOT / "examples" / "auth.example.json"
PACKAGE_PATH = ROOT / "package.json"
PACKAGE_LOCK_PATH = ROOT / "package-lock.json"
PLUGIN_ID = "openai-compatible-imagegen"
SKILL_PATH = ROOT / "skills" / PLUGIN_ID / "SKILL.md"
V1_SKILL_PATH = ROOT / "SKILL.md"
STANDALONE_AGENT_PATH = ROOT / "agents" / "openai.yaml"
SERVER_PATH = ROOT / "dist" / "server.mjs"
WIDGET_PATH = ROOT / "dist" / "widget" / "index.html"
PROBE_PATH = ROOT / "scripts" / "probe-plugin.mjs"
CHECK_PATH = ROOT / "scripts" / "check-plugin.mjs"
RUNTIME_BRIDGE_PATH = ROOT / "mcp" / "image-runtime.mjs"
DIST_RUNTIME_PATHS = [
    ROOT / "dist" / "scripts" / name
    for name in (
        "artifact_repository.py",
        "image_alpha.py",
        "image_batch.py",
        "image_cli.py",
        "image_delivery.py",
        "image_delivery_ops.py",
        "image_download.py",
        "image_emissive_alpha.py",
        "image_mask_alpha.py",
        "image_png.py",
        "image_postprocess.py",
        "image_preview.py",
        "image_qa.py",
        "image_reference.py",
        "image_resize.py",
        "image_response.py",
        "image_transaction.py",
        "image_transparency.py",
        "image_transparency_contract.py",
        "image_transparency_runtime.py",
        "image_transport.py",
        "image_webp.py",
        "imagegen.py",
        "imagegen_cli.py",
        "mask_policy.py",
        "image_runtime.py",
        "migrate_image_config.py",
        "provider_config.py",
        "repository_fs_helper.py",
        "reveal_in_explorer.py",
        "windows_repository_fs.py",
    )
]


class PluginSkeletonTests(unittest.TestCase):
    def test_public_docs_route_package_installation_configuration_and_migration(self) -> None:
        for path in (README_PATH, README_ZH_PATH):
            text = path.read_text(encoding="utf-8")
            self.assertIn("OpenAI-Compatible Images", text)
            self.assertIn("Standalone Skill", text)
            self.assertIn("Codex Plugin", text)
            self.assertIn("codex plugin marketplace add Syh1906/openai-compatible-imagegen", text)
            self.assertIn("docs/guides/installation.md", text)
            self.assertNotIn("openai-compatible-imagegen-v2", text)

        public_text = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (
                README_PATH,
                README_ZH_PATH,
                INSTALLATION_GUIDE_PATH,
                CONFIGURATION_GUIDE_PATH,
                MIGRATION_GUIDE_PATH,
                TROUBLESHOOTING_GUIDE_PATH,
            )
        )
        required = (
            "openai-compatible-imagegen-skill-<version>.zip",
            "openai-compatible-imagegen-codex-plugin-<version>.zip",
            "~/.codex/openai-compatible-imagegen/config.json",
            ".codex/openai-compatible-imagegen/config.json",
            "auth.json",
            "--source-kind",
            "--expected-source-sha256",
            "--allow-plaintext-api-key",
            "delivery_ready",
            "deliveryReady",
            "transparent_background",
            "background=transparent",
        )
        for value in required:
            with self.subTest(value=value):
                self.assertIn(value, public_text)

    def test_url_download_contract_is_documented_in_configuration_guide(self) -> None:
        text = CONFIGURATION_GUIDE_PATH.read_text(encoding="utf-8")
        self.assertIn("url_download.proxy_mode", text)
        self.assertIn("TLS EOF", text)
        self.assertIn("allow-direct-url-download", text)
        self.assertIn("API key", text)

        config = json.loads(AUTH_EXAMPLE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(config["url_download"], {"proxy_mode": "environment"})

    def test_manifest_points_to_bundled_components(self) -> None:
        self.assertTrue(MANIFEST_PATH.is_file())
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

        self.assertEqual(manifest["name"], PLUGIN_ID)
        self.assertEqual(manifest["interface"]["displayName"], "OpenAI-Compatible Images")
        self.assertEqual(manifest["interface"]["developerName"], "Syh1906")
        self.assertEqual(
            manifest["interface"]["websiteURL"],
            "https://github.com/Syh1906/openai-compatible-imagegen",
        )
        self.assertEqual(manifest["interface"]["composerIcon"], "./assets/icon.png")
        self.assertEqual(manifest["interface"]["logo"], "./assets/icon.png")
        self.assertTrue((ROOT / "assets" / "icon.png").is_file())
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
        self.assertEqual(server["cwd"], ".")
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
        self.assertIn('./scripts/image_runtime.py', server_text)

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

    def test_skill_freezes_the_explicit_project_binding_flow(self) -> None:
        text = SKILL_PATH.read_text(encoding="utf-8")

        self.assertIn("首次调用任何项目相关工具前", text)
        self.assertIn("bind_imagegen_project", text)
        self.assertIn("保存返回的 `projectBindingId`", text)
        self.assertIn("首次不带 ID 的绑定会签发新的随机绑定", text)
        self.assertIn("同一 `projectBindingId` 可跨 MCP 进程和 server 重启恢复", text)
        self.assertIn("不得用 transport `sessionId`", text)
        self.assertIn("不得从插件安装目录、MCP `cwd`、roots、Git 搜索", text)

    def test_skill_documents_the_explicit_config_migration_gate(self) -> None:
        text = SKILL_PATH.read_text(encoding="utf-8")

        self.assertIn("dist/scripts/migrate_image_config.py", text)
        self.assertIn("--source-kind standalone", text)
        self.assertIn("--source-kind development-plugin", text)
        self.assertIn("--expected-source-sha256", text)
        self.assertIn("--include-project-overrides", text)
        self.assertIn("--allow-plaintext-api-key", text)
        self.assertIn("readyToWrite", text)

    def test_distribution_skills_share_identity_but_keep_distinct_routes(self) -> None:
        standalone_text = V1_SKILL_PATH.read_text(encoding="utf-8")
        plugin_text = SKILL_PATH.read_text(encoding="utf-8")
        standalone_agent = STANDALONE_AGENT_PATH.read_text(encoding="utf-8")

        self.assertIn(f"name: {PLUGIN_ID}\n", standalone_text)
        self.assertIn(f"name: {PLUGIN_ID}\n", plugin_text)
        self.assertIn("# OpenAI-Compatible Images Skill", standalone_text)
        self.assertIn('display_name: "OpenAI-Compatible Images Skill"', standalone_agent)
        self.assertIn("scripts/imagegen.py", standalone_text)
        self.assertNotIn("batch_images", standalone_text)
        self.assertIn("batch_images", plugin_text)
        self.assertIn("open_image_editor", plugin_text)

    def test_skill_routes_canvas_submissions_back_to_edit_image(self) -> None:
        text = SKILL_PATH.read_text(encoding="utf-8")
        self.assertIn("画布提交消息", text)
        self.assertIn("prepare_image_edit_submission", text)
        self.assertIn("edit_image.submissionId", text)
        self.assertIn("annotationId", text)
        self.assertIn("MASK_GUARD_V2_BY_STRATEGY", text)
        self.assertIn("完整目标图片", text)

    def test_skill_routes_local_delivery_and_presents_only_published_derivatives(self) -> None:
        text = SKILL_PATH.read_text(encoding="utf-8")

        self.assertIn("deliver_image", text)
        self.assertIn("deliveryReady", text)
        self.assertIn("preview", text)
        self.assertIn("grid", text)
        self.assertIn("render_image_results", text)

    def test_skill_routes_heterogeneous_batches_once_without_retrying_failures(self) -> None:
        text = SKILL_PATH.read_text(encoding="utf-8")

        self.assertIn("batch_images", text)
        self.assertIn("一次 `batch_images`", text)
        self.assertIn("只调用一次 `render_image_results`", text)
        self.assertIn("不重试失败项", text)
        self.assertIn("mask 或画布提交", text)
        self.assertIn("单独一次 `edit_image`", text)

    def test_static_widget_is_packaged(self) -> None:
        self.assertTrue(WIDGET_PATH.is_file())
        html = WIDGET_PATH.read_text(encoding="utf-8")
        self.assertIn("open_image_editor", html)
        self.assertNotIn("open_image_workspace", html)

    def test_plugin_probe_reports_valid_skeleton(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_root = Path(directory)
            project_root = fixture_root / "project"
            user_home = fixture_root / "user-home"
            project_root.mkdir()
            user_home.mkdir()
            result = subprocess.run(
                [
                    "node",
                    str(PROBE_PATH),
                    "--project-root",
                    str(project_root),
                    "--user-home",
                    str(user_home),
                ],
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
                "batch_images",
                "bind_imagegen_project",
                "deliver_image",
                "destroy_image_editor",
                "edit_image",
                "finalize_image_editor_session",
                "generate_image",
                "get_image_artifact",
                "get_image_batch_manifest",
                "get_image_delivery_receipt",
                "get_image_editor_session",
                "initialize_image_config",
                "inspect_image_config",
                "inspect_imagegen_runtime",
                "list_image_models",
                "open_image_editor",
                "prepare_image_edit_submission",
                "read_image_artifact_data",
                "render_image_results",
                "report_imagegen_host_observation",
                "reveal_image_artifact",
                "save_image_annotations",
                "save_image_editor_draft",
                "update_image_config",
            ],
        )
        self.assertEqual(
            payload["resources"],
            sorted([
                *payload["releaseIdentity"]["resourceUris"].values(),
                "ui://openai-compatible-imagegen/editor.html",
                "ui://openai-compatible-imagegen/editor-43c3a69a85db10633692.html",
                "ui://openai-compatible-imagegen/editor-9caad8c28a921a55611b.html",
                "ui://openai-compatible-imagegen/result.html",
                "ui://openai-compatible-imagegen/result-43c3a69a85db10633692.html",
                "ui://openai-compatible-imagegen/result-9caad8c28a921a55611b.html",
            ]),
        )
        self.assertRegex(payload["releaseIdentity"]["fingerprint"], r"^[a-f0-9]{20}$")
        runtime = payload["runtimeDiagnostic"]
        self.assertEqual(runtime["projectRootSource"], "unbound")
        self.assertRegex(runtime["cwdFingerprint"], r"^[a-f0-9]{20}$")
        self.assertRegex(runtime["pluginRootFingerprint"], r"^[a-f0-9]{20}$")
        self.assertIsNone(runtime["projectRootFingerprint"])
        self.assertIn(runtime["cwdRelationToPlugin"], {"same", "descendant", "outside"})
        self.assertIsNone(runtime["projectRootRelationToPlugin"])
        self.assertEqual(runtime["roots"]["status"], "unsupported")
        serialized_payload = json.dumps(payload).replace("\\\\", "/")
        self.assertNotIn(str(ROOT).replace("\\", "/"), serialized_payload)
        self.assertEqual(
            payload["appOnlyTools"],
            [
                "finalize_image_editor_session",
                "get_image_editor_session",
                "open_image_editor",
                "prepare_image_edit_submission",
                "read_image_artifact_data",
                "report_imagegen_host_observation",
                "reveal_image_artifact",
                "save_image_annotations",
                "save_image_editor_draft",
            ],
        )
        self.assertTrue(payload["missingImageIdRejected"])
        self.assertEqual(payload["artifactReads"], [])
        self.assertIsNone(payload["modelCatalog"])
        self.assertIsNone(payload["resultRender"])
        self.assertIsNone(payload["remoteSmoke"])
        self.assertIsNone(payload["annotationSmoke"])

        probe_text = PROBE_PATH.read_text(encoding="utf-8")
        self.assertIn('callProjectTool("render_image_results"', probe_text)
        self.assertIn("resultRender", probe_text)
        self.assertNotIn("readArtifactResources", probe_text)

    def test_plugin_probe_requires_an_explicit_project_root(self) -> None:
        result = subprocess.run(
            ["node", str(PROBE_PATH)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "--project-root is required; the probe never infers a project root",
            result.stderr,
        )

    def test_plugin_probe_rejects_a_missing_runtime_without_source_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_root = Path(directory) / "plugin"
            self._copy_probe_plugin(fixture_root)
            (fixture_root / "dist" / "scripts" / "mask_policy.py").unlink()
            result = self._run_probe(fixture_root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("distribution file set differs", result.stderr)

    def test_plugin_probe_rejects_an_extra_dist_file_without_source_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_root = Path(directory) / "plugin"
            self._copy_probe_plugin(fixture_root)
            (fixture_root / "dist" / "obsolete.secret").write_text("secret", encoding="utf-8")
            result = self._run_probe(fixture_root)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("distribution file set differs", result.stderr)

    def test_plugin_probe_compares_every_release_file_with_the_source(self) -> None:
        relative_paths = (
            Path("LICENSE"),
            Path("skills") / PLUGIN_ID / "references" / "config.example.json",
        )
        for relative_path in relative_paths:
            with self.subTest(relative_path=relative_path), tempfile.TemporaryDirectory() as directory:
                fixture_root = Path(directory) / "plugin"
                self._copy_probe_plugin(fixture_root)
                target = fixture_root / relative_path
                target.write_bytes(target.read_bytes() + b"\nprobe mismatch\n")
                result = self._run_probe(fixture_root, source_root=ROOT)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("installed plugin differs from source", result.stderr)
            self.assertIn(relative_path.as_posix(), result.stderr.replace("\\", "/"))

    def test_plugin_probe_normalizes_release_text_line_endings_for_source_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fixture_root = Path(directory) / "plugin"
            self._copy_probe_plugin(fixture_root)
            manifest_path = fixture_root / ".codex-plugin" / "plugin.json"
            normalized = manifest_path.read_bytes().replace(b"\r\n", b"\n")
            manifest_path.write_bytes(normalized.replace(b"\n", b"\r\n"))

            result = self._run_probe(fixture_root, source_root=ROOT)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["sourceConsistent"])

    def test_plugin_probe_uses_explicit_project_binding_ids(self) -> None:
        probe_text = PROBE_PATH.read_text(encoding="utf-8")
        self.assertNotIn('"openai/session"', probe_text)
        self.assertIn("projectBindingId", probe_text)

    def _copy_probe_plugin(self, destination: Path) -> None:
        for name in [".codex-plugin", "assets", "dist", "skills"]:
            shutil.copytree(ROOT / name, destination / name)
        for name in [".mcp.json", "LICENSE", "package.json", "package-lock.json"]:
            shutil.copy2(ROOT / name, destination / name)

    def _run_probe(
        self,
        plugin_root: Path,
        source_root: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            "node",
            str(PROBE_PATH),
            "--plugin-root",
            str(plugin_root),
            "--project-root",
            str(ROOT),
        ]
        if source_root is not None:
            command.extend(["--source-root", str(source_root)])
        return subprocess.run(
            command,
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_project_check_keeps_the_static_probe_unbound(self) -> None:
        result = subprocess.run(
            ["node", str(CHECK_PATH)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(
            payload["runtimeDiagnostic"]["projectRootSource"],
            "unbound",
        )

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

    def test_remote_smoke_presents_images_only_through_the_render_tool(self) -> None:
        probe_text = PROBE_PATH.read_text(encoding="utf-8")

        self.assertNotIn(
            "remote smoke generation returned no image content",
            probe_text,
        )
        self.assertNotIn(
            "remote smoke edit returned no image content",
            probe_text,
        )
        self.assertIn("remote smoke generated result did not render", probe_text)
        self.assertIn("remote smoke edited result did not render", probe_text)

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
                [
                    "node",
                    str(PROBE_PATH),
                    "--plugin-root",
                    str(plugin_root),
                    "--project-root",
                    str(ROOT.parent),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected plugin name", result.stderr)

    def test_plugin_probe_separates_plugin_project_and_source_roots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project_root = Path(directory)
            result = subprocess.run(
                [
                    "node",
                    str(PROBE_PATH),
                    "--plugin-root",
                    str(ROOT),
                    "--project-root",
                    str(project_root),
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
        self.assertEqual(payload["projectRootFingerprint"], path_fingerprint(project_root))
        self.assertEqual(payload["sourceRootFingerprint"], path_fingerprint(ROOT))
        self.assertEqual(payload["projectRootRelationToPlugin"], "outside")
        self.assertTrue(payload["sourceConsistent"])

    def test_plugin_probe_resolves_marketplace_source_from_catalog_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            catalog_root = Path(directory)
            plugin_root = catalog_root / "plugins" / PLUGIN_ID
            marketplace_path = (
                catalog_root / ".agents" / "plugins" / "marketplace.json"
            )
            for name in [".codex-plugin", "assets", "dist", "skills"]:
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
    normalized = str(value.absolute()).replace("\\", "/").lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:20]


if __name__ == "__main__":
    unittest.main()
