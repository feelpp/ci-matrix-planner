// index.js
// CI Matrix Planner — parse key=value directives from PRs / commits
// Precedence (highest → lowest):
//  1) message-override (input)
//  2) PR head commit (latest commit in PR)
//  3) PR title/body (as defaults)
//  4) push head commit (for push events)
//  5) git log -1 (if checkout exists)
// If no directives found → fall back to plan-ci.json defaults via computePlan().

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

// strict detector: key=value at start of a line (multiline)
const hasDirective = (txt) =>
  /^\s*(only|skip|targets|include|exclude|mode)\s*=/m.test(txt || "");

// split list on commas and/or whitespace; trim; drop empties
function normalizeList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// only accept simple key=value lines (ignore bullets, Markdown, etc.)
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

function extractDirectiveLines(txt) {
  if (!txt) return [];
  return String(txt)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((l) => /^\s*(only|skip|targets|include|exclude|mode)\s*=/.test(l));
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

  // Labels can switch mode (optional)
  if (labels.includes("ci-mode-full")) mode = "full";
  if (labels.includes("ci-mode-components")) mode = "components";

  // Enabled jobs
  let enabledJobs =
    mode === "full"
      ? [(cfg.fullBuild && cfg.fullBuild.job) || "feelpp-spack"]
      : [...defaultJobs];

  // only / skip jobs (from directives)
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

  // allow only= to carry platforms if it contains ':'
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
 * Harvest message with PR defaults
 * =========================
 * Precedence:
 *  1) override
 *  2) PR head commit (latest)
 *  3) PR title/body (defaults)
 *  4) push head commit
 *  5) git log -1
 */
async function harvestLatestWithPRDefaults({ token, owner, repo, eventPath, sha }) {
  // 0) override
  const override = core.getInput("message-override") || "";
  if (hasDirective(override)) {
    return {
      effectiveMessage: override.trim(),
      prBodyDefaultsMessage: "",
      headCommitMessage: override.trim(),
      source: "override",
    };
  }

  let prBodyDefaults = "";
  let headCommitMsg = "";
  let source = "none";
  let prNumber = null;

  // read event payload (PR defaults and PR number)
  if (eventPath && fs.existsSync(eventPath)) {
    try {
      const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      if (ev.pull_request) {
        prNumber = ev.pull_request.number || null;
        const title = ev.pull_request.title || "";
        const body = ev.pull_request.body || "";
        const defaultsLines = extractDirectiveLines(`${title}\n\n${body}`);
        if (defaultsLines.length) {
          prBodyDefaults = defaultsLines.join("\n");
          source = "pr-body-defaults";
        }
      }
    } catch (e) {
      core.warning(`Could not parse GITHUB_EVENT_PATH: ${e.message}`);
    }
  }

  // prefer PR head commit (latest in PR)
  if (token && owner && repo && prNumber) {
    try {
      const commits = await httpGetJson(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits`,
        token
      );
      if (Array.isArray(commits) && commits.length) {
        const head = commits[commits.length - 1];
        headCommitMsg = (head?.commit?.message || "").trim();
        if (hasDirective(headCommitMsg)) source = "pr-head-commit";
      }
    } catch (e) {
      core.warning(`PR head commit fetch failed: ${e.message}`);
    }
  }

  // push head commit (if not PR)
  if (!headCommitMsg && token && owner && repo && sha) {
    try {
      const commit = await httpGetJson(
        `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
        token
      );
      headCommitMsg = (commit?.commit?.message || "").trim();
      if (hasDirective(headCommitMsg)) source = "push-head-commit";
    } catch (e) {
      core.warning(`Push head commit fetch failed: ${e.message}`);
    }
  }

  // git fallback
  if (!headCommitMsg) {
    try {
      const m = execSync("git log -1 --pretty=%B", {
        cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      headCommitMsg = m;
      if (hasDirective(headCommitMsg) && source === "none") source = "git-log";
    } catch {
      /* ignore */
    }
  }

  // Merge defaults (PR body) with head commit — latest wins
  const defaultsObj = parseDirectives(prBodyDefaults);
  const headObj = parseDirectives(headCommitMsg);
  const merged = { ...defaultsObj, ...headObj };

  const effectiveMessage = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
    .trim();

  return {
    effectiveMessage,
    prBodyDefaultsMessage: prBodyDefaults,
    headCommitMessage: headCommitMsg,
    source,
  };
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
    const labelsOverride = normalizeList(core.getInput("labels-override") || "");

    // load config
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

    // harvest directives
    const {
      effectiveMessage,
      prBodyDefaultsMessage,
      headCommitMessage,
      source,
    } = await harvestLatestWithPRDefaults({ token, owner, repo, eventPath, sha });

    // compute plan (falls back to config defaults if effectiveMessage is empty)
    const plan = computePlan({
      config,
      message: effectiveMessage,
      labels: labelsOverride,
      inputs: { modeInput },
    });

    // outputs
    core.setOutput("mode", plan.mode);
    core.setOutput("only_jobs", plan.onlyJobs);
    core.setOutput("skip_jobs", plan.skipJobs);
    core.setOutput("targets_json", plan.targetsJson);
    core.setOutput("targets_list", plan.targetsList);
    core.setOutput("enabled_jobs", plan.enabledJobs.join(" "));

    // debug
    core.setOutput("directive_source", source);
    core.setOutput("raw_message", plan.rawMessage || effectiveMessage || "");
    core.setOutput("raw_directives", JSON.stringify(plan.debug?.directives || {}));
    core.setOutput("raw_pr_body_defaults", prBodyDefaultsMessage || "");
    core.setOutput("raw_head_commit", headCommitMessage || "");

    // summary
    core.startGroup("planner summary");
    core.info(`SOURCE: ${source}`);
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

module.exports = {
  computePlan,
  parseDirectives,
  normalizeList,
  lowerUnique,
  // exported in case you want to unit test harvesting separately later
  hasDirective,
  extractDirectiveLines,
};