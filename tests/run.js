const fs = require("fs");
const os = require("os");
const path = require("path");
const { computePlan, extractContextFromPayload, run } = require("../index.js");

function fail(msg) {
  console.error("TEST FAILED:", msg);
  process.exit(1);
}

const cases = JSON.parse(fs.readFileSync(__dirname + "/cases.json", "utf8"));
const harvestCases = JSON.parse(fs.readFileSync(__dirname + "/harvest-cases.json", "utf8"));
const actionCases = JSON.parse(fs.readFileSync(__dirname + "/action-cases.json", "utf8"));
let failures = 0;

for (const c of cases) {
  const plan = computePlan({
    config: c.config || {},
    message: c.message || "",
    labels: c.labels || [],
    inputs: {},
    profile: c.profile || "",
    context: c.context || {}
  });

  try {
    if (c.expected.mode && plan.mode !== c.expected.mode) {
      throw new Error(`mode mismatch: got ${plan.mode}, want ${c.expected.mode}`);
    }
    if (c.expected.enabledJobs) {
      const got = plan.enabledJobs.join(",");
      const want = c.expected.enabledJobs.join(",");
      if (got !== want) {
        throw new Error(`enabledJobs mismatch: got [${got}] want [${want}]`);
      }
    }
    if (c.expected.enabledJobsJson) {
      const got = JSON.parse(plan.enabledJobsJson);
      const want = c.expected.enabledJobsJson;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`enabledJobsJson mismatch: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
    if (c.expected.notEnabledJobs) {
      for (const name of c.expected.notEnabledJobs) {
        if (JSON.parse(plan.enabledJobsJson).includes(name)) {
          throw new Error(`enabledJobsJson unexpectedly includes "${name}"`);
        }
      }
    }
    if (c.expected.targetsList) {
      if (plan.targetsList !== c.expected.targetsList) {
        throw new Error(`targetsList mismatch: got "${plan.targetsList}" want "${c.expected.targetsList}"`);
      }
    }
    if (c.expected.enabledProfiles) {
      const got = JSON.parse(plan.enabledProfilesJson);
      const want = c.expected.enabledProfiles;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`enabledProfiles mismatch: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
    if (c.expected.profile && plan.profile !== c.expected.profile) {
      throw new Error(`profile mismatch: got ${plan.profile} want ${c.expected.profile}`);
    }
    if (c.expected.pkgEnabled !== undefined) {
      if (plan.pkgEnabled !== c.expected.pkgEnabled) {
        throw new Error(`pkgEnabled mismatch: got ${plan.pkgEnabled} want ${c.expected.pkgEnabled}`);
      }
    }
    if (c.expected.matrixIncludeLen !== undefined) {
      const matrix = JSON.parse(plan.matrixJson || "{}");
      const include = matrix.include || [];
      if (include.length !== c.expected.matrixIncludeLen) {
        throw new Error(`matrixIncludeLen mismatch: got ${include.length} want ${c.expected.matrixIncludeLen}`);
      }
    }
    if (c.expected.pkgTargets) {
      const got = JSON.parse(plan.pkgTargetsJson);
      const want = c.expected.pkgTargets;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`pkgTargets mismatch: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
    if (c.expected.pkgMatrixIncludeLen !== undefined) {
      const matrix = JSON.parse(plan.pkgMatrixJson || "{}");
      const include = matrix.include || [];
      if (include.length !== c.expected.pkgMatrixIncludeLen) {
        throw new Error(`pkgMatrixIncludeLen mismatch: got ${include.length} want ${c.expected.pkgMatrixIncludeLen}`);
      }
    }
    console.log(`OK: ${c.name}`);
  } catch (e) {
    console.error(`FAIL: ${c.name} -> ${e.message}`);
    failures++;
  }
}

for (const c of harvestCases) {
  const ctx = extractContextFromPayload(c.payload || {}, c.explicitInputs || {});

  try {
    if (Object.prototype.hasOwnProperty.call(c.expected, "source") && ctx.source !== c.expected.source) {
      throw new Error(`source mismatch: got ${ctx.source}, want ${c.expected.source}`);
    }
    if (Object.prototype.hasOwnProperty.call(c.expected, "message") && ctx.message !== c.expected.message) {
      throw new Error(`message mismatch: got ${JSON.stringify(ctx.message)} want ${JSON.stringify(c.expected.message)}`);
    }
    if (Object.prototype.hasOwnProperty.call(c.expected, "modeInput") && ctx.modeInput !== c.expected.modeInput) {
      throw new Error(`modeInput mismatch: got ${ctx.modeInput}, want ${c.expected.modeInput}`);
    }
    if (c.expected.labels) {
      const got = ctx.labels.join(",");
      const want = c.expected.labels.join(",");
      if (got !== want) {
        throw new Error(`labels mismatch: got [${got}] want [${want}]`);
      }
    }
    console.log(`OK: ${c.name}`);
  } catch (e) {
    console.error(`FAIL: ${c.name} -> ${e.message}`);
    failures++;
  }
}

async function runActionCase(c) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-matrix-planner-"));
  try {
    const configPath = path.join(tmpDir, "plan-ci.json");
    const eventPath = path.join(tmpDir, "event.json");
    fs.writeFileSync(configPath, JSON.stringify(c.config || {}, null, 2));
    fs.writeFileSync(eventPath, JSON.stringify(c.payload || {}, null, 2));

    const outputs = {};
    const warnings = [];
    let failedMessage = "";
    const inputs = Object.assign({ "config-path": "plan-ci.json" }, c.inputs || {});
    const envMap = Object.assign({
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "feelpp/ci-matrix-planner",
      GITHUB_REF_NAME: "",
      GITHUB_SHA: "",
      GITHUB_WORKSPACE: tmpDir,
    }, c.env || {});

    await run({
      cwd: tmpDir,
      env: (key, fallback = "") => (Object.prototype.hasOwnProperty.call(envMap, key) ? envMap[key] : fallback),
      core: {
        getInput(name) {
          return Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : "";
        },
        setOutput(name, value) {
          outputs[name] = String(value);
        },
        warning(message) {
          warnings.push(String(message));
        },
        info() {},
        startGroup() {},
        endGroup() {},
        setFailed(message) {
          failedMessage = String(message);
        },
      },
    });

    if (failedMessage) {
      throw new Error(`setFailed called: ${failedMessage}`);
    }

    if (c.expected.profile && outputs.profile !== c.expected.profile) {
      throw new Error(`profile mismatch: got ${outputs.profile} want ${c.expected.profile}`);
    }
    if (c.expected.mode && outputs.mode !== c.expected.mode) {
      throw new Error(`mode mismatch: got ${outputs.mode} want ${c.expected.mode}`);
    }
    if (c.expected.directiveSource && outputs.directive_source !== c.expected.directiveSource) {
      throw new Error(`directive_source mismatch: got ${outputs.directive_source} want ${c.expected.directiveSource}`);
    }
    if (c.expected.enabledJobsJson) {
      const got = JSON.parse(outputs.enabled_jobs_json || "[]");
      const want = c.expected.enabledJobsJson;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`enabled_jobs_json mismatch: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
    if (c.expected.targetsJson) {
      const got = JSON.parse(outputs.targets_json || "[]");
      const want = c.expected.targetsJson;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`targets_json mismatch: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
    if (c.expected.matrixIncludeLen !== undefined) {
      const matrix = JSON.parse(outputs.matrix_json || "{}");
      const include = matrix.include || [];
      if (include.length !== c.expected.matrixIncludeLen) {
        throw new Error(`matrixIncludeLen mismatch: got ${include.length} want ${c.expected.matrixIncludeLen}`);
      }
    }
    if (c.expected.warningCount !== undefined && warnings.length !== c.expected.warningCount) {
      throw new Error(`warning count mismatch: got ${warnings.length} want ${c.expected.warningCount}`);
    }
    console.log(`OK: ${c.name}`);
  } catch (e) {
    console.error(`FAIL: ${c.name} -> ${e.message}`);
    failures++;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

(async () => {
  for (const c of actionCases) {
    await runActionCase(c);
  }

  if (failures) fail(`${failures} failing test(s)`);
  console.log("All tests passed.");
})().catch((err) => fail(err instanceof Error ? err.message : String(err)));
