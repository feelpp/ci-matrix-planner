// index.js
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/* =========================
 * Pure, testable planner API
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

  // Jobs universe & defaults
  const jobsCfg = cfg.jobs || ["feelpp", "testsuite", "toolboxes", "mor", "python"];
  const defaultJobs = cfg.defaults?.jobs || jobsCfg;

  // Targets universe & defaults
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

  // Allow `only=` to specify targets if it contains colon(s)
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

  // Convert to outputs
  const targetsJson = JSON.stringify(workingTargets);
  const targetsList = workingTargets.join(" ");

  return {
    mode,
    enabledJobs,
    onlyJobs: onlyJobs.join(" "),
    skipJobs: skipJobs.join(" "),
    targetsJson,
    targetsList,
  };
}

/* =========================
 * GitHub Action entrypoint
 * ========================= */

if (require.main === module) {
  const core = {
    getInput(name) {
      return process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "";
    },
    setOutput(name, value) {
      // Multi-line output safe delimiter
      const delim = `EOF_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      process.stdout.write(`${name}<<${delim}\n${value}\n${delim}\n`);
    },
    info: console.log,
    warning: console.warn,
  };

  try {
    // Load optional config
    const configPath = core.getInput("config-path") || ".github/plan-ci.json";
    let config = {};
    try {
      const cfgText = fs.readFileSync(path.resolve(process.cwd(), configPath), "utf8");
      config = JSON.parse(cfgText);
    } catch (e) {
      core.warning(`No config found at ${configPath}, using defaults. (${e.message})`);
    }

    // 1) Build a canonical message from multiple sources
    let message = core.getInput("message-override") || "";
    let labels = normalizeList(core.getInput("labels-override"));

    // Event payload (PR title/body, labels OR push head commit)
    try {
      const eventPath = process.env.GITHUB_EVENT_PATH;
      if (!message && eventPath && fs.existsSync(eventPath)) {
        const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
        if (ev.pull_request) {
          const title = ev.pull_request.title || "";
          const body = ev.pull_request.body || "";
          message = `${title}\n\n${body}`.trim();
          labels = (ev.pull_request.labels || []).map(
            (l) => (l && (l.name || l)) ? String(l.name || l).toLowerCase() : ""
          ).filter(Boolean);
        } else if (ev.head_commit && ev.head_commit.message) {
          message = ev.head_commit.message;
        } else if (ev.commits && ev.commits.length) {
          message = ev.commits[ev.commits.length - 1].message || "";
        }
      }
    } catch (e) {
      core.warning(`Could not read GITHUB_EVENT_PATH: ${e.message}`);
    }

    // 2) If no directives were found in PR text, try the latest commit message
    const hasDirective = (txt) =>
      /\b(only|skip|targets|include|exclude|mode)\s*=/.test(txt || "");
    if (!hasDirective(message)) {
      try {
        // Requires the repo to be checked out before running this action
        const gitMsg = execSync("git log -1 --pretty=%B", {
          cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        }).trim();
        if (hasDirective(gitMsg)) {
          message = `${message ? message + "\n\n---\n" : ""}${gitMsg}`;
          core.info("Planner: directives found in latest commit message (fallback).");
        }
      } catch {
        // No checkout or git unavailable; ignore
      }
    }

    // 3) Compute plan
    const plan = computePlan({
      config,
      message,
      labels,
      inputs: { modeInput: core.getInput("mode-input") },
    });

    // 4) Emit outputs
    core.setOutput("mode", plan.mode);
    core.setOutput("only_jobs", plan.onlyJobs);
    core.setOutput("skip_jobs", plan.skipJobs);
    core.setOutput("targets_json", plan.targetsJson);
    core.setOutput("targets_list", plan.targetsList);

    // 5) Handy summary
    core.info("---- planner summary ----");
    core.info(`MODE: ${plan.mode}`);
    core.info(`ENABLED_JOBS: ${plan.enabledJobs.join(" ")}`);
    core.info(`ONLY_JOBS: ${plan.onlyJobs || "<empty>"}`);
    core.info(`SKIP_JOBS: ${plan.skipJobs || "<empty>"}`);
    core.info(`TARGETS_LIST: ${plan.targetsList}`);
    core.info(`TARGETS_JSON: ${plan.targetsJson}`);
    core.info("-------------------------");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

module.exports = { computePlan, parseDirectives, normalizeList, lowerUnique };
