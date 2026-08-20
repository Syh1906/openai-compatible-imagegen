# Contributing

Contributions should preserve one shared image core and two supported distribution shapes: the Standalone Skill and the Codex Plugin.

## Before changing code

Classify the change as `shared`, `standalone`, `plugin`, or a combination:

| Scope | Typical paths | Required checks |
| --- | --- | --- |
| `shared` | `scripts/` shared runtime | Standalone and Plugin adapter tests |
| `standalone` | root `SKILL.md`, `agents/`, Standalone CLI | Python tests and Standalone release checks |
| `plugin` | `mcp/`, `web/`, bundled Plugin Skill | Node tests, build, plugin check, and risk-based Codex App acceptance |

Read [the architecture guide](docs/arch.md) before changing module boundaries. Use the [documentation index](docs/README.md) to find affected public guides.

Codex App acceptance is based on the boundary being changed, not only the file path. Run it during development when a Plugin change affects manifests or marketplaces, host loading, installation or cache identity, tool injection, the MCP Apps bridge, or behavior that deterministic automation cannot observe. When tests directly and deterministically observe the target behavior and the host contract is unchanged, defer acceptance to the final release candidate.

Every final release candidate requires Codex App acceptance on available target platforms. Record a platform without a real device as unverified and follow the active release plan's platform matrix.

## Development setup

Requirements:

- Node.js 20 or later
- npm
- Python 3.12 or newer

```bash
npm ci
npm run test:smart
```

Use focused tests while iterating:

```bash
npm run test:suite -- mcp
npm run test:suite -- web
node --test tests/mcp/test_mcp_tools.mjs
python -m unittest discover -s tests/standalone -p test_imagegen_auth.py
```

`npm test` is the smart regression entry point. It reads the changed files from Git and selects only the affected suites. An unmapped source path fails closed and requires an impact rule. Use `npm run test:release` only for the complete release regression; it is not part of ordinary push or pull request checks.

Test suites have one owning responsibility:

| Suite | Responsibility |
| --- | --- |
| `shared` | Distribution-neutral image processing, delivery, QA, and transaction behavior in `scripts/` |
| `standalone` | Standalone Skill configuration, CLI, transport, and compatibility behavior |
| `plugin-runtime` | Python runtime behavior packaged for the Plugin, including filesystem adapters |
| `mcp` | MCP schemas, project binding, artifact storage, process bridges, and tool behavior |
| `web` | Result widget and focused editor state, rendering, and host interaction |
| `release` | Manifests, file sets, release identity, artifact building, and publication policy |
| `test-infra` | Impact selection, test discovery, runner behavior, and CI platform selection |

Put reusable fixtures and test helpers in `tests/support/`. Support files are not a suite and must declare their consumer suites in `scripts/test-impact.json`. Test modules must not import helpers from another test module.

## Pull requests

- Keep the change limited to one stated outcome.
- Add a failing behavior test before implementing a feature or fix.
- Update `dist/` with `npm run build` when Plugin runtime or widget sources change.
- Include user-visible changes in `CHANGELOG.md` under `Unreleased`.
- Update affected public docs for behavior, configuration, installation, or release changes.
- Never include credentials, private provider URLs, generated images, caches, or test output.

## Publishing a release

Prepare the release in this order:

1. Move the user-visible entries from `Unreleased` into a dated version section in `CHANGELOG.md` and update its comparison links.
2. Add `.github/release-notes/<tag>.md` with an opening summary and non-empty `Highlights`, `Install`, and `Known limitations` sections. The installation section must link to the same tag's installation guide and require `SHA256SUMS` verification.
3. Align `.codex-plugin/plugin.json`, `package.json`, `package-lock.json`, marketplace metadata, and built `dist/` files.
4. Run `Release preflight` from the final commit, enter that same full 40-character commit SHA, and retain its workflow run ID after all platform candidates and byte comparisons pass.
5. After maintainer approval, create and push one annotated version tag pointing to that exact SHA.
6. Manually run `Publish release` with the existing tag and the retained preflight workflow run ID.

The preflight workflow runs only from the default branch and requires its dispatch commit, input SHA, and actual checkout to resolve to one fixed commit. Windows, Linux, and macOS each run the complete test and Plugin checks and upload an independent candidate scoped to the exact run attempt; the comparison job verifies every candidate filename and SHA-256 byte and records the verified run, attempt, and source identity. The publish workflow authenticates that workflow run through the Actions API, checks that the annotated tag resolves to the same SHA, reuses the immutable candidates from that attempt, validates the tag, versioned notes, and changelog, and only then enters the protected `release` environment. After approval it fetches and verifies the remote tag again before creating the Release. It uses the exact tag as the title, reads the body from the versioned release-notes file, and uploads the Windows candidate's two archives, shared-core evidence, and `SHA256SUMS`.

The workflow never creates, moves, or pushes tags and never replaces an existing Release. A missing section, stale changelog, platform-specific artifact, or existing Release stops publication.

## Commit format

Use `<type>: <English summary>` with one of `feat`, `fix`, `docs`, `chore`, `refactor`, `build`, `style`, `perf`, `test`, or `ci`.
