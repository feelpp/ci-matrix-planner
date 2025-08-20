// index.js
// CI Matrix Planner — robust PR/commit directive parsing with @actions/core outputs

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
const core = require("@actions/core");

/* =========================
 * Small helpers
 * ========================= */

const env = (k, d = "") => process.env[k] || d;

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

// STRICT match: line that *starts* with key = value (multiline)
const hasDirective = (txt) =>
  /^\s*(only|skip|targets|include|exclude|mode)\s*=/m.test(txt || "");

// Split on commas and/or whitespace; trim; drop empties
function normalizeList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Accept only simple key=value lines (ignore bullets, Markdown, etc.)
function parseDirectives(msg) {
  const out = {};
  if (!msg) return out;
  for (const ln of String(msg).split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function lowerUnique(list) {
  const seen = new Set();
  const out = [];
  for (const x of (list || []).map((s) => String(s).toLowerCase())) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/* =========================
 * Planner core (pure)
 * ========================= */

function computePlan(opts) {
  const cfg = opts.config || {};
  const message = (opts.message || "").trim();
  const labels = lowerUnique(opts.labels || []);
  const directives = parseDirectives(message);

  // Mode
  let mode =
    (opts.inputs && opts.inputs.modeInput) ||
    directives.mode ||
    cfg.defaults?.mode ||
    "components";
  mode = String(mode).toLowerCase();

  // Jobs & defaults
  const jobsCfg = cfg.jobs || ["feelpp", "testsuite", "toolboxes", "mor", "python"];
  const defaultJobs = cfg.defaults?.jobs || jobsCfg;

  // Targets & defaults
  const targetsCfg =
    cfg.targets || ["ubuntu:24.04", "ubuntu:22.04", "debian:13", "debian:12", "fedora:42"];
  const defaultTargets = cfg.defaults?.targets || targetsCfg;

  // Labels can switch mode
  if (labels.includes("ci-mode-full")) mode = "full";
  if (labels.includes("ci-mode-components")) mode = "components";

  // Enabled jobs
  let enabledJobs =
    mode === "full"
      ? [(cfg.fullBuild && cfg.fullBuild.job) || "feelpp-spack"]
      : [...defaultJobs];

  // only/skip job filters
  const onlyJobsList = lowerUnique(
    normalizeList(directives.only || (cfg.defaults?.onlyJobs || []).join(" "))
  );
  const skipJobsList = lowerUnique(
    normalizeList(directives.skip || (cfg.defaults?.skipJobs || []).join(" "))
  );

  if (onlyJobsList.length) {
    enabledJobs = enabledJobs.filter((j) => onlyJobsList.includes(j.toLowerCase()));
  }
  if (skipJobsList.length) {
    enabledJobs = enabledJobs.filter((j) => !skipJobsList.includes(j.toLowerCase()));
  }

  // Resolve targets
  let workingTargets = [...defaultTargets];

  // Allow only= to carry platforms if it contains ':'
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
  if (!workingTargets.length) workingTargets = [...defaultTargets];

  return {
    mode,
    enabledJobs,
    onlyJobs: onlyJobsList.join(" "),
    skipJobs: skipJobsList.join(" "),
    targetsList: workingTargets.join(" "),
    targetsJson: JSON.stringify(workingTargets),
    rawMessage: message,
    debug: { directives, labels, workingTargets },
  };
}

/* =========================
 * Message harvesting
 * ========================= */

async function harvestMessage({ token, owner, repo, eventPath, sha }) {
  // 0) Start from overrides (if any)
  let message = core.getInput("message-override") || "";
  let labels = normalizeList(core.getInput("labels-override") || "");

  // 1) Event payload — PR title/body or push head commit
  if (!message && eventPath && fs.existsSync(eventPath)) {
    try {
      const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      if (ev.pull_request) {
        const title = ev.pull_request.title || "";
        const body = ev.pull_request.body || "";
        message = `${title}\n\n${body}`.trim();
        labels = (ev.pull_request.labels || [])
          .map((l) => (l && (l.name || l)) ? String(l.name || l).toLowerCase() : "")
          .filter(Boolean);
      } else if (ev.head_commit?.message) {
        message = ev.head_commit.message;
      } else if (Array.isArray(ev.commits) && ev.commits.length) {
        message = ev.commits[ev.commits.length - 1].message || "";
      }
    } catch (e) {
      core.warning(`Could not parse GITHUB_EVENT_PATH: ${e.message}`);
    }
  }

  // 2) If PR text has no directives, scan PR commits (newest → oldest) via API
  if (!hasDirective(message) && token && owner && repo && eventPath && fs.existsSync(eventPath)) {
    try {
      const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      if (ev.pull_request?.number) {
        const prNumber = ev.pull_request.number;
        const commits = await httpGetJson(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits`,
          token
        );
        if (Array.isArray(commits) && commits.length) {
          for (let i = commits.length - 1; i >= 0; i--) {
            const cm = commits[i]?.commit?.message || "";
            if (hasDirective(cm)) {
              message = cm;
              core.info(`Planner: directives taken from PR commit ${i + 1}/${commits.length}.`);
              break;
            }
          }
        }
      } else if (sha) {
        const commit = await httpGetJson(
          `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
          token
        );
        const cm = commit?.commit?.message || "";
        if (hasDirective(cm)) {
          message = cm;
          core.info("Planner: directives found in push head commit via API.");
        }
      }
    } catch (e) {
      core.warning(`Could not fetch commits via API: ${e.message}`);
    }
  }

  // 3) Fallback to git log -1 (requires checkout) if still nothing
  if (!hasDirective(message)) {
    try {
      const gitMsg = execSync("git log -1 --pretty=%B", {
        cwd: env("GITHUB_WORKSPACE") || process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      if (hasDirective(gitMsg)) {
        message = gitMsg;
        core.info("Planner: directives found via git log.");
      }
    } catch {
      // ignore
    }
  }

  return { message, labels };
}

/* =========================
 * Action entrypoint
 * ========================= */

async function run() {
  try {
    const configPath = core.getInput("config-path") || ".github/plan-ci.json";
    const token =
      core.getInput("github-token") || env("GITHUB_TOKEN") || env("GH_TOKEN") || "";
    const modeInput = core.getInput("mode-input") || "";

    // Load config
    let config = {};
    try {
      const t = fs.readFileSync(path.resolve(process.cwd(), configPath), "utf8");
      config = JSON.parse(t);
    } catch (e) {
      core.warning(`No config at ${configPath}; using defaults. (${e.message})`);
    }

    const repoFull = env("GITHUB_REPOSITORY");
    const [owner, repo] = repoFull ? repoFull.split("/") : ["", ""];
    const eventPath = env("GITHUB_EVENT_PATH");
    const sha = env("GITHUB_SHA");

    // Get message (PR/commit) and labels
    const { message, labels } = await harvestMessage({
      token,
      owner,
      repo,
      eventPath,
      sha,
    });

    // Compute plan
    const plan = computePlan({
      config,
      message,
      labels,
      inputs: { modeInput },
    });

    // Outputs (official SDK)
    core.setOutput("mode", plan.mode);
    core.setOutput("only_jobs", plan.onlyJobs);
    core.setOutput("skip_jobs", plan.skipJobs);
    core.setOutput("targets_json", plan.targetsJson); // use fromJson(...) in matrix
    core.setOutput("targets_list", plan.targetsList); // logging convenience
    core.setOutput("enabled_jobs", plan.enabledJobs.join(" "));
    // Debug outputs
    core.setOutput("raw_message", plan.rawMessage || message || "");
    core.setOutput("raw_directives", JSON.stringify(plan.debug?.directives || {}));
    core.setOutput("targets_debug", JSON.stringify(plan.debug?.workingTargets || []));

    // Summary in logs
    core.startGroup("planner summary");
    core.info(`MODE: ${plan.mode}`);
    core.info(`ENABLED_JOBS: ${plan.enabledJobs.join(" ")}`);
    core.info(`ONLY_JOBS: ${plan.onlyJobs || "<empty>"}`);
    core.info(`SKIP_JOBS: ${plan.skipJobs || "<empty>"}`);
    core.info(`TARGETS_LIST: ${plan.targetsList}`);
    core.info(`TARGETS_JSON: ${plan.targetsJson}`);
    core.endGroup();
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

if (require.main === module) run();

module.exports = { computePlan, parseDirectives, normalizeList, lowerUnique };