// index.js
var fs = require("fs");
var path = require("path");
var https = require("https");
var { execSync } = require("child_process");
function env(name, def = "") {
  return process.env[name] || def;
}
function httpGetJson(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "ci-matrix-planner",
          Accept: "application/vnd.github+json",
          ...token ? { Authorization: `Bearer ${token}` } : {}
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => data += c);
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
  return String(raw).split(/[, \t\r\n]+/).map((s) => s.trim()).filter(Boolean);
}
function lowerUnique(list) {
  const seen = /* @__PURE__ */ new Set();
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
  const cfg = opts.config || {};
  const message = (opts.message || "").trim();
  const labels = lowerUnique(opts.labels || []);
  const directives = parseDirectives(message);
  let mode = opts.inputs && opts.inputs.modeInput || directives.mode || cfg.defaults?.mode || "components";
  mode = String(mode).toLowerCase();
  const jobsCfg = cfg.jobs || ["feelpp", "testsuite", "toolboxes", "mor", "python"];
  const defaultJobs = cfg.defaults?.jobs || jobsCfg;
  const targetsCfg = cfg.targets || ["ubuntu:24.04", "ubuntu:22.04", "debian:13", "debian:12", "fedora:42"];
  const defaultTargets = cfg.defaults?.targets || targetsCfg;
  if (labels.includes("ci-mode-full")) mode = "full";
  if (labels.includes("ci-mode-components")) mode = "components";
  let enabledJobs;
  if (mode === "full") {
    const fullJob = cfg.fullBuild && cfg.fullBuild.job || "feelpp-spack";
    enabledJobs = [fullJob];
  } else {
    enabledJobs = [...defaultJobs];
  }
  const onlyJobsList = lowerUnique(normalizeList(directives.only || (cfg.defaults?.onlyJobs || []).join(" ")));
  const skipJobsList = lowerUnique(normalizeList(directives.skip || (cfg.defaults?.skipJobs || []).join(" ")));
  if (onlyJobsList.length) {
    enabledJobs = enabledJobs.filter((j) => onlyJobsList.includes(j.toLowerCase()));
  }
  if (skipJobsList.length) {
    enabledJobs = enabledJobs.filter((j) => !skipJobsList.includes(j.toLowerCase()));
  }
  let workingTargets = [...defaultTargets];
  if (directives.only && /:/.test(directives.only)) {
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
    onlyJobs: onlyJobsList.join(" "),
    skipJobs: skipJobsList.join(" "),
    targetsList: workingTargets.join(" "),
    targetsCsv: workingTargets.join(","),
    // NEW: CSV for logging/diagnostics
    targetsJson: JSON.stringify(workingTargets),
    // JSON for matrix
    debug: {
      directives,
      labels,
      workingTargets
    },
    rawMessage: message
  };
}
if (require.main === module) {
  const core = {
    getInput(name) {
      return process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "";
    },
    setOutput(name, value) {
      const delim = `EOF_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      process.stdout.write(`${name}<<${delim}
${value}
${delim}
`);
    },
    info: console.log,
    warn: console.warn
  };
  (async () => {
    try {
      const configPath = core.getInput("config-path") || ".github/plan-ci.json";
      let config = {};
      try {
        const cfgText = fs.readFileSync(path.resolve(process.cwd(), configPath), "utf8");
        config = JSON.parse(cfgText);
      } catch (e) {
        core.warn(`No config found at ${configPath}, using defaults. (${e.message})`);
      }
      const token = core.getInput("github-token") || env("GITHUB_TOKEN") || env("GH_TOKEN") || "";
      const repo = env("GITHUB_REPOSITORY");
      const [owner, repoName] = repo ? repo.split("/") : ["", ""];
      const eventPath = env("GITHUB_EVENT_PATH");
      const sha = env("GITHUB_SHA");
      let message = core.getInput("message-override") || "";
      let labels = normalizeList(core.getInput("labels-override"));
      if (!message && eventPath && fs.existsSync(eventPath)) {
        try {
          const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
          if (ev.pull_request) {
            const title = ev.pull_request.title || "";
            const body = ev.pull_request.body || "";
            message = `${title}

${body}`.trim();
            labels = (ev.pull_request.labels || []).map((l) => l && (l.name || l) ? String(l.name || l).toLowerCase() : "").filter(Boolean);
          } else if (ev.head_commit && ev.head_commit.message) {
            message = ev.head_commit.message;
          } else if (ev.commits && ev.commits.length) {
            message = ev.commits[ev.commits.length - 1].message || "";
          }
        } catch (e) {
          core.warn(`Could not parse GITHUB_EVENT_PATH: ${e.message}`);
        }
      }
      const hasDirective = (txt) => /\b(only|skip|targets|include|exclude|mode)\s*=/.test(txt || "");
      if (!hasDirective(message) && token && owner && repoName && eventPath && fs.existsSync(eventPath)) {
        try {
          const ev = JSON.parse(fs.readFileSync(eventPath, "utf8"));
          if (ev.pull_request) {
            const prNumber = ev.pull_request.number;
            if (prNumber) {
              const commits = await httpGetJson(
                `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}/commits`,
                token
              );
              if (Array.isArray(commits) && commits.length) {
                const last = commits[commits.length - 1];
                const cm = last?.commit?.message || "";
                if (hasDirective(cm)) {
                  message = `${message ? message + "\n\n---\n" : ""}${cm}`;
                  core.info("Planner: directives found in PR head commit via API.");
                }
              }
            }
          } else if (sha) {
            const commit = await httpGetJson(
              `https://api.github.com/repos/${owner}/${repoName}/commits/${sha}`,
              token
            );
            const cm = commit?.commit?.message || "";
            if (hasDirective(cm)) {
              message = cm;
              core.info("Planner: directives found in push head commit via API.");
            }
          }
        } catch (e) {
          core.warn(`Could not fetch commit message via GitHub API: ${e.message}`);
        }
      }
      if (!hasDirective(message)) {
        try {
          const gitMsg = execSync("git log -1 --pretty=%B", {
            cwd: env("GITHUB_WORKSPACE") || process.cwd(),
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8"
          }).trim();
          if (hasDirective(gitMsg)) {
            message = `${message ? message + "\n\n---\n" : ""}${gitMsg}`;
            core.info("Planner: directives found in latest commit via git log.");
          }
        } catch {
        }
      }
      const plan = computePlan({
        config,
        message,
        labels,
        inputs: { modeInput: core.getInput("mode-input") }
      });
      core.setOutput("mode", plan.mode);
      core.setOutput("only_jobs", plan.onlyJobs);
      core.setOutput("skip_jobs", plan.skipJobs);
      core.setOutput("targets_json", plan.targetsJson);
      core.setOutput("targets_list", plan.targetsList);
      core.setOutput("targets_csv", plan.targetsCsv);
      core.setOutput("enabled_jobs", plan.enabledJobs.join(" "));
      core.setOutput("raw_message", plan.rawMessage);
      core.setOutput("raw_directives", JSON.stringify(plan.debug.directives));
      core.setOutput("targets_debug", JSON.stringify(plan.debug.workingTargets));
      core.setOutput("targets_len", String(plan.debug.workingTargets.length));
      console.log("---- planner summary ----");
      console.log(`MODE: ${plan.mode}`);
      console.log(`ENABLED_JOBS: ${plan.enabledJobs.join(" ")}`);
      console.log(`ONLY_JOBS: ${plan.onlyJobs || "<empty>"}`);
      console.log(`SKIP_JOBS: ${plan.skipJobs || "<empty>"}`);
      console.log(`TARGETS_LIST: ${plan.targetsList}`);
      console.log(`TARGETS_JSON: ${plan.targetsJson}`);
      console.log("-------------------------");
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}
module.exports = { computePlan, parseDirectives, normalizeList, lowerUnique };
