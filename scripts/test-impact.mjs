const ALLOWED_CHECKS = new Set(["build", "compile-python", "diff", "plugin"]);
const ALLOWED_PLATFORMS = new Set(["linux", "macos", "windows"]);
const ALLOWED_RUNTIMES = new Set(["node", "python"]);


export function validateImpactManifest(manifest) {
  if (!manifest || manifest.version !== 1) {
    throw new Error("test impact manifest version must be 1");
  }
  if (!manifest.suites || typeof manifest.suites !== "object" || Array.isArray(manifest.suites)) {
    throw new Error("test impact manifest suites must be an object");
  }
  const suiteNames = Object.keys(manifest.suites);
  if (suiteNames.length === 0) throw new Error("test impact manifest must declare suites");

  for (const [name, suite] of Object.entries(manifest.suites)) {
    if (!suite || typeof suite.directory !== "string" || !suite.directory.startsWith("tests/")) {
      throw new Error(`test suite ${name} must declare a tests/ directory`);
    }
    validateValues(`test suite ${name} runtimes`, suite.runtimes, ALLOWED_RUNTIMES, { required: true });
    validateValues(`test suite ${name} requirements`, suite.requires ?? [], ALLOWED_RUNTIMES);
  }

  if (!Array.isArray(manifest.rules) || manifest.rules.length === 0) {
    throw new Error("test impact manifest must declare rules");
  }
  const ruleNames = new Set();
  const exactPaths = new Set();
  const prefixes = new Set();
  for (const rule of manifest.rules) {
    if (!rule || typeof rule.name !== "string" || rule.name.length === 0) {
      throw new Error("every test impact rule must have a name");
    }
    if (ruleNames.has(rule.name)) throw new Error(`duplicate test impact rule name: ${rule.name}`);
    ruleNames.add(rule.name);
    const files = validatePaths(`test impact rule ${rule.name} files`, rule.files ?? []);
    const rulePrefixes = validatePaths(`test impact rule ${rule.name} prefixes`, rule.prefixes ?? []);
    if (files.length === 0 && rulePrefixes.length === 0) {
      throw new Error(`test impact rule ${rule.name} must declare files or prefixes`);
    }
    rejectDuplicateMatches(files, exactPaths, "file");
    rejectDuplicateMatches(rulePrefixes, prefixes, "prefix");
    validateValues(`test impact rule ${rule.name} suites`, rule.suites ?? [], new Set(suiteNames));
    validateValues(`test impact rule ${rule.name} checks`, rule.checks ?? [], ALLOWED_CHECKS);
    validateValues(`test impact rule ${rule.name} platforms`, rule.platforms ?? [], ALLOWED_PLATFORMS);
  }
  return manifest;
}


export function selectImpactPlan(changedFiles, manifest, { mode = "smart" } = {}) {
  validateImpactManifest(manifest);
  if (mode === "release") {
    return {
      mode,
      changedFiles: [],
      suites: Object.keys(manifest.suites).sort(),
      checks: [...ALLOWED_CHECKS].sort(),
      platforms: [...ALLOWED_PLATFORMS].sort(),
      reasons: [],
    };
  }
  if (mode !== "smart") throw new Error(`unsupported test impact mode: ${mode}`);

  const normalizedFiles = [...new Set(changedFiles.map(normalizeRepositoryPath))].sort();
  const suites = new Set();
  const checks = new Set();
  const platforms = new Set(["linux"]);
  const reasons = [];
  for (const file of normalizedFiles) {
    const rule = findMostSpecificRule(file, manifest.rules);
    if (!rule) throw new Error(`no test impact rule matches ${file}`);
    for (const suite of rule.suites ?? []) suites.add(suite);
    for (const check of rule.checks ?? []) checks.add(check);
    for (const platform of rule.platforms ?? []) platforms.add(platform);
    reasons.push({ file, rule: rule.name });
  }
  return {
    mode,
    changedFiles: normalizedFiles,
    suites: [...suites].sort(),
    checks: [...checks].sort(),
    platforms: [...platforms].sort(),
    reasons,
  };
}


function findMostSpecificRule(file, rules) {
  let selected = null;
  let selectedScore = -1;
  for (const rule of rules) {
    for (const candidate of rule.files ?? []) {
      if (file === normalizeRepositoryPath(candidate) && 100_000 + candidate.length > selectedScore) {
        selected = rule;
        selectedScore = 100_000 + candidate.length;
      }
    }
    for (const candidate of rule.prefixes ?? []) {
      const prefix = normalizeRepositoryPath(candidate);
      if (file.startsWith(prefix) && prefix.length > selectedScore) {
        selected = rule;
        selectedScore = prefix.length;
      }
    }
  }
  return selected;
}


function normalizeRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("changed paths must be non-empty strings");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized.includes("../")) {
    throw new Error(`changed path must be repository-relative: ${value}`);
  }
  return normalized;
}


function validatePaths(label, values) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return values.map((value) => {
    const normalized = normalizeRepositoryPath(value);
    if (normalized !== value) throw new Error(`${label} must use normalized paths: ${value}`);
    return value;
  });
}


function validateValues(label, values, allowed, { required = false } = {}) {
  if (!Array.isArray(values) || (required && values.length === 0)) {
    throw new Error(`${label} must be ${required ? "a non-empty" : "an"} array`);
  }
  for (const value of values) {
    if (!allowed.has(value)) throw new Error(`${label} contains unknown value: ${value}`);
  }
}


function rejectDuplicateMatches(values, seen, kind) {
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate test impact ${kind}: ${value}`);
    seen.add(value);
  }
}
