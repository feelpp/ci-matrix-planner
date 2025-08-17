const fs = require("fs");
const { computePlan } = require("../index.js");

function fail(msg) {
  console.error("TEST FAILED:", msg);
  process.exit(1);
}

const cases = JSON.parse(fs.readFileSync(__dirname + "/cases.json", "utf8"));
let failures = 0;

for (const c of cases) {
  const plan = computePlan({
    config: c.config || {},
    message: c.message || "",
    labels: c.labels || [],
    inputs: {}
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
    if (c.expected.targetsList) {
      if (plan.targetsList !== c.expected.targetsList) {
        throw new Error(`targetsList mismatch: got "${plan.targetsList}" want "${c.expected.targetsList}"`);
      }
    }
    console.log(`OK: ${c.name}`);
  } catch (e) {
    console.error(`FAIL: ${c.name} -> ${e.message}`);
    failures++;
  }
}

if (failures) fail(`${failures} failing test(s)`);
console.log("All tests passed.");
