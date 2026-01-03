# CI Matrix Planner

!["Build Status"](https://github.com/feelpp/ci-matrix-planner/actions/workflows/test.yml/badge.svg)

A reusable GitHub Action to ***plan your CI job matrix*** based on commit messages, pull request metadata, or labels.  
It helps you control which jobs and targets are executed in your workflows, making CI faster, more configurable, and easier to maintain across projects.  

## ✨ Features

* Parse commit messages, PR titles/bodies, or labels for directives:
  * `mode=components` (default): run split jobs (feelpp, testsuite, toolboxes, mor, python).
  * `mode=full`: collapse into full-build job(s) (e.g. `feelpp-full`).
  * `only=...` → run only specific jobs (auto-detects full mode if full job is specified).
  * `skip=...` → skip specific jobs.
  * `targets=...` → override matrix targets.
  * `include=...` / `exclude=...` → adjust targets incrementally.
* **Auto-detect full mode**: Using `only=feelpp-full` automatically switches to full mode.
* **Mode-specific targets**: Full mode can have its own default targets.
* **Multiple full jobs**: Support for multiple jobs in full mode.
* Project-specific config via `.github/plan-ci.json`.
* Outputs are ready to use in `if:` conditions and `matrix: fromJSON(...)`.
* Built-in defaults if no config is provided.
* Includes unit tests and its own CI workflow.

## 🔧 Inputs

| Input | Description | Default |
| --- | --- | --- |
| `config-path` | Path to the JSON config file in the consumer repo (see below). | `.github/plan-ci.json` |

## 📤 Outputs

| Output | Description |
| --- | --- |
| `mode` | `components` or `full` |
| `only_jobs` | Space-separated list of jobs forced by `only=...` |
| `skip_jobs` | Space-separated list of jobs to skip (`skip=...` or inferred from message tokens) |
| `targets_json` | JSON array of targets (for `matrix: fromJSON(...)`) |
| `targets_list` | Space-separated list of targets (for condition checks) |

## 📄 Example Config (`.github/plan-ci.json`)

### Simple config (backwards compatible)

```json
{
  "jobs": ["feelpp", "testsuite", "toolboxes", "mor", "python"],
  "targets": ["ubuntu:24.04", "debian:13", "fedora:42"],
  "defaults": {
    "mode": "components",
    "jobs": ["feelpp", "testsuite", "toolboxes", "mor", "python"],
    "targets": ["ubuntu:24.04"]
  },
  "fullBuild": { "job": "feelpp-full" }
}
```

### Advanced config with mode-specific settings

```json
{
  "jobs": ["feelpp", "testsuite", "toolboxes", "mor", "python"],
  "targets": ["ubuntu:24.04", "debian:13", "fedora:42"],
  "defaults": {
    "mode": "components",
    "targets": ["ubuntu:24.04"]
  },
  "modes": {
    "components": {
      "jobs": ["feelpp", "testsuite", "toolboxes", "mor", "python"],
      "targets": ["ubuntu:24.04"]
    },
    "full": {
      "jobs": ["feelpp-full"],
      "targets": ["ubuntu:24.04"]
    }
  }
}
```

### Config with multiple full mode jobs

```json
{
  "jobs": ["feelpp", "toolboxes", "mor", "python"],
  "fullBuild": {
    "jobs": ["feelpp-full", "feelpp-full-debug"],
    "targets": ["ubuntu:24.04"]
  }
}
```

## 🚀 Usage in Workflow

```yaml
jobs:
  plan_ci:
    runs-on: ubuntu-latest
    outputs:
      mode:         ${{ steps.plan.outputs.mode }}
      only_jobs:    ${{ steps.plan.outputs.only_jobs }}
      skip_jobs:    ${{ steps.plan.outputs.skip_jobs }}
      targets_json: ${{ steps.plan.outputs.targets_json }}
      targets_list: ${{ steps.plan.outputs.targets_list }}
    steps:
      - uses: actions/checkout@v4
      - id: plan
        uses: feelpp/ci-matrix-planner@v1
        with:
          config-path: .github/plan-ci.json

  feelpp:
    needs: plan_ci
    if: >
      (needs.plan_ci.outputs.only_jobs == '' || contains(needs.plan_ci.outputs.only_jobs, 'feelpp')) &&
      !contains(needs.plan_ci.outputs.skip_jobs, 'feelpp')
    runs-on: self-docker
    strategy:
      matrix:
        target: ${{ fromJSON(needs.plan_ci.outputs.targets_json) }}
    steps:
      - run: echo "Building feelpp on ${{ matrix.target }} in mode=${{ needs.plan_ci.outputs.mode }}"
```

## 📌 Example Directives in Commit or PR

| Directive | Effect |
| --- | --- |
| `only=feelpp` | Run only the `feelpp` job |
| `only=feelpp-full` | Auto-switch to full mode and run `feelpp-full` |
| `skip=python` | Skip the `python` job |
| `targets=fedora:42` | Restrict matrix to Fedora 42 |
| `include=debian:13` | Add Debian 13 to current targets |
| `exclude=ubuntu:22.04` | Remove Ubuntu 22.04 from current targets |
| `mode=full` | Switch to full mode, run configured full job(s) |
| `mode=full only=feelpp-full` | Full mode with specific job filter |

### Labels

You can also use PR labels to control mode:
- `ci-mode-full` → Switch to full mode
- `ci-mode-components` → Switch to components mode (default)

## 🧪 Development & Testing

* The planner logic is implemented in `index.js` and exposed as a pure function `computePlan()`.
* Unit tests live in `tests/` with fixtures in JSON form.
* Run tests locally with:

```bash
npm install
npm test
```

* CI is set up in this repo to run tests automatically on push/PR.

## ✅ Summary

`ci-matrix-planner` makes your CI ***config-driven***.  
By parsing directives in commit messages, PRs, or labels, it lets you **control what to build and where** — without duplicating workflow YAML.
