// index.js
// CI Matrix Planner — parse key=value directives from the *latest commit only*
//
// Precedence (highest → lowest):
//  1) message-override (input)
//  2) PR head commit (context.payload.pull_request.head.sha via API)
//  3) push head commit (GITHUB_SHA via API)
//  4) git log -1 (if checkout exists)
// If no directives found → computePlan() falls back to plan-ci.json defaults.

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
            try { resolve(JSON.parse(data || "{}")); }
            catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
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

// accept only simple key=value lines (ignore bullets, Markdown, etc.)
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
    if (!seen.has(x)) { seen.add(x); out.push(x); }
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

  // Global job and target pools
  const jobsCfg = cfg.jobs || ["feelpp", "testsuite", "toolboxes", "mor", "python"];
  const targetsCfg =
    cfg.targets || ["ubuntu:24.04", "ubuntu:22.04", "debian:13", "debian:12", "fedora:42"];

  // Build modes configuration (new unified schema)
  // Supports both old fullBuild.job and new modes.{name}.jobs format
  const modes = cfg.modes || {};

  // Build full mode job list from various sources (backwards compatible)
  const getFullModeJobs = () => {
    // 1. New schema: modes.full.jobs (array)
    if (modes.full?.jobs && Array.isArray(modes.full.jobs)) {
      return modes.full.jobs;
    }
    // 2. Old schema: fullBuild.job (string) or fullBuild.jobs (array)
    if (cfg.fullBuild) {
      if (Array.isArray(cfg.fullBuild.jobs)) return cfg.fullBuild.jobs;
      if (cfg.fullBuild.job) return [cfg.fullBuild.job];
    }
    // 3. Default fallback
    return ["feelpp-spack"];
  };

  const getFullModeTargets = () => {
    // 1. New schema: modes.full.targets
    if (modes.full?.targets && Array.isArray(modes.full.targets)) {
      return modes.full.targets;
    }
    // 2. Old schema: fullBuild.targets
    if (cfg.fullBuild?.targets && Array.isArray(cfg.fullBuild.targets)) {
      return cfg.fullBuild.targets;
    }
    // 3. Fall back to default targets
    return null; // will use defaultTargets
  };

  const fullModeJobs = getFullModeJobs();
  const fullModeTargets = getFullModeTargets();

  // Default jobs and targets (components mode)
  const defaultJobs = modes.components?.jobs || cfg.defaults?.jobs || jobsCfg;
  const defaultTargets = modes.components?.targets || cfg.defaults?.targets || targetsCfg;

  // Mode resolution
  // Precedence: modeInput > directives.mode > auto-detect from only= > defaults
  let mode =
    (opts.inputs && opts.inputs.modeInput) ||
    directives.mode ||
    cfg.defaults?.mode ||
    "components";
  mode = String(mode).toLowerCase();

  // Labels can switch mode (optional)
  if (labels.includes("ci-mode-full")) mode = "full";
  if (labels.includes("ci-mode-components")) mode = "components";

  // Auto-detect full mode: if only= contains a full mode job, switch to full mode
  const onlyJobsRaw = normalizeList(directives.only || "");
  if (onlyJobsRaw.length && !directives.mode) {
    const fullJobsLower = fullModeJobs.map(j => j.toLowerCase());
    const hasFullJob = onlyJobsRaw.some(j => fullJobsLower.includes(j.toLowerCase()));
    const hasComponentJob = onlyJobsRaw.some(j =>
      defaultJobs.map(dj => dj.toLowerCase()).includes(j.toLowerCase())
    );
    // If only full jobs requested (no component jobs), auto-switch to full mode
    if (hasFullJob && !hasComponentJob) {
      mode = "full";
    }
  }

  // Enabled jobs based on mode
  let enabledJobs = mode === "full" ? [...fullModeJobs] : [...defaultJobs];

  // Build the valid jobs pool for filtering (includes both component and full jobs)
  const allValidJobs = lowerUnique([...jobsCfg, ...fullModeJobs]);

  // only / skip jobs (from directives)
  const onlyJobsList = lowerUnique(
    normalizeList(directives.only || (cfg.defaults?.onlyJobs || []).join(" "))
  );
  const skipJobsList = lowerUnique(
    normalizeList(directives.skip || (cfg.defaults?.skipJobs || []).join(" "))
  );

  if (onlyJobsList.length) {
    // Filter only= against enabled jobs (which now includes full mode jobs when appropriate)
    enabledJobs = enabledJobs.filter((j) => onlyJobsList.includes(j.toLowerCase()));
  }
  if (skipJobsList.length) {
    enabledJobs = enabledJobs.filter((j) => !skipJobsList.includes(j.toLowerCase()));
  }

  // Resolve targets - use mode-specific defaults if available
  let modeDefaultTargets = mode === "full" && fullModeTargets
    ? fullModeTargets
    : defaultTargets;
  let workingTargets = [...modeDefaultTargets];

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
  if (!workingTargets.length) workingTargets = [...modeDefaultTargets];

  return {
    mode,
    enabledJobs,
    onlyJobs: onlyJobsList.join(" "),
    skipJobs: skipJobsList.join(" "),
    targetsList: workingTargets.join(" "),
    targetsJson: JSON.stringify(workingTargets),
    rawMessage: message,
    debug: { directives, labels, workingTargets, fullModeJobs, allValidJobs },
  };
}

/* =========================
 * Harvest message — latest commit only
 * =========================
 * Precedence:
 *  1) override
 *  2) PR head commit (via PR head SHA)
 *  3) push head commit
 *  4) git log -1
 */
async function harvestMessageLatestOnly({ token, owner, repo, eventPath, sha }) {
  // 0) override
  const override = core.getInput("message-override") || "";
  if (hasDirective(override)) {
    return { message: override.trim(), source: "override", headSha: null };
  }

  // 1) PR head commit by head SHA (most reliable, 1 call)
  if (token && owner && repo && eventPath && fs.existsSync(eventPath)) {
    try {
      const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
      const headSha = ev?.pull_request?.head?.sha;
      if (headSha) {
        const commit = await httpGetJson(
          `https://api.github.com/repos/${owner}/${repo}/commits/${headSha}`,
          token
        );
        const msg = (commit?.commit?.message || "").trim();
        return { message: msg, source: "pr-head-commit", headSha };
      }
    } catch (e) {
      core.warning(`PR head commit fetch (by head.sha) failed: ${e.message}`);
    }
  }

  // 2) Push head commit (API)
  if (token && owner && repo && sha) {
    try {
      const commit = await httpGetJson(
        `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
        token
      );
      const msg = (commit?.commit?.message || "").trim();
      return { message: msg, source: "push-head-commit", headSha: sha };
    } catch (e) {
      core.warning(`Push head commit fetch failed: ${e.message}`);
    }
  }

  // 3) git log -1 (fallback if checkout present)
  try {
    const msg = execSync("git log -1 --pretty=%B", {
      cwd: env("GITHUB_WORKSPACE") || process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return { message: msg, source: "git-log", headSha: null };
  } catch { /* ignore */ }

  // 4) none
  return { message: "", source: "none", headSha: null };
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

    // harvest latest-only
    const { message, source, headSha } = await harvestMessageLatestOnly({
      token,
      owner,
      repo,
      eventPath,
      sha,
    });

    // compute plan (falls back to config defaults if message has no directives)
    const plan = computePlan({
      config,
      message,
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
    core.setOutput("head_commit_sha", headSha || "");
    core.setOutput("raw_message", plan.rawMessage || message || "");
    core.setOutput("raw_directives", JSON.stringify(plan.debug?.directives || {}));

    // summary
    core.startGroup("planner summary");
    core.info(`SOURCE: ${source}`);
    if (headSha) core.info(`HEAD_SHA: ${headSha}`);
    core.info(`MODE: ${plan.mode}`);
    core.info(`ENABLED_JOBS: ${plan.enabledJobs.join(" ")}`);
    core.info(`ONLY_JOBS: ${plan.onlyJobs || "<empty>"}`);
    core.info(`SKIP_JOBS: ${plan.skipJobs || "<empty>"}`);
    core.info(`TARGETS_LIST: ${plan.targetsList}`);
    core.info(`TARGETS_JSON: ${plan.targetsJson}`);
    core.info(`RAW_MESSAGE: ${plan.rawMessage || "<empty>"}`);
    core.info(`RAW_DIRECTIVES: ${JSON.stringify(plan.debug?.directives || {})}`);
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
  hasDirective,
};