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
const SUPPORTED_CI_MODES = new Set(["components", "full"]);
const DEFAULT_JOBS = ["feelpp", "testsuite", "toolboxes", "mor"];
const DEFAULT_TARGETS = ["ubuntu:24.04", "ubuntu:22.04", "debian:13", "debian:12", "fedora:42"];
const DEFAULT_PROFILE = "ci";
const PACKAGING_PROFILE = "packaging";
const PACKAGING_MODE = "packaging";
const DEFAULT_PKG_JOB = "packaging";

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
  /^\s*[A-Za-z_][A-Za-z0-9_-]*\s*=/m.test(txt || "");

// split list on commas and/or whitespace; trim; drop empties
function normalizeList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueList(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const value = String(item);
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

// accept only simple key=value lines (ignore bullets, Markdown, etc.)
function parseDirectives(msg) {
  const out = {};
  const mergeKeys = new Set([
    "only",
    "skip",
    "targets",
    "include",
    "exclude",
    "pkg",
    "pkg-targets",
    "pkg-include",
    "pkg-exclude",
  ]);
  if (!msg) return out;
  for (const ln of String(msg).split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (mergeKeys.has(key) && out[key]) {
      out[key] = `${out[key]} ${value}`;
    } else {
      out[key] = value;
    }
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

function listToJson(list) {
  return JSON.stringify(list || []);
}

function readEventPayload(eventPath) {
  if (!eventPath || !fs.existsSync(eventPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch {
    return {};
  }
}

function extractLabelsFromPayload(payload) {
  const sources = [
    payload?.pull_request?.labels,
    payload?.issue?.labels,
    payload?.labels,
  ];
  for (const labels of sources) {
    if (Array.isArray(labels)) {
      return lowerUnique(labels.map((item) =>
        typeof item === "string" ? item : item?.name
      ).filter(Boolean));
    }
  }
  return [];
}

function extractDispatchOverridesFromPayload(payload) {
  const inputs = payload?.inputs || {};
  return {
    modeInput: String(inputs.mode_input || inputs.mode || "").trim(),
    messageOverride: String(inputs.message_override || inputs.message || "").trim(),
    labelsOverride: lowerUnique(normalizeList(inputs.labels_override || inputs.labels || "")),
  };
}

function extractContextFromPayload(payload, explicitInputs = {}) {
  const dispatch = extractDispatchOverridesFromPayload(payload);
  const explicitLabels = lowerUnique(normalizeList(explicitInputs.labelsOverride || ""));
  const labels = explicitLabels.length
    ? explicitLabels
    : (dispatch.labelsOverride.length ? dispatch.labelsOverride : extractLabelsFromPayload(payload));
  const modeInput = String(explicitInputs.modeInput || dispatch.modeInput || "").trim();
  const explicitMessage = String(explicitInputs.messageOverride || "").trim();
  const prHeadSha = payload?.pull_request?.head?.sha || "";
  const pushHeadSha = payload?.after || payload?.head_commit?.id || "";

  if (hasDirective(explicitMessage)) {
    return {
      labels,
      modeInput,
      message: explicitMessage,
      source: "override",
      prHeadSha,
      pushHeadSha,
    };
  }

  if (hasDirective(dispatch.messageOverride)) {
    return {
      labels,
      modeInput,
      message: dispatch.messageOverride,
      source: "workflow-dispatch-input",
      prHeadSha,
      pushHeadSha,
    };
  }

  const prTitleBody = [payload?.pull_request?.title, payload?.pull_request?.body]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (hasDirective(prTitleBody)) {
    return {
      labels,
      modeInput,
      message: prTitleBody,
      source: "pr-title-body",
      prHeadSha,
      pushHeadSha,
    };
  }

  const pushMessage = String(payload?.head_commit?.message || "").trim();
  if (hasDirective(pushMessage)) {
    return {
      labels,
      modeInput,
      message: pushMessage,
      source: "push-head-commit-payload",
      prHeadSha,
      pushHeadSha,
    };
  }

  return {
    labels,
    modeInput,
    message: "",
    source: "payload-none",
    prHeadSha,
    pushHeadSha,
  };
}

function filterKnownTokens(tokens, knownSet) {
  const valid = [];
  const unknown = [];
  for (const token of tokens || []) {
    const normalized = String(token).toLowerCase();
    if (knownSet.has(normalized)) valid.push(normalized);
    else unknown.push(normalized);
  }
  return {
    valid: lowerUnique(valid),
    unknown: lowerUnique(unknown),
  };
}

function globToRegExp(pattern) {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === "*" && next === "*") {
      regex += ".*";
      i++;
      continue;
    }
    if (ch === "*") {
      regex += "[^/]*";
      continue;
    }
    regex += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex);
}

function matchesAnyPattern(file, patterns) {
  return (patterns || []).some((pattern) => globToRegExp(String(pattern)).test(file));
}

function normalizeRuleProfiles(rule) {
  return lowerUnique(
    []
      .concat(rule?.enableProfiles || [])
      .concat(rule?.profiles || [])
      .concat(rule?.profile || [])
      .filter(Boolean)
  );
}

function resolveRuleTargets(rule, profile) {
  if (Array.isArray(rule?.targets)) return rule.targets;
  if (Array.isArray(rule?.defaultTargets)) return rule.defaultTargets;
  if (Array.isArray(rule?.targetsByProfile?.[profile])) return rule.targetsByProfile[profile];
  if (Array.isArray(rule?.defaultTargets?.[profile])) return rule.defaultTargets[profile];
  return [];
}

function collectRuleDefaultTargets(pathRules, changedFiles, profile) {
  const matchedRules = [];
  const targets = [];
  for (const rule of pathRules || []) {
    const ruleProfiles = normalizeRuleProfiles(rule);
    if (ruleProfiles.length && !ruleProfiles.includes(profile)) continue;
    if (!matchesAnyPatternList(changedFiles, rule?.patterns || [])) continue;
    matchedRules.push(rule);
    for (const target of resolveRuleTargets(rule, profile)) {
      targets.push(String(target).toLowerCase());
    }
  }
  return {
    matchedRules,
    targets: lowerUnique(targets),
  };
}

function matchesAnyPatternList(files, patterns) {
  return (files || []).some((file) => matchesAnyPattern(file, patterns));
}

function normalizeCatalog(catalog) {
  const out = {};
  for (const [key, value] of Object.entries(catalog || {})) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function normalizeGroups(groups) {
  const out = {};
  for (const [key, value] of Object.entries(groups || {})) {
    out[String(key).toLowerCase()] = (value || []).map((item) => String(item).toLowerCase());
  }
  return out;
}

function expandGroupTargets(tokens, groups) {
  const out = [];
  for (const token of tokens || []) {
    const normalized = String(token).toLowerCase();
    if (groups[normalized]) {
      out.push(...groups[normalized]);
    } else {
      out.push(normalized);
    }
  }
  return lowerUnique(out);
}

function resolvePlanningConfig(config, requestedProfile, warnings) {
  const profiles = config?.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    if (requestedProfile && String(requestedProfile).toLowerCase() !== DEFAULT_PROFILE) {
      warnings.push(`Profile "${requestedProfile}" requested, but config has no profiles; using legacy root config`);
    }
    return {
      profile: DEFAULT_PROFILE,
      config,
    };
  }

  const profileEntries = Object.entries(profiles);
  const availableProfiles = Object.fromEntries(profileEntries.map(([name, cfg]) => [String(name).toLowerCase(), cfg]));
  const availableNames = Object.keys(availableProfiles);
  const defaultProfileCandidate = String(config.defaultProfile || (availableProfiles[DEFAULT_PROFILE] ? DEFAULT_PROFILE : availableNames[0] || DEFAULT_PROFILE)).toLowerCase();
  const fallbackProfile = availableProfiles[defaultProfileCandidate] ? defaultProfileCandidate : (availableProfiles[DEFAULT_PROFILE] ? DEFAULT_PROFILE : availableNames[0] || DEFAULT_PROFILE);
  const requested = String(requestedProfile || defaultProfileCandidate || fallbackProfile).toLowerCase();
  const resolvedProfile = availableProfiles[requested] ? requested : fallbackProfile;
  if (!availableProfiles[requested] && requestedProfile) {
    warnings.push(`Unknown profile "${requestedProfile}", falling back to "${resolvedProfile}"`);
  }
  const profileConfig = availableProfiles[resolvedProfile] || {};
  return {
    profile: resolvedProfile,
    config: {
      ...profileConfig,
      pathRules: [].concat(config.pathRules || []).concat(profileConfig.pathRules || []),
    },
  };
}

function buildMatrixForTargets(targets, catalog, warnings) {
  if (!Object.keys(catalog || {}).length) {
    return {
      matrix: { target: targets },
      matrixRows: targets.map((target) => ({ target })),
    };
  }

  const include = [];
  for (const target of targets) {
    const row = catalog[target];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      warnings.push(`Catalog entry missing or invalid for target "${target}"`);
      continue;
    }
    include.push({
      target,
      ...row,
    });
  }
  return {
    matrix: { include },
    matrixRows: include,
  };
}

function getRefName(payload) {
  const refName = payload?.ref ? String(payload.ref).split("/").pop() : "";
  return (payload?.ref_name || refName || "").trim();
}

function getPackagingProfileConfig(config) {
  return config?.profiles?.[PACKAGING_PROFILE] || {};
}

function getPackagingConfig(config, activeProfile, activeConfig) {
  const rootCfg = config?.packaging || {};
  const profileCfg = activeProfile === PACKAGING_PROFILE
    ? (activeConfig || {})
    : getPackagingProfileConfig(config);
  return {
    jobs: profileCfg.jobs || rootCfg.jobs || [DEFAULT_PKG_JOB],
    defaults: profileCfg.defaults || rootCfg.defaults || {},
    defaultTargets: profileCfg.defaultTargets || rootCfg.defaultTargets || [],
    catalog: profileCfg.catalog || rootCfg.catalog || {},
    groups: profileCfg.groups || rootCfg.groups || {},
    defaultOnBranches: profileCfg.defaultOnBranches || rootCfg.defaultOnBranches || [],
  };
}

function getPackagingDefaultTargets(packagingConfig) {
  return lowerUnique(
    []
      .concat(packagingConfig?.defaults?.targets || [])
      .concat(packagingConfig?.defaultTargets || [])
      .filter(Boolean)
      .map((item) => String(item).toLowerCase())
  );
}

function getCatalogProfileConfig(activeConfig, activeProfile) {
  return {
    jobs: activeConfig?.jobs || [String(activeProfile).toLowerCase()],
    defaults: activeConfig?.defaults || {},
    defaultTargets: activeConfig?.defaultTargets || [],
    catalog: activeConfig?.catalog || {},
    groups: activeConfig?.groups || {},
  };
}

function getCatalogDefaultTargets(profileConfig) {
  return lowerUnique(
    []
      .concat(profileConfig?.defaults?.targets || [])
      .concat(profileConfig?.defaultTargets || [])
      .filter(Boolean)
      .map((item) => String(item).toLowerCase())
  );
}

function getCatalogKnownTargetSet(defaultTargets, catalog, groups) {
  return new Set(lowerUnique(
    []
      .concat(defaultTargets || [])
      .concat(Object.keys(catalog || {}))
      .concat(Object.keys(groups || {}))
      .concat(Object.values(groups || {}).flatMap((items) => items || []))
      .filter(Boolean)
      .map((item) => String(item).toLowerCase())
  ));
}

function expandCatalogTokens(tokens, { defaultTargets, catalog, groups }) {
  const normalized = lowerUnique(tokens || []);
  const catalogTargets = Object.keys(catalog || {}).map((item) => String(item).toLowerCase());
  const explicitNoneOnly = normalized.length > 0 && normalized.every((token) => token === "none");
  const out = [];

  for (const token of normalized) {
    if (token === "none") continue;
    if (token === "default") {
      out.push(...defaultTargets);
      continue;
    }
    if (token === "all") {
      out.push(...(catalogTargets.length ? catalogTargets : defaultTargets));
      continue;
    }
    if (groups[token]) {
      out.push(...groups[token]);
      continue;
    }
    out.push(token);
  }

  return {
    explicitNoneOnly,
    targets: lowerUnique(out),
  };
}

function normalizeCatalogTargets(rawTargets, sourceName, knownTargetSet, warnings) {
  if (!knownTargetSet.size) {
    return lowerUnique(rawTargets || []);
  }
  const { valid, unknown } = filterKnownTokens(rawTargets, knownTargetSet);
  if (unknown.length) {
    warnings.push(`Unknown targets in ${sourceName}: ${unknown.join(", ")}`);
  }
  return valid;
}

function selectCatalogTargets({ directives, catalogProfileConfig, warnings }) {
  const defaultTargets = getCatalogDefaultTargets(catalogProfileConfig);
  const catalog = normalizeCatalog(catalogProfileConfig.catalog || {});
  const groups = normalizeGroups(catalogProfileConfig.groups || {});
  const knownTargetSet = getCatalogKnownTargetSet(defaultTargets, catalog, groups);

  const baseRaw = normalizeList(directives.targets || "");
  const includeRaw = normalizeList(directives.include || "");
  const excludeRaw = normalizeList(directives.exclude || "");

  const baseExpanded = expandCatalogTokens(baseRaw, { defaultTargets, catalog, groups });
  const includeExpanded = expandCatalogTokens(includeRaw, { defaultTargets, catalog, groups });
  const excludeExpanded = expandCatalogTokens(excludeRaw, { defaultTargets, catalog, groups });

  let targets = baseRaw.length
    ? (baseExpanded.explicitNoneOnly
      ? []
      : normalizeCatalogTargets(baseExpanded.targets, "targets=", knownTargetSet, warnings))
    : defaultTargets.slice();

  if (includeRaw.length) {
    targets = lowerUnique(targets.concat(
      normalizeCatalogTargets(includeExpanded.targets, "include=", knownTargetSet, warnings)
    ));
  }

  if (excludeRaw.length) {
    const excludeSet = new Set(
      normalizeCatalogTargets(excludeExpanded.targets, "exclude=", knownTargetSet, warnings)
    );
    targets = targets.filter((target) => !excludeSet.has(target));
  }

  return {
    catalog,
    defaultTargets,
    workingTargets: lowerUnique(targets),
  };
}

function getPackagingKnownTargetSet(defaultTargets, catalog, groups) {
  return new Set(lowerUnique(
    []
      .concat(defaultTargets || [])
      .concat(Object.keys(catalog || {}))
      .concat(Object.values(groups || {}).flatMap((items) => items || []))
      .filter(Boolean)
      .map((item) => String(item).toLowerCase())
  ));
}

function expandPackagingTokens(tokens, { defaultTargets, catalog, groups }) {
  const normalized = lowerUnique(tokens || []);
  const catalogTargets = Object.keys(catalog || {}).map((item) => String(item).toLowerCase());
  const explicitNoneOnly = normalized.length > 0 && normalized.every((token) => token === "none");
  const out = [];

  for (const token of normalized) {
    if (token === "none") continue;
    if (token === "default") {
      out.push(...defaultTargets);
      continue;
    }
    if (token === "all") {
      out.push(...(catalogTargets.length ? catalogTargets : defaultTargets));
      continue;
    }
    if (groups[token]) {
      out.push(...groups[token]);
      continue;
    }
    out.push(token);
  }

  return {
    explicitNoneOnly,
    targets: lowerUnique(out),
  };
}

function normalizePackagingTargets(rawTargets, sourceName, knownTargetSet, warnings) {
  if (!knownTargetSet.size) {
    return lowerUnique(rawTargets || []);
  }
  const { valid, unknown } = filterKnownTokens(rawTargets, knownTargetSet);
  if (unknown.length) {
    warnings.push(`Unknown packaging targets in ${sourceName}: ${unknown.join(", ")}`);
  }
  return valid;
}

function selectPackagingTargets({ directives, packagingConfig, warnings, useDefaults }) {
  const defaultTargets = getPackagingDefaultTargets(packagingConfig);
  const catalog = normalizeCatalog(packagingConfig.catalog || {});
  const groups = normalizeGroups(packagingConfig.groups || {});
  const knownTargetSet = getPackagingKnownTargetSet(defaultTargets, catalog, groups);

  const baseRaw = normalizeList(directives.pkg || directives["pkg-targets"] || "");
  const includeRaw = normalizeList(directives["pkg-include"] || "");
  const excludeRaw = normalizeList(directives["pkg-exclude"] || "");
  const baseSource = directives.pkg ? "pkg=" : "pkg-targets=";

  const baseExpanded = expandPackagingTokens(baseRaw, { defaultTargets, catalog, groups });
  const includeExpanded = expandPackagingTokens(includeRaw, { defaultTargets, catalog, groups });
  const excludeExpanded = expandPackagingTokens(excludeRaw, { defaultTargets, catalog, groups });

  let targets = [];
  if (baseRaw.length) {
    targets = baseExpanded.explicitNoneOnly
      ? []
      : normalizePackagingTargets(baseExpanded.targets, baseSource, knownTargetSet, warnings);
  } else if (useDefaults) {
    targets = defaultTargets.slice();
  }

  if (includeRaw.length) {
    targets = lowerUnique(targets.concat(
      normalizePackagingTargets(includeExpanded.targets, "pkg-include=", knownTargetSet, warnings)
    ));
  }

  if (excludeRaw.length) {
    const excludeSet = new Set(
      normalizePackagingTargets(excludeExpanded.targets, "pkg-exclude=", knownTargetSet, warnings)
    );
    targets = targets.filter((target) => !excludeSet.has(target));
  }

  return {
    catalog,
    defaultTargets,
    hasPkgDirectives: !!(baseRaw.length || includeRaw.length || excludeRaw.length),
    pkgTargets: lowerUnique(targets),
  };
}

function computePackagingOutputs({ cfg, activeProfile, activeConfig, directives, context, warnings, forcePackagingProfile = false }) {
  const packagingConfig = getPackagingConfig(cfg, activeProfile, activeConfig);
  const refName = String(context.refName || "").toLowerCase();
  const branchDefaults = lowerUnique((packagingConfig.defaultOnBranches || []).map((item) => String(item).toLowerCase()));
  const branchDefaultEnabled = !forcePackagingProfile && activeProfile === DEFAULT_PROFILE && branchDefaults.includes(refName);
  const packagingRequested = forcePackagingProfile || branchDefaultEnabled;

  const selection = selectPackagingTargets({
    directives,
    packagingConfig,
    warnings,
    useDefaults: packagingRequested,
  });
  const pkgRequested = selection.hasPkgDirectives || packagingRequested;
  const pkgTargets = selection.pkgTargets;
  if (pkgRequested && !pkgTargets.length) {
    warnings.push("No packaging targets selected");
  }

  const { matrix: pkgMatrix, matrixRows: pkgMatrixRows } = buildMatrixForTargets(
    pkgTargets,
    selection.catalog,
    warnings
  );

  return {
    packagingConfig,
    pkgEnabled: pkgTargets.length > 0,
    pkgRequested,
    pkgTargets,
    pkgMatrix,
    pkgMatrixRows,
  };
}

function computePackagingProfilePlan({ cfg, activeConfig, activeProfile, directives, context, message, labels, warnings }) {
  const packagingOutputs = computePackagingOutputs({
    cfg,
    activeProfile,
    activeConfig,
    directives,
    context,
    warnings,
    forcePackagingProfile: true,
  });
  const configuredJobs = Array.isArray(packagingOutputs.packagingConfig.jobs)
    ? packagingOutputs.packagingConfig.jobs.filter(Boolean)
    : [];
  const enabledJobs = configuredJobs.length ? configuredJobs : [DEFAULT_PKG_JOB];
  const enabledProfiles = [activeProfile];

  return {
    mode: PACKAGING_MODE,
    enabledJobs,
    enabledJobsJson: listToJson(enabledJobs),
    onlyJobs: "",
    onlyJobsJson: listToJson([]),
    skipJobs: "",
    skipJobsJson: listToJson([]),
    targetsList: packagingOutputs.pkgTargets.join(" "),
    targetsJson: listToJson(packagingOutputs.pkgTargets),
    matrixJson: JSON.stringify(packagingOutputs.pkgMatrix),
    rawMessage: message,
    warnings,
    warningsJson: listToJson(warnings),
    profile: activeProfile,
    enabledProfiles,
    enabledProfilesJson: listToJson(enabledProfiles),
    pkgEnabled: packagingOutputs.pkgEnabled,
    pkgTargets: packagingOutputs.pkgTargets,
    pkgTargetsJson: listToJson(packagingOutputs.pkgTargets),
    pkgMatrixJson: JSON.stringify(packagingOutputs.pkgMatrix),
    pkgMatrixRowsJson: JSON.stringify(packagingOutputs.pkgMatrixRows),
    debug: {
      directives,
      labels,
      pkgTargets: packagingOutputs.pkgTargets,
      packagingJobs: enabledJobs,
    },
  };
}

function computeCatalogProfilePlan({ activeConfig, activeProfile, directives, message, labels, warnings }) {
  const catalogProfileConfig = getCatalogProfileConfig(activeConfig, activeProfile);
  const configuredJobs = Array.isArray(catalogProfileConfig.jobs)
    ? catalogProfileConfig.jobs.filter(Boolean)
    : [];
  const defaultJobs = configuredJobs.length ? configuredJobs : [String(activeProfile).toLowerCase()];
  const knownJobSet = new Set(lowerUnique(defaultJobs));
  const defaultOnlyJobsRaw = normalizeList((catalogProfileConfig.defaults?.onlyJobs || []).join(" "))
    .filter((item) => !item.includes(":"));
  const defaultSkipJobsRaw = normalizeList((catalogProfileConfig.defaults?.skipJobs || []).join(" "))
    .filter((item) => !item.includes(":"));
  const directiveOnlyJobsRaw = normalizeList(directives.only || "").filter((item) => !item.includes(":"));
  const directiveSkipJobsRaw = normalizeList(directives.skip || "").filter((item) => !item.includes(":"));
  const { valid: onlyJobsList, unknown: unknownOnlyJobs } = filterKnownTokens(
    directiveOnlyJobsRaw.length ? directiveOnlyJobsRaw : defaultOnlyJobsRaw,
    knownJobSet
  );
  const { valid: skipJobsList, unknown: unknownSkipJobs } = filterKnownTokens(
    directiveSkipJobsRaw.length ? directiveSkipJobsRaw : defaultSkipJobsRaw,
    knownJobSet
  );

  if (unknownOnlyJobs.length) {
    warnings.push(`Unknown jobs in only=: ${unknownOnlyJobs.join(", ")}`);
  }
  if (unknownSkipJobs.length) {
    warnings.push(`Unknown jobs in skip=: ${unknownSkipJobs.join(", ")}`);
  }

  let enabledJobs = defaultJobs.slice();
  if (onlyJobsList.length) {
    enabledJobs = enabledJobs.filter((job) => onlyJobsList.includes(String(job).toLowerCase()));
  }
  if (skipJobsList.length) {
    enabledJobs = enabledJobs.filter((job) => !skipJobsList.includes(String(job).toLowerCase()));
  }
  if (!enabledJobs.length) {
    warnings.push("No jobs selected after applying only=/skip= filters");
  }

  const selection = selectCatalogTargets({
    directives,
    catalogProfileConfig,
    warnings,
  });
  if (!selection.workingTargets.length) {
    warnings.push("No targets selected");
  }

  const { matrix, matrixRows } = buildMatrixForTargets(
    selection.workingTargets,
    selection.catalog,
    warnings
  );
  const enabledProfiles = [activeProfile];

  return {
    mode: activeProfile,
    enabledJobs,
    enabledJobsJson: listToJson(enabledJobs),
    onlyJobs: onlyJobsList.join(" "),
    onlyJobsJson: listToJson(onlyJobsList),
    skipJobs: skipJobsList.join(" "),
    skipJobsJson: listToJson(skipJobsList),
    targetsList: selection.workingTargets.join(" "),
    targetsJson: listToJson(selection.workingTargets),
    matrixJson: JSON.stringify(matrix),
    rawMessage: message,
    warnings,
    warningsJson: listToJson(warnings),
    profile: activeProfile,
    enabledProfiles,
    enabledProfilesJson: listToJson(enabledProfiles),
    pkgEnabled: false,
    pkgTargets: [],
    pkgTargetsJson: listToJson([]),
    pkgMatrixJson: JSON.stringify({ target: [] }),
    pkgMatrixRowsJson: listToJson([]),
    debug: {
      directives,
      labels,
      workingTargets: selection.workingTargets,
      catalogMatrixRows: matrixRows,
    },
  };
}

/* =========================
 * Planner core (pure)
 * ========================= */

function computePlan(opts) {
  const cfg = opts.config || {};
  const message = (opts.message || "").trim();
  const labels = lowerUnique(opts.labels || []);
  const directives = parseDirectives(message);
  const warnings = [];
  const context = opts.context || {};
  const requestedProfile = String(opts.profile || "").trim();

  const { profile: activeProfile, config: activeConfig } = resolvePlanningConfig(cfg, requestedProfile, warnings);

  if (activeProfile === PACKAGING_PROFILE) {
    return computePackagingProfilePlan({
      cfg,
      activeConfig,
      activeProfile,
      directives,
      context,
      message,
      labels,
      warnings,
    });
  }

  if (activeProfile !== DEFAULT_PROFILE && activeConfig?.catalog && typeof activeConfig.catalog === "object" && !Array.isArray(activeConfig.catalog)) {
    return computeCatalogProfilePlan({
      activeConfig,
      activeProfile,
      directives,
      message,
      labels,
      warnings,
    });
  }

  // Global job and target pools
  const jobsCfg = activeConfig.jobs || DEFAULT_JOBS;
  const targetsCfg = activeConfig.targets || DEFAULT_TARGETS;

  // Build modes configuration (new unified schema)
  // Supports both old fullBuild.job and new modes.{name}.jobs format
  const modes = activeConfig.modes || {};

  // Build full mode job list from various sources (backwards compatible)
  const getFullModeJobs = () => {
    // 1. New schema: modes.full.jobs (array)
    if (modes.full?.jobs && Array.isArray(modes.full.jobs)) {
      return modes.full.jobs;
    }
    // 2. Old schema: fullBuild.job (string) or fullBuild.jobs (array)
    if (activeConfig.fullBuild) {
      if (Array.isArray(activeConfig.fullBuild.jobs)) return activeConfig.fullBuild.jobs;
      if (activeConfig.fullBuild.job) return [activeConfig.fullBuild.job];
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
    if (activeConfig.fullBuild?.targets && Array.isArray(activeConfig.fullBuild.targets)) {
      return activeConfig.fullBuild.targets;
    }
    // 3. Fall back to default targets
    return null; // will use defaultTargets
  };

  const fullModeJobs = getFullModeJobs();
  const fullModeTargets = getFullModeTargets();

  // Default jobs and targets (components mode)
  const defaultJobs = modes.components?.jobs || activeConfig.defaults?.jobs || jobsCfg;
  const defaultTargets = modes.components?.targets || activeConfig.defaults?.targets || targetsCfg;
  const fallbackModeCandidate = String(activeConfig.defaults?.mode || "components").toLowerCase();
  const fallbackMode = SUPPORTED_CI_MODES.has(fallbackModeCandidate) ? fallbackModeCandidate : "components";
  if (!SUPPORTED_CI_MODES.has(fallbackModeCandidate)) {
    warnings.push(`Unsupported default mode "${fallbackModeCandidate}", falling back to "${fallbackMode}"`);
  }

  // Mode resolution
  // Precedence: modeInput > directives.mode > auto-detect from only= > defaults
  let modeCandidate =
    (opts.inputs && opts.inputs.modeInput) ||
    directives.mode ||
    fallbackMode;
  modeCandidate = String(modeCandidate).toLowerCase();
  let mode = modeCandidate;
  if (!SUPPORTED_CI_MODES.has(modeCandidate)) {
    warnings.push(`Unsupported mode "${modeCandidate}", falling back to "${fallbackMode}"`);
    mode = fallbackMode;
  }

  // Labels can switch mode (optional)
  if (labels.includes("ci-mode-full")) mode = "full";
  if (labels.includes("ci-mode-components")) mode = "components";

  // Auto-detect full mode: if only= contains a full mode job, switch to full mode
  const directiveOnlyTokens = normalizeList(directives.only || "");
  const directiveOnlyJobsRaw = directiveOnlyTokens.filter((item) => !item.includes(":"));
  const directiveOnlyTargetsRaw = directiveOnlyTokens.filter((item) => item.includes(":"));
  if (directiveOnlyJobsRaw.length && !directives.mode) {
    const fullJobsLower = fullModeJobs.map((j) => j.toLowerCase());
    const componentJobsLower = defaultJobs.map((dj) => dj.toLowerCase());
    const hasFullJob = directiveOnlyJobsRaw.some((j) => fullJobsLower.includes(j.toLowerCase()));
    const hasComponentJob = directiveOnlyJobsRaw.some((j) => componentJobsLower.includes(j.toLowerCase()));
    // If only full jobs requested (no component jobs), auto-switch to full mode
    if (hasFullJob && !hasComponentJob) {
      mode = "full";
    }
  }

  // Enabled jobs based on mode
  let enabledJobs = mode === "full" ? [...fullModeJobs] : [...defaultJobs];

  // Build the valid jobs pool for filtering (includes both component and full jobs)
  const allValidJobs = lowerUnique([...jobsCfg, ...fullModeJobs]);
  const knownJobSet = new Set(allValidJobs);
  const knownTargetSet = new Set(lowerUnique([
    ...DEFAULT_TARGETS,
    ...targetsCfg,
    ...defaultTargets,
    ...(fullModeTargets || []),
  ]));

  // only / skip jobs (from directives)
  const defaultOnlyJobsRaw = normalizeList((activeConfig.defaults?.onlyJobs || []).join(" "))
    .filter((item) => !item.includes(":"));
  const defaultSkipJobsRaw = normalizeList((activeConfig.defaults?.skipJobs || []).join(" "))
    .filter((item) => !item.includes(":"));
  const { valid: onlyJobsList, unknown: unknownOnlyJobs } = filterKnownTokens(
    directiveOnlyJobsRaw.length ? directiveOnlyJobsRaw : defaultOnlyJobsRaw,
    knownJobSet
  );
  const { valid: skipJobsList, unknown: unknownSkipJobs } = filterKnownTokens(
    normalizeList(directives.skip || "").filter((item) => !item.includes(":")).length
      ? normalizeList(directives.skip || "").filter((item) => !item.includes(":"))
      : defaultSkipJobsRaw,
    knownJobSet
  );
  if (unknownOnlyJobs.length) {
    warnings.push(`Unknown jobs in only=: ${unknownOnlyJobs.join(", ")}`);
  }
  if (unknownSkipJobs.length) {
    warnings.push(`Unknown jobs in skip=: ${unknownSkipJobs.join(", ")}`);
  }

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
  const normalizeTargets = (raw, sourceName) => {
    const { valid, unknown } = filterKnownTokens(raw, knownTargetSet);
    if (unknown.length) {
      warnings.push(`Unknown targets in ${sourceName}: ${unknown.join(", ")}`);
    }
    return valid;
  };
  let workingTargets = [...modeDefaultTargets.map((item) => item.toLowerCase())];

  // allow only= to carry platforms if it contains ':'
  if (directiveOnlyTargetsRaw.length) {
    workingTargets = normalizeTargets(directiveOnlyTargetsRaw, "only=");
  }
  if (directives.targets) {
    workingTargets = normalizeTargets(normalizeList(directives.targets), "targets=");
  }
  if (directives.include) {
    for (const t of normalizeTargets(normalizeList(directives.include), "include=")) {
      if (!workingTargets.includes(t)) workingTargets.push(t);
    }
  }
  if (directives.exclude) {
    const ex = new Set(normalizeTargets(normalizeList(directives.exclude), "exclude="));
    workingTargets = workingTargets.filter((t) => !ex.has(t));
  }
  if (!workingTargets.length) {
    warnings.push(`No targets selected, falling back to mode defaults: ${modeDefaultTargets.join(", ")}`);
    workingTargets = [...modeDefaultTargets.map((item) => item.toLowerCase())];
  }
  if (!enabledJobs.length) {
    warnings.push("No jobs selected after applying only=/skip= filters");
  }

  const basePlan = {
    mode,
    enabledJobs,
    enabledJobsJson: listToJson(enabledJobs),
    onlyJobs: onlyJobsList.join(" "),
    onlyJobsJson: listToJson(onlyJobsList),
    skipJobs: skipJobsList.join(" "),
    skipJobsJson: listToJson(skipJobsList),
    targetsList: workingTargets.join(" "),
    targetsJson: JSON.stringify(workingTargets),
    matrixJson: JSON.stringify({ target: workingTargets }),
    rawMessage: message,
    warnings,
    warningsJson: listToJson(warnings),
    debug: { directives, labels, workingTargets, fullModeJobs, allValidJobs },
  };

  // Packaging profile handling (Phase 2)
  const packagingOutputs = computePackagingOutputs({
    cfg,
    activeProfile,
    activeConfig,
    directives,
    context,
    warnings,
  });
  const enabledProfiles = packagingOutputs.pkgEnabled
    ? uniqueList([activeProfile, PACKAGING_PROFILE])
    : [activeProfile];

  return {
    ...basePlan,
    profile: activeProfile,
    enabledProfiles,
    enabledProfilesJson: listToJson(enabledProfiles),
    pkgEnabled: packagingOutputs.pkgEnabled,
    pkgTargets: packagingOutputs.pkgTargets,
    pkgTargetsJson: listToJson(packagingOutputs.pkgTargets),
    pkgMatrixJson: JSON.stringify(packagingOutputs.pkgMatrix),
    pkgMatrixRowsJson: JSON.stringify(packagingOutputs.pkgMatrixRows),
    warningsJson: listToJson(warnings),
  };
}

/* =========================
 * Harvest directives and labels
 * =========================
 * Precedence:
 *  1) explicit action inputs
 *  2) workflow_dispatch inputs from event payload
 *  3) PR labels from event payload
 *  4) PR title/body directives
 *  5) PR head commit
 *  6) push head commit
 *  7) git log -1
 */
async function harvestDirectiveContext({ token, owner, repo, eventPath, sha, explicitInputs, coreImpl = core }) {
  const payload = readEventPayload(eventPath);
  const payloadContext = extractContextFromPayload(payload, explicitInputs);
  if (payloadContext.message) {
    return {
      message: payloadContext.message,
      source: payloadContext.source,
      headSha: payloadContext.prHeadSha || payloadContext.pushHeadSha || "",
      labels: payloadContext.labels,
      modeInput: payloadContext.modeInput,
    };
  }

  // 1) PR head commit by head SHA (most reliable, 1 call)
  if (token && owner && repo && payloadContext.prHeadSha) {
    try {
      const commit = await httpGetJson(
        `https://api.github.com/repos/${owner}/${repo}/commits/${payloadContext.prHeadSha}`,
        token
      );
      const msg = (commit?.commit?.message || "").trim();
      if (hasDirective(msg)) {
        return {
          message: msg,
          source: "pr-head-commit",
          headSha: payloadContext.prHeadSha,
          labels: payloadContext.labels,
          modeInput: payloadContext.modeInput,
        };
      }
    } catch (e) {
      coreImpl.warning(`PR head commit fetch failed: ${e.message}`);
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
      if (hasDirective(msg)) {
        return {
          message: msg,
          source: "push-head-commit",
          headSha: sha,
          labels: payloadContext.labels,
          modeInput: payloadContext.modeInput,
        };
      }
    } catch (e) {
      coreImpl.warning(`Push head commit fetch failed: ${e.message}`);
    }
  }

  // 3) git log -1 (fallback if checkout present)
  try {
    const msg = execSync("git log -1 --pretty=%B", {
      cwd: env("GITHUB_WORKSPACE") || process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (hasDirective(msg)) {
      return {
        message: msg,
        source: "git-log",
        headSha: null,
        labels: payloadContext.labels,
        modeInput: payloadContext.modeInput,
      };
    }
  } catch { /* ignore */ }

  // 4) none
  return {
    message: "",
    source: "none",
    headSha: null,
    labels: payloadContext.labels,
    modeInput: payloadContext.modeInput,
  };
}

/* =========================
 * Action entrypoint
 * ========================= */

async function run(deps = {}) {
  const coreImpl = deps.core || core;
  const envFn = deps.env || env;
  const cwd = deps.cwd || process.cwd();
  try {
    const configPath = coreImpl.getInput("config-path") || ".github/plan-ci.json";
    const token =
      coreImpl.getInput("github-token") || envFn("GITHUB_TOKEN") || envFn("GH_TOKEN") || "";
    const explicitInputs = {
      profile: coreImpl.getInput("profile") || "",
      modeInput: coreImpl.getInput("mode-input") || "",
      messageOverride: coreImpl.getInput("message-override") || "",
      labelsOverride: coreImpl.getInput("labels-override") || "",
    };

    // load config
    let config = {};
    try {
      const t = fs.readFileSync(path.resolve(cwd, configPath), "utf8");
      config = JSON.parse(t);
    } catch (e) {
      coreImpl.warning(`No config at ${configPath}; using defaults. (${e.message})`);
    }

    const repoFull = envFn("GITHUB_REPOSITORY");
    const [owner, repo] = repoFull ? repoFull.split("/") : ["", ""];
    const eventPath = envFn("GITHUB_EVENT_PATH");
    const sha = envFn("GITHUB_SHA");

    // harvest directives and labels
    const payload = readEventPayload(eventPath);
    const { message, source, headSha, labels, modeInput } = await harvestDirectiveContext({
      token,
      owner,
      repo,
      eventPath,
      sha,
      explicitInputs,
      coreImpl,
    });
    const refName = envFn("GITHUB_REF_NAME") || getRefName(payload);

    // compute plan (falls back to config defaults if message has no directives)
    const plan = computePlan({
      config,
      message,
      labels,
      profile: explicitInputs.profile,
      inputs: { modeInput },
      context: { refName },
    });

    // outputs
    coreImpl.setOutput("mode", plan.mode);
    coreImpl.setOutput("only_jobs", plan.onlyJobs);
    coreImpl.setOutput("only_jobs_json", plan.onlyJobsJson);
    coreImpl.setOutput("skip_jobs", plan.skipJobs);
    coreImpl.setOutput("skip_jobs_json", plan.skipJobsJson);
    coreImpl.setOutput("targets_json", plan.targetsJson);
    coreImpl.setOutput("targets_list", plan.targetsList);
    coreImpl.setOutput("matrix_json", plan.matrixJson);
    coreImpl.setOutput("enabled_jobs", plan.enabledJobs.join(" "));
    coreImpl.setOutput("enabled_jobs_json", plan.enabledJobsJson);
    coreImpl.setOutput("warnings_json", plan.warningsJson);
    coreImpl.setOutput("profile", plan.profile);
    coreImpl.setOutput("enabled_profiles_json", plan.enabledProfilesJson);
    coreImpl.setOutput("pkg_enabled", plan.pkgEnabled ? "true" : "false");
    coreImpl.setOutput("pkg_targets_json", plan.pkgTargetsJson);
    coreImpl.setOutput("pkg_matrix_json", plan.pkgMatrixJson);
    coreImpl.setOutput("pkg_matrix_rows_json", plan.pkgMatrixRowsJson);

    // debug
    coreImpl.setOutput("directive_source", source);
    coreImpl.setOutput("head_commit_sha", headSha || "");
    coreImpl.setOutput("raw_message", plan.rawMessage || message || "");
    coreImpl.setOutput("raw_directives", JSON.stringify(plan.debug?.directives || {}));
    coreImpl.setOutput("targets_debug", JSON.stringify(
      plan.debug?.workingTargets ||
      plan.debug?.pkgTargets ||
      []
    ));

    // summary
    coreImpl.startGroup("planner summary");
    coreImpl.info(`SOURCE: ${source}`);
    if (headSha) coreImpl.info(`HEAD_SHA: ${headSha}`);
    coreImpl.info(`MODE: ${plan.mode}`);
    coreImpl.info(`ENABLED_JOBS: ${plan.enabledJobs.join(" ")}`);
    coreImpl.info(`ONLY_JOBS: ${plan.onlyJobs || "<empty>"}`);
    coreImpl.info(`SKIP_JOBS: ${plan.skipJobs || "<empty>"}`);
    coreImpl.info(`TARGETS_LIST: ${plan.targetsList}`);
    coreImpl.info(`TARGETS_JSON: ${plan.targetsJson}`);
    coreImpl.info(`MATRIX_JSON: ${plan.matrixJson}`);
    coreImpl.info(`PROFILE: ${plan.profile}`);
    coreImpl.info(`ENABLED_PROFILES: ${plan.enabledProfiles.join(" ")}`);
    coreImpl.info(`PKG_ENABLED: ${plan.pkgEnabled ? "true" : "false"}`);
    coreImpl.info(`PKG_TARGETS_JSON: ${plan.pkgTargetsJson}`);
    coreImpl.info(`PKG_MATRIX_JSON: ${plan.pkgMatrixJson}`);
    coreImpl.info(`RAW_MESSAGE: ${plan.rawMessage || "<empty>"}`);
    coreImpl.info(`RAW_DIRECTIVES: ${JSON.stringify(plan.debug?.directives || {})}`);
    coreImpl.info(`LABELS: ${labels.join(" ") || "<empty>"}`);
    if (plan.warnings.length) {
      coreImpl.info(`WARNINGS: ${plan.warnings.join(" | ")}`);
      for (const warning of plan.warnings) coreImpl.warning(warning);
    }
    coreImpl.endGroup();
  } catch (err) {
    coreImpl.setFailed(err instanceof Error ? err.message : String(err));
  }
}

if (require.main === module) run();

module.exports = {
  computePlan,
  extractContextFromPayload,
  extractDispatchOverridesFromPayload,
  extractLabelsFromPayload,
  run,
  parseDirectives,
  normalizeList,
  lowerUnique,
  hasDirective,
};
