# Security Policy

## Report a vulnerability

Do not open a public issue for an unpatched vulnerability or include credentials, signed image URLs, private provider endpoints, or user artifacts in a report.

Use GitHub's private vulnerability reporting for this repository. Include the affected version, impact, reproduction conditions, and the smallest safe evidence needed to verify the issue.

## Supported versions

Security fixes target the latest published release. Older release artifacts and tags remain available for compatibility and rollback, but may require upgrading to receive a fix.

## Security boundaries

- Credentials remain in user-controlled configuration or environment variables.
- Project configuration cannot replace provider, model, endpoint, authentication source, or route permissions.
- Plugin artifacts, annotations, versions, and delivery files are stored locally under the configured project output directory.
- The project does not operate a hosted image service or collect image prompts and outputs.
- Returned provider image URLs are fetched without forwarding the image API key.
