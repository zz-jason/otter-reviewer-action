# Security Policy

## Supported Use

Otter Reviewer is designed for trusted self-hosted GitHub Actions runners. The safest default is a private repository, an ephemeral runner, and a runner group restricted to the repositories that should run reviews.

Do not run this action on untrusted public fork pull requests unless you have a separate isolation design that prevents access to GitHub App private keys, Codex credentials, custom agent credentials, host files, and other repository secrets.

## Secret Handling

The action uses a GitHub App private key to create short-lived installation tokens for posting pull request reviews. Treat `OTTER_REVIEWER_PRIVATE_KEY` as a root credential for the installed repositories.

The default Codex adapter passes only a minimal environment plus `CODEX_HOME` to the `codex` child process. Custom agents receive only a minimal environment plus variables explicitly listed in `agent-env-pass`.

## Runner Guidance

- Use ephemeral runners for review jobs.
- Restrict runner groups to selected repositories and workflows.
- Use repository-specific labels instead of a broad shared label where possible.
- Do not keep runner registration PATs in the job environment.
- Do not mount Docker sockets or host-sensitive directories into runner containers.
- Clear runner work directories after each job.

## Incident Response

If a secret may have been exposed:

1. Delete and regenerate the GitHub App private key.
2. Rotate any Codex or custom agent credentials on the runner.
3. Remove affected self-hosted runners from GitHub.
4. Delete runner work directories, logs, caches, and container volumes.
5. Reinstall the GitHub App if installation scope needs to be reduced.

## Reporting

Report security issues privately to the repository owner before opening a public issue.
