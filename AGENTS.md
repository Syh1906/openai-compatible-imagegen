# Agent Instructions

## Project Scope

- `OpenAI-Compatible Images` maintains the Standalone Skill and Codex App Plugin from one repository.
- Shared image logic lives in `scripts/`; each distribution uses its own adapter without duplicating the shared implementation.
- The Codex Plugin consists of `skills/`, `mcp/`, `web/`, `.mcp.json`, `.codex-plugin/plugin.json`, and the prebuilt `dist/` directory.
- Track `dist/` in Git. Update it only through `npm run build`; do not edit it by hand.

## Package Management

- Use npm with `package-lock.json` for Node dependencies.
- Use Python 3.12. Production Python code uses only the standard library.
- Do not install global packages or modify user-level `PATH`, registry entries, or Codex configuration.

## Checks

| Task | Command |
| --- | --- |
| All tests | `npm test` |
| One Node test file | `node --test tests/<file>.mjs` |
| One Python test module | `python -m unittest tests.<module>` |
| Build the Plugin | `npm run build` |
| Check the Plugin | `npm run check` |
| Compile Python files | `python -m compileall -q scripts` |
| Check diffs | `git diff --check` |

## Module Boundaries

- `scripts/`: authentication, image requests, response validation, post-processing, delivery, and QA; independent of Codex, MCP, and the widget.
- `mcp/`: tool schemas, project binding, artifact storage, and runtime calls; does not construct provider image requests.
- `web/`: result cards and the focused canvas; does not read credentials or connect directly to image services.
- `skills/openai-compatible-imagegen/`: Plugin runtime tool selection and parameter decisions.
- Root `SKILL.md` and `references/`: Standalone runtime contract.
- `.agents/plugins/marketplace.json`: Git marketplace entry; Plugin sources must follow the marketplace checkout.
- `.codex-plugin/plugin.json`, `package.json`, and `package-lock.json`: keep package identity and version aligned.

## Behavior Constraints

- Do not replace or impersonate Codex's built-in `image_gen` capability.
- Do not read or modify Codex task records, the App database, or unpublished host protocols.
- Do not automatically switch models, providers, endpoints, authentication sources, request protocols, or editing routes.
- Keep images, edit versions, and delivered artifacts immutable. Failed operations must not leave index entries pointing to incomplete files.
- Project configuration may override only fields allowed by the public contract.
- Never write credentials to logs, tool results, test fixtures, documentation, release packages, or commits.

## Tests and Documentation

- Add a test that reproduces the target behavior before implementing a feature or fixing a defect.
- Validate both the Standalone and Plugin adapters when shared image logic changes.
- Changes to MCP, the widget, Plugin manifests, or the marketplace require matching Node tests and Codex App acceptance checks.
- Update `CHANGELOG.md` and affected public guides when user-visible behavior changes.
- `README.md` serves first-time visitors; `docs/guides/` serves users; `AGENTS.md` serves contributors; distribution `SKILL.md` files serve runtime agents.
- Public content must not contain credentials, private endpoints, local absolute paths, test output, or unpublished implementation plans.

## Release

- One version and tag produce both the Standalone Skill ZIP and the Codex Plugin ZIP.
- The Git marketplace Plugin must contain `dist/server.mjs`, `dist/widget/`, and `dist/scripts/`.
- Before release, verify that marketplace metadata, Plugin manifests, package metadata, tags, and artifact versions agree.
- Exclude `auth.json`, `.local/`, `verification-scratch/`, `node_modules/`, caches, and test output from release packages.
- Do not create or move tags, create Releases, modify remotes, or publish a public MCP server without maintainer approval.

## Commits

- Use `<type>: <English summary>`.
- Use one of: `feat`, `fix`, `docs`, `chore`, `refactor`, `build`, `style`, `perf`, `test`, or `ci`.
- AI commits must include `Co-Authored-By: (the agent model's name and attribution byline)`.
- Use the actual model ID and the provider's no-reply email domain; do not invent attribution.
