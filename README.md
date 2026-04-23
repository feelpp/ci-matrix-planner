# CI Matrix Planner

[![CI](https://github.com/feelpp/ci-matrix-planner/actions/workflows/ci.yml/badge.svg)](https://github.com/feelpp/ci-matrix-planner/actions/workflows/ci.yml)

A reusable GitHub Action to ***plan your CI job matrix*** based on action inputs, workflow dispatch inputs, pull request metadata, labels, or commit messages.  
It helps you control which jobs and targets are executed in your workflows, making CI faster, more configurable, and easier to maintain across projects.  

## ✨ Features

* Parse directives from:
  * explicit action inputs
  * `workflow_dispatch` event inputs
  * PR labels
  * PR title/body
  * PR head commit or push head commit
* Supported directives:
  * `mode=components` (default): run split jobs (feelpp, testsuite, toolboxes, mor).
  * `mode=full`: collapse into full-build job(s) (e.g. `feelpp-full`).
  * `only=...` → run only specific jobs (auto-detects full mode if full job is specified).
  * `skip=...` → skip specific jobs.
  * `targets=...` → override matrix targets.
  * `include=...` / `exclude=...` → adjust targets incrementally.
* `pkg=...` → select packaging targets (profile-driven).
* `pkg-include=...` / `pkg-exclude=...` → adjust packaging targets incrementally.
* Catalog-backed profiles such as `images` emit `matrix_json` directly from their target catalog.
* Non-catalog profiles such as `ci` can set `matrixCatalogProfile` to enrich `matrix_json` from another profile catalog.
* `profile: packaging` remains packaging-specific and emits the packaging matrix as the primary `matrix_json`.
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
| `mode-input` | Override mode directly. | `""` |
| `message-override` | Override the directive message directly. | `""` |
| `labels-override` | Comma-separated labels to use instead of payload labels. | `""` |
| `github-token` | Token used to read PR/push commit messages via the GitHub API. | `""` |
| `profile` | Explicit profile to resolve when using profile-based configs. | `""` |

## 📤 Outputs

| Output | Description |
| --- | --- |
| `mode` | `components`, `full`, `packaging`, or the active catalog-backed profile name such as `images` |
| `only_jobs` | Space-separated list of jobs forced by `only=...` |
| `only_jobs_json` | JSON array of jobs forced by `only=...` |
| `skip_jobs` | Space-separated list of jobs to skip (`skip=...` or inferred from message tokens) |
| `skip_jobs_json` | JSON array of jobs to skip |
| `targets_json` | JSON array of selected target keys |
| `targets_list` | Space-separated list of selected target keys |
| `matrix_json` | JSON workflow matrix object for the selected profile |
| `enabled_jobs` | Space-separated list of jobs that will run |
| `enabled_jobs_json` | JSON array of jobs that will run |
| `warnings_json` | JSON array of planner warnings |
| `profile` | Resolved profile (for profile-based configs) |
| `enabled_profiles_json` | JSON array of enabled profiles |
| `pkg_enabled` | Whether packaging targets are enabled |
| `pkg_targets_json` | JSON array of packaging targets |
| `pkg_matrix_json` | JSON packaging matrix object |
| `pkg_matrix_rows_json` | JSON array of packaging matrix rows |
| `directive_source` | Source used for directive harvesting |
| `head_commit_sha` | Commit SHA used when directives were harvested from a commit |

## 📄 Example Config (`.github/plan-ci.json`)

### Simple config (backwards compatible)

```json
{
  "jobs": ["feelpp", "testsuite", "toolboxes", "mor"],
  "targets": ["ubuntu:24.04", "debian:13", "fedora:42"],
  "defaults": {
    "mode": "components",
    "jobs": ["feelpp", "testsuite", "toolboxes", "mor"],
    "targets": ["ubuntu:24.04"]
  },
  "fullBuild": { "job": "feelpp-full" }
}
```

### Advanced config with mode-specific settings

```json
{
  "jobs": ["feelpp", "testsuite", "toolboxes", "mor"],
  "targets": ["ubuntu:24.04", "debian:13", "fedora:42"],
  "defaults": {
    "mode": "components",
    "targets": ["ubuntu:24.04"]
  },
  "modes": {
    "components": {
      "jobs": ["feelpp", "testsuite", "toolboxes", "mor"],
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
  "jobs": ["feelpp", "toolboxes", "mor"],
  "fullBuild": {
    "jobs": ["feelpp-full", "feelpp-full-debug"],
    "targets": ["ubuntu:24.04"]
  }
}
```

### Config with CI matrix enrichment from another profile

```json
{
  "profiles": {
    "ci": {
      "jobs": ["feelpp", "testsuite", "toolboxes", "mor"],
      "targets": ["ubuntu:noble", "debian:trixie"],
      "matrixCatalogProfile": "images",
      "defaults": {
        "mode": "components",
        "targets": ["ubuntu:noble"]
      }
    },
    "images": {
      "jobs": ["images"],
      "defaults": {
        "targets": ["ubuntu:noble"]
      },
      "catalog": {
        "ubuntu:noble": {
          "oci_dist": "ubuntu-24.04",
          "image_backend": "apt",
          "image_strategy": "components",
          "base_image": "ubuntu:24.04"
        }
      }
    }
  }
}
```

With `matrixCatalogProfile`, the `ci` profile still chooses jobs and targets,
but its `matrix_json` rows are resolved from `profiles.images.catalog` instead of
the fallback `{ "target": [...] }` shape.

## 🚀 Usage in Workflow

```yaml
jobs:
  plan_ci:
    runs-on: ubuntu-latest
    outputs:
      mode:         ${{ steps.plan.outputs.mode }}
      enabled_jobs_json: ${{ steps.plan.outputs.enabled_jobs_json }}
      only_jobs:    ${{ steps.plan.outputs.only_jobs }}
      only_jobs_json: ${{ steps.plan.outputs.only_jobs_json }}
      skip_jobs_json: ${{ steps.plan.outputs.skip_jobs_json }}
      matrix_json: ${{ steps.plan.outputs.matrix_json }}
    steps:
      - uses: actions/checkout@v4
      - id: plan
        uses: feelpp/ci-matrix-planner@v1
        with:
          config-path: .github/plan-ci.json

  feelpp:
    needs: plan_ci
    if: contains(fromJSON(needs.plan_ci.outputs.enabled_jobs_json), 'feelpp')
    runs-on: self-docker
    strategy:
      matrix: ${{ fromJSON(needs.plan_ci.outputs.matrix_json) }}
    steps:
      - run: echo "Building feelpp on ${{ matrix.target }} in mode=${{ needs.plan_ci.outputs.mode }}"
```

### Packaging Profile Usage

```yaml
jobs:
  plan_pkg:
    runs-on: ubuntu-latest
    outputs:
      matrix_json: ${{ steps.plan.outputs.matrix_json }}
    steps:
      - uses: actions/checkout@v4
      - id: plan
        uses: feelpp/ci-matrix-planner@v1
        with:
          config-path: .github/plan-ci.json
          profile: packaging

  build_pkg:
    needs: plan_pkg
    strategy:
      matrix: ${{ fromJSON(needs.plan_pkg.outputs.matrix_json) }}
    steps:
      - run: echo "Packaging ${{ matrix.flavor }}:${{ matrix.dist }}"
```

### Catalog-Backed Image Profile Usage

```yaml
jobs:
  plan_images:
    runs-on: ubuntu-latest
    outputs:
      matrix_json: ${{ steps.plan.outputs.matrix_json }}
    steps:
      - uses: actions/checkout@v4
      - id: plan
        uses: feelpp/ci-matrix-planner@v1
        with:
          config-path: .github/plan-ci.json
          profile: images

  build_images:
    needs: plan_images
    strategy:
      matrix: ${{ fromJSON(needs.plan_images.outputs.matrix_json) }}
    steps:
      - run: echo "Build OCI image target ${{ matrix.target }} via ${{ matrix.image_backend }} (${{ matrix.image_strategy }})"
```

## 📐 Resolution Order

The planner resolves directives in this order:

1. explicit action inputs
2. `workflow_dispatch` event inputs
3. PR labels
4. PR title/body
5. PR head commit message
6. push head commit message
7. `git log -1`

## 📌 Example Directives in Commit or PR

| Directive | Effect |
| --- | --- |
| `only=feelpp` | Run only the `feelpp` job |
| `only=feelpp-full` | Auto-switch to full mode and run `feelpp-full` |
| `skip=toolboxes` | Skip the `toolboxes` job |
| `targets=fedora:42` | Restrict matrix to Fedora 42 |
| `include=debian:13` | Add Debian 13 to current targets |
| `exclude=ubuntu:22.04` | Remove Ubuntu 22.04 from current targets |
| `mode=full` | Switch to full mode, run configured full job(s) |
| `mode=full only=feelpp-full` | Full mode with specific job filter |
| `pkg=noble,trixie` | Select packaging targets |
| `pkg=none` | Disable packaging targets explicitly |
| `pkg=spack pkg-exclude=spack-openmpi` | Select spack targets and exclude one |

For catalog-backed profiles such as `images`, use `targets=...`, `include=...`,
and `exclude=...` against the profile catalog and its groups.

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
