from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class CiPlatformTests(unittest.TestCase):
    def test_ci_uses_the_impact_plan_instead_of_the_release_regression(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        release_workflow = (ROOT / ".github" / "workflows" / "release-artifacts.yml").read_text(encoding="utf-8")
        preflight_workflow = (ROOT / ".github" / "workflows" / "release-preflight.yml").read_text(encoding="utf-8")

        self.assertIn("matrix:", workflow)
        self.assertIn("node scripts/test-smart.mjs --plan --github-output", workflow)
        self.assertIn("fromJSON(needs.plan.outputs.matrix)", workflow)
        for command in (
            "npm run build",
            "npm run test:smart",
            "npm run check",
            "python -m compileall -q scripts",
            "git diff --check",
        ):
            with self.subTest(command=command):
                self.assertIn(command, workflow)
        self.assertNotIn("npm run test:release", workflow)
        self.assertIn("npm run test:release", preflight_workflow)
        self.assertIn("validate-release-notes.mjs", preflight_workflow)
        self.assertIn("preflight_run_id", release_workflow)

    def test_ci_has_stable_summary_and_new_ref_baseline(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

        self.assertIn("tags-ignore:", workflow)
        self.assertIn("smart regression summary", workflow)
        self.assertIn("needs: [plan, test]", workflow)
        self.assertIn("base_sha: ${{ steps.baseline.outputs.base_sha }}", workflow)
        self.assertIn('git merge-base "origin/$DEFAULT_BRANCH" "$HEAD_SHA"', workflow)
        self.assertIn("TEST_BASE_SHA: ${{ needs.plan.outputs.base_sha }}", workflow)
        self.assertIn('git diff --check "${{ needs.plan.outputs.base_sha }}"', workflow)
        self.assertNotIn("TEST_BASE_SHA: ${{ github.event", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("name: plan (${{ github.event_name }})", workflow)

    def test_release_validation_jobs_are_read_only(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release-artifacts.yml").read_text(encoding="utf-8")

        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("  publish:\n    needs: [validate_release, compare_candidates]\n    permissions:\n      contents: write", workflow)

    def test_release_uses_preflight_candidates_instead_of_rebuilding_after_tag(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release-artifacts.yml").read_text(encoding="utf-8")
        preflight = (ROOT / ".github" / "workflows" / "release-preflight.yml").read_text(encoding="utf-8")

        self.assertIn("run-id: ${{ inputs.preflight_run_id }}", workflow)
        self.assertIn("preflight.json", preflight)
        self.assertIn("git rev-parse HEAD", preflight)
        self.assertIn("needs.resolve_source.outputs.source_sha", preflight)
        self.assertIn("tagged_sha", workflow)
        self.assertNotIn("npm run build", workflow)
        self.assertNotIn("npm run test:release", workflow)

    def test_publish_authenticates_the_preflight_run_and_rechecks_the_tag_after_approval(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "release-artifacts.yml").read_text(encoding="utf-8")

        for expected in (
            "actions/runs/$PREFLIGHT_RUN_ID",
            "actions/workflows/release-preflight.yml",
            "default_branch",
            "head_branch",
            "workflow_id",
            "workflow_dispatch",
            "conclusion",
            "head_sha",
            "run_attempt",
            "preflight-metadata/preflight.json",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, workflow)
        self.assertIn("ref: ${{ steps.preflight.outputs.source_sha }}", workflow)
        self.assertIn("ref: ${{ needs.validate_release.outputs.preflight_sha }}", workflow)
        self.assertIn("candidate-windows-${{ needs.validate_release.outputs.run_attempt }}", workflow)
        self.assertIn("preflight-metadata-${{ steps.preflight.outputs.run_attempt }}", workflow)
        publish_start = workflow.index("  publish:")
        recheck = workflow.index("name: Revalidate the remote annotated tag", publish_start)
        create = workflow.index("name: Create the GitHub Release", publish_start)
        self.assertLess(recheck, create)
        self.assertIn("GITHUB_WORKFLOW_REF", workflow)
        self.assertIn("CURRENT_REF_TYPE", workflow)
        self.assertIn("CURRENT_BRANCH", workflow)
        self.assertIn('repository_default_branch="$(jq -r \'.default_branch\' <<< "$repository_json")"', workflow)
        self.assertNotIn('default_branch="$(jq -r \'.repository.default_branch\' <<< "$run_json")"', workflow)
        self.assertIn("must run from the repository default branch", workflow)
        publish_start = workflow.index("  publish:")
        attempt_recheck = workflow.index("name: Revalidate the Release preflight attempt", publish_start)
        download = workflow.index("name: Download the verified Windows release candidate", publish_start)
        self.assertLess(attempt_recheck, download)
        self.assertIn("actions/runs/$PREFLIGHT_RUN_ID/attempts/$PREFLIGHT_RUN_ATTEMPT", workflow)
        self.assertIn("current_run_attempt", workflow)


if __name__ == "__main__":
    unittest.main()
