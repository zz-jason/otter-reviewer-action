# Otter Reviewer

Otter Reviewer runs an agent CLI on your self-hosted GitHub Actions runner, converts the agent output into GitHub inline pull request review comments, and posts those comments through your GitHub App identity.

Codex is the default and end-to-end validated agent. You can also configure another review-capable CLI as long as it reads the review prompt and returns JSON matching `schema/review.schema.json`.

## Requirements

- A self-hosted runner for trusted repositories.
- `node >= 18` and `git` on the runner.
- `codex` plus `${CODEX_HOME:-$HOME/.codex}/config.toml` when using the default Codex adapter.
- A GitHub App installed on the target repository with:
  - `Contents: read`
  - `Pull requests: read and write`
  - `Metadata: read`, granted automatically
- Repository or organization secrets:
  - `OTTER_REVIEWER_APP_ID`
  - `OTTER_REVIEWER_PRIVATE_KEY`
  - `OTTER_REVIEWER_INSTALLATION_ID`, optional

## Usage

```yaml
name: Otter Reviewer

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to review
        required: true
        type: string

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: otter-reviewer-${{ github.event.pull_request.number || github.event.inputs.pr_number || github.run_id }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: [self-hosted, otter-reviewer]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: ${{ github.event.pull_request.head.sha || github.sha }}

      - name: Run Otter Reviewer
        uses: zz-jason/otter-reviewer-action@v1
        with:
          app-id: ${{ secrets.OTTER_REVIEWER_APP_ID }}
          private-key: ${{ secrets.OTTER_REVIEWER_PRIVATE_KEY }}
          installation-id: ${{ secrets.OTTER_REVIEWER_INSTALLATION_ID }}
          max-inline-comments: "10"
          post-empty-review: "true"
          pr-number: ${{ github.event.pull_request.number || github.event.inputs.pr_number }}
```

Use a full release tag or commit SHA when you need stricter supply-chain pinning, for example `zz-jason/otter-reviewer-action@v1.0.2`.

## Custom Agent CLI

By default, Otter Reviewer calls:

```text
codex exec --cd <repo> --sandbox read-only --ephemeral --output-schema <schema> --output-last-message <output> -
```

To use a different CLI, provide `agent-command` and optional `agent-args-json`. The custom agent receives the review prompt on stdin. It can either print JSON to stdout or write JSON to the path in `OTTER_AGENT_OUTPUT_PATH`.

```yaml
- name: Run Otter Reviewer with a custom agent
  uses: zz-jason/otter-reviewer-action@v1
  with:
    app-id: ${{ secrets.OTTER_REVIEWER_APP_ID }}
    private-key: ${{ secrets.OTTER_REVIEWER_PRIVATE_KEY }}
    pr-number: ${{ github.event.pull_request.number }}
    agent-command: my-review-agent
    agent-args-json: '["review", "--schema", "{schemaPath}", "--output", "{outputPath}"]'
    agent-env-pass: MY_AGENT_API_KEY
  env:
    MY_AGENT_API_KEY: ${{ secrets.MY_AGENT_API_KEY }}
```

`agent-args-json` supports these placeholders:

- `{repoRoot}`
- `{schemaPath}`
- `{outputPath}`
- `{promptPath}`
- `{maxComments}`

Custom agents do not receive the full workflow environment by default. Only a small safe environment is passed, plus variables explicitly listed in `agent-env-pass`. The default Codex adapter receives only the safe environment plus `CODEX_HOME`.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `app-id` | yes | | GitHub App ID. |
| `private-key` | yes | | GitHub App private key. PEM, escaped newlines, and base64 PEM are accepted. |
| `installation-id` | no | `""` | GitHub App installation ID. If omitted, it is resolved from the current repository. |
| `max-inline-comments` | no | `10` | Maximum inline comments to post. |
| `post-empty-review` | no | `true` | Post a review summary when there are no inline comments. |
| `dry-run` | no | `false` | Print the GitHub review payload instead of posting. |
| `codex-home` | no | `""` | `CODEX_HOME` containing `config.toml` for the Codex adapter. |
| `codex-profile` | no | `""` | Optional Codex profile. |
| `codex-model` | no | `""` | Optional Codex model override. |
| `review-instructions` | no | `""` | Extra instructions appended to the review prompt. |
| `agent-command` | no | `""` | Custom agent executable. When empty, Codex is used. |
| `agent-args-json` | no | `[]` | JSON array of custom agent arguments. |
| `agent-env-pass` | no | `""` | Comma-separated environment variables to pass to a custom agent. |
| `agent-timeout-seconds` | no | `900` | Agent timeout in seconds. |
| `max-diff-bytes` | no | `250000` | Maximum diff size sent to the agent. |
| `allow-fork-prs` | no | `false` | Allow reviewing fork pull requests. Use only with isolated runners and no sensitive agent credentials. |
| `review-drafts` | no | `false` | Review draft pull requests. |
| `pr-number` | no | `""` | Pull request number for manual dispatch or non-PR events. |

## Review Output Schema

The agent must return JSON shaped like:

```json
{
  "summary": "Found 1 actionable finding.",
  "comments": [
    {
      "path": "src/server.js",
      "line": 42,
      "body": "Explain the concrete issue and smallest useful fix.",
      "severity": "high"
    }
  ]
}
```

Every inline comment is revalidated against the RIGHT side of the PR diff before Otter Reviewer sends it to GitHub.

## Repository Instructions

Add `.otter-reviewer.md` to the target repository for project-specific review guidance. Its contents are appended to the agent prompt.

## Security

Use Otter Reviewer only with trusted self-hosted runner isolation. Do not expose GitHub App private keys, Codex credentials, or custom agent credentials to untrusted pull requests.

Default guidance:

- Prefer private repositories or trusted internal contributors.
- Fork PRs are refused by default, including manual `workflow_dispatch` reviews. Enable `allow-fork-prs` only with a dedicated isolated runner design.
- Use ephemeral self-hosted runners and runner groups restricted to selected repositories.
- Keep runner registration credentials out of the job environment.
- Pin this action to `@v1`, a full release tag, or a commit SHA.
- Treat PR diff content and `.otter-reviewer.md` as untrusted prompt input.
- Custom agents are ordinary local processes. They are not sandboxed by this action.

See `SECURITY.md` for the security model and reporting process.

## License

MIT
