# Contributing

Contributions should preserve one shared image core and two supported distribution shapes: the Standalone Skill and the Codex Plugin.

## Before changing code

Classify the change as `shared`, `standalone`, `plugin`, or a combination:

| Scope | Typical paths | Required checks |
| --- | --- | --- |
| `shared` | `scripts/` shared runtime | Standalone and Plugin adapter tests |
| `standalone` | root `SKILL.md`, `agents/`, Standalone CLI | Python tests and Standalone release checks |
| `plugin` | `mcp/`, `web/`, bundled Plugin Skill | Node tests, build, plugin check, Codex App acceptance |

Read [the architecture guide](docs/arch.md) before changing module boundaries. Use the [documentation index](docs/README.md) to find affected public guides.

## Development setup

Requirements:

- Node.js 20 or later
- npm
- Python 3.12 or newer

```bash
npm ci
npm run build
npm test
npm run check
python -m compileall -q scripts
```

Use focused tests while iterating:

```bash
node --test tests/<file>.mjs
python -m unittest tests.<module>
```

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
4. Run the project checks, then create and push one annotated version tag after maintainer approval.
5. Manually run `Publish release` with that existing tag.

The workflow validates the tag, versioned notes, and changelog before building. Windows, Linux, and macOS each run the complete test and Plugin checks and upload an independent candidate. The publish job compares every candidate filename and SHA-256 byte before entering the protected `release` environment. It creates a Release only when all three candidates match, uses the exact tag as the title, reads the body from the versioned release-notes file, and uploads the Windows candidate's two archives, shared-core evidence, and `SHA256SUMS`.

The workflow never creates, moves, or pushes tags and never replaces an existing Release. A missing section, stale changelog, platform-specific artifact, or existing Release stops publication.

## Commit format

Use `<type>: <English summary>` with one of `feat`, `fix`, `docs`, `chore`, `refactor`, `build`, `style`, `perf`, `test`, or `ci`.
