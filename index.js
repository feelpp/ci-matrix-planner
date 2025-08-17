// index.js
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
const core = require("@actions/core");

/* =========================
 * Small helpers
 * ========================= */

function httpGetJson(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "ci-matrix-planner",
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data || "{}"));
            } catch (e) {
              reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function env(name, def = "") {
  return process.env[name] || def;
}

/* =========================
 * Pure planner utilities
 * ========================= */

function parseDirectives(msg) {
  const out = {};
  if (!msg) return out;
  const lines = String(msg).split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      out[key] = val;
    }
  }
  return out;
}

function normalizeList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[, \n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function lowerUnique(list) {
  const seen = new Set();
  const out = [];
  for (const x of list.map((s) => String(s).toLowerCase())) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

function computePlan(opts) {
  // opts = { config, message, labels, inputs }
  const cfg = opts.config || {};
  const message = (opts.message || "").trim();
  const labels = lowerUnique(opts.labels || []);

  const directives = parseDirectives(message);

  // Mode resolution
  let mode =
    (opts.inputs && opts.inputs.modeInput) ||
    directives.mode ||
    cfg.defaults?.mode ||
    "components";
  mode = String(mode).toLowerCase();

  // Job universe & defaults
  const jobsCfg = cfg.jobs || ["feelpp", "testsuite", "toolboxes", "mor", "python"];
  const defaultJobs = cfg.defaults?.jobs || jobsCfg;

  // Target universe & defaults
  const targetsCfg =
    cfg.targets ||
    ["ubuntu:24.04", "ubuntu:22.04", "debian:13", "debian:12", "fedora:42"];
  const defaultTargets = cfg.defaults?.targets || targetsCfg;

  // Labels may switch mode (optional)
  if (labels.includes("ci-mode-full")) mode = "full";
  if (labels.includes("ci-mode-components")) mode = "components";

  // If mode=full, collapse to a single “full” job (e.g., feelpp-spack)
  let enabledJobs;
  if (mode === "full") {
    const fullJob = (cfg.fullBuild && cfg.fullBuild.job) || "feelpp-spack";
    enabledJobs = [fullJob];
  } else {
    enabledJobs = [...defaultJobs];
  }

  // only / skip job selection
  const onlyJobs = lowerUnique(
    normalizeList(directives.only || (cfg.defaults?.onlyJobs || []).join(" "))
  );
  const skipJobs = lowerUnique(
    normalizeList(directives.skip || (cfg.defaults?.skipJobs || []).join(" "))
  );

  if (onlyJobs.length) {
    enabledJobs = enabledJobs.filter((j) => onlyJobs.includes(j.toLowerCase()));
  }
  if (skipJobs.length) {
    enabledJobs = enabledJobs.filter((j) => !skipJobs.includes(j.toLowerCase()));
  }

  // Resolve targets
  let workingTargets = [...defaultTargets];

  // If only= contains platform-like specs (with ":"), treat it as targets filter
  if (directives.only && directives.only.includes(":")) {
    workingTargets = normalizeList(directives.only);
  }

  if (directives.targets) {
    workingTargets = normalizeList(directives.targets);
  }
  if (directives.include) {
    for (const t of normalizeList(directives.include)) {
      if (!workingTargets.includes(t)) workingTargets.push(t);
    }
  }
  if (directives.exclude) {
    const ex = new Set(normalizeList(directives.exclude));
    workingTargets = workingTargets.filter((t) => !ex.has(t));
  }
  if (!workingTargets.length) {
    workingTargets = [...defaultTargets];
  }

  return {
    mode,
    enabledJobs,
    onlyJobs: onlyJobs.join(" "),
    skipJobs: skipJobs.join(" "),
    targetsJson: JSON.stringify(workingTargets),
    targetsList: workingTargets.join(" "),
  };
}

/* =========================
 * Action entrypoint
 * ========================= */

if (require.main === module) {
  (async () => {
    try {
      // Inputs
      const configPath      = core.getInput("config-path") || ".github/plan-ci.json";
      const token           = core.getInput("github-token") || env("GITHUB_TOKEN") || env("GH_TOKEN") || "";
      const messageOverride = core.getInput("message-override") || "";
      const labelsOverride  = core.getInput("labels-override") || "";
      const modeInput       = core.getInput("mode-input") || "";

      // Load optional config
      let config = {};
      try {
        const cfgText = fs.readFileSync(path.resolve(process.cwd(), configPath), "utf8");
        config = JSON.parse(cfgText);
      } catch (e) {
        core.warning(`No config at ${configPath}; using defaults. (${e.message})`);
      }

      // Build canonical message + labels
      let message = messageOverride;
      let labels = normalizeList(labelsOverride);

      const repoFull = env("GITHUB_REPOSITORY"); // owner/repo
      const [owner, repo] = repoFull ? repoFull.split("/") : ["", ""];
      const eventPath = env("GITHUB_EVENT_PATH");
      const sha = env("GITHUB_SHA");

      // Prefer PR title/body when available; otherwise push head_commit
      if (!message && eventPath && fs.existsSync(eventPath)) {
        try {
          const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
          if (ev.pull_request) {
            const title = ev.pull_request.title || "";
            const body  = ev.pull_request.body || "";
            message = `${title}\n\n${body}`.trim();
            labels = (ev.pull_request.labels || [])
              .map((l) => (l && (l.name || l)) ? String(l.name || l).toLowerCase() : "")
              .filter(Boolean);
          } else if (ev.head_commit && ev.head_commit.message) {
            message = ev.head_commit.message;
          } else if (ev.commits && ev.commits.length) {
            message = ev.commits[ev.commits.length - 1].message || "";
          }
        } catch (e) {
          core.warning(`Could not parse GITHUB_EVENT_PATH: ${e.message}`);
        }
      }

      const hasDirective = (txt) =>
        /\b(only|skip|targets|include|exclude|mode)\s*=/.test(txt || "");

      // If PR text has no directives, fetch last commit message via API
      if (!hasDirective(message) && token && owner && repo && eventPath && fs.existsSync(eventPath)) {
        try {
          const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
          if (ev.pull_request) {
            const prNumber = ev.pull_request.number;
            const commits = await httpGetJson(
              `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits`,
              token
            );
            if (Array.isArray(commits) && commits.length) {
              const last = commits[commits.length - 1];
              const commitMsg = last?.commit?.message || "";
              if (hasDirective(commitMsg)) {
                message = `${message ? message + "\n\n---\n" : ""}${commitMsg}`;
                core.info("Planner: directives found in PR head commit via API.");
              }
            }
          } else if (sha) {
            const commit = await httpGetJson(
              `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
              token
            );
            const commitMsg = commit?.commit?.message || "";
            if (hasDirective(commitMsg)) {
              message = commitMsg;
              core.info("Planner: directives found in push head commit via API.");
            }
          }
        } catch (e) {
          core.warning(`Could not fetch commit message via GitHub API: ${e.message}`);
        }
      }

      // Fallback to git log -1 if still no directives and repo is checked out
      if (!hasDirective(message)) {
        try {
          const gitMsg = execSync("git log -1 --pretty=%B", {
            cwd: env("GITHUB_WORKSPACE") || process.cwd(),
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
          }).trim();
          if (hasDirective(gitMsg)) {
            message = `${message ? message + "\n\n---\n" : ""}${gitMsg}`;
            core.info("Planner: directives found in latest commit via git log.");
          }
        } catch {
          // ignore
        }
      }

      const plan = computePlan({
        config,
        message,
        labels,
        inputs: { modeInput },
      });

      // Emit outputs via official SDK (reliable)
      core.setOutput("mode", plan.mode);
      core.setOutput("only_jobs", plan.onlyJobs);
      core.setOutput("skip_jobs", plan.skipJobs);
      core.setOutput("targets_json", plan.targetsJson);
      core.setOutput("targets_list", plan.targetsList);
      core.setOutput("enabled_jobs", plan.enabledJobs.join(" "));

      // Summary
      core.info("---- planner summary ----");
      core.info(`MODE: ${plan.mode}`);
      core.info(`ENABLED_JOBS: ${plan.enabledJobs.join(" ")}`);
      core.info(`ONLY_JOBS: ${plan.onlyJobs || "<empty>"}`);
      core.info(`SKIP_JOBS: ${plan.skipJobs || "<empty>"}`);
      core.info(`TARGETS_LIST: ${plan.targetsList}`);
      core.info(`TARGETS_JSON: ${plan.targetsJson}`);
      core.info("-------------------------");
    } catch (err) {
      core.setFailed(err instanceof Error ? err.message : String(err));
    }
  })();
}

// Export pure utils for unit tests
module.exports = { computePlan, parseDirectives, normalizeList, lowerUnique };
