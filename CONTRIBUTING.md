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
- Python 3.12

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

The `Publish release` workflow is manually triggered with an existing annotated version tag and uses the protected `release` environment. It requires the tag to match the Plugin manifest version, runs the release checks, builds the two archives, shared-core evidence, and `SHA256SUMS`, and uploads the same files to a GitHub Release. The Release title is the exact tag, such as `v1.0.1`. The workflow does not create, move, or push tags and does not replace an existing Release.

## Commit format

Use `<type>: <English summary>` with one of `feat`, `fix`, `docs`, `chore`, `refactor`, `build`, `style`, `perf`, `test`, or `ci`.
