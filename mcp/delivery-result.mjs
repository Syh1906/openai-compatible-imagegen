const DELIVERY_WARNING_CODES = new Set([
  "alpha_prompt_unmet",
  "background_not_dark",
  "chroma_matting_unavailable",
  "delivery_not_ready",
  "local_transparency_check_unavailable",
  "mask_dimensions_mismatch",
  "mask_required",
  "mask_unavailable",
  "source_alpha_unmet",
  "transparency_pixel_limit",
  "transparent_qa_unmet",
  "unsupported_transparency_mode",
]);
const QA_STATUSES = new Set(["fail", "not_evaluated", "partial", "pass"]);
const CHECK_STATUSES = new Set([...QA_STATUSES, "unsupported", "unmet"]);
const IMAGE_FORMATS = new Set(["jpeg", "png", "webp"]);
const QA_ROLES = new Set(["delivery", "source"]);
const QA_CHECK_NAMES = new Set([
  "decode",
  "exists",
  "expected_count",
  "expected_size",
  "format",
]);
const QA_CONDITION_KINDS = new Set(["reference-metadata", "transparent"]);
const QA_SCOPES = new Set(["delivery", "source"]);
const TRANSPARENCY_MODES = new Set([
  "chroma-matting",
  "emissive-alpha",
  "inspect-alpha",
  "mask-alpha",
  "none",
  "prompt-alpha",
]);
const TRANSPARENCY_STATUSES = new Set([
  "fail",
  "not_requested",
  "pass",
  "pending",
  "unmet",
]);
const TRANSFORM_KINDS = new Set(["exact-size", "grid", "preview-board", "transparent"]);
const BACKGROUND_PROFILE_METRICS = {
  coverage: "ratio",
  required: "ratio",
  tolerance: "number",
  hard_coverage: "ratio",
  soft_coverage: "ratio",
};
const DEFRINGE_METRICS = {
  radius: "count",
  pixels: "count",
  spill_pixels: "count",
  unresolved_pixels: "count",
  tolerance: "number",
  spill_threshold: "number",
  opaque_edge_cleanup: "boolean",
};
const MATTE_METRICS = {
  alpha_bits: "count",
  invert: "boolean",
  candidate_pixels: "count",
  edge_connected_pixels: "count",
  transparent_pixels: "count",
  partial_alpha_pixels: "count",
  inner_tolerance: "number",
  outer_tolerance: "number",
};
const REFINEMENT_METRICS = {
  alpha_bits: "count",
  threshold: "nullable-number",
  expand: "number",
  feather: "count",
  gamma: "number",
  min_component_area: "count",
  removed_components: "count",
  removed_pixels: "count",
  black_point: "number",
  white_point: "number",
};
const MATTE_CLEANUP_METRICS = {
  unmatte_pixels: "count",
  defringe: DEFRINGE_METRICS,
};
const TRANSPARENCY_CHECK_METRICS = {
  transparent_pixel_ratio: "ratio",
  visible_pixel_ratio: "ratio",
  visible_border_ratio: "ratio",
  source_size: "size",
  mask_size: "size",
  border_dark: BACKGROUND_PROFILE_METRICS,
  border_key: {
    hard_coverage: "ratio",
    soft_coverage: "ratio",
  },
  key_contamination: {
    pixels: "count",
    direct_pixels: "count",
    spill_pixels: "count",
    tested_pixels: "count",
    ratio: "ratio",
    allowed_pixels: "count",
    tolerance: "number",
    spill_threshold: "number",
  },
  options: {
    black_point: "number",
    white_point: "number",
    gamma: "number",
    border_dark_tolerance: "number",
    min_border_dark_coverage: "ratio",
    invert: "boolean",
    threshold: "nullable-number",
    feather: "count",
    expand: "number",
    min_component_area: "count",
    defringe_radius: "count",
    inner_tolerance: "number",
    outer_tolerance: "number",
    despill_strength: "number",
    contamination_tolerance: "number",
    border_hard_coverage: "ratio",
    border_soft_coverage: "ratio",
  },
  refinement: REFINEMENT_METRICS,
  matte_cleanup: MATTE_CLEANUP_METRICS,
  alpha_pipeline: {
    background_profile: BACKGROUND_PROFILE_METRICS,
    matte: MATTE_METRICS,
    refinement: REFINEMENT_METRICS,
    matte_cleanup: MATTE_CLEANUP_METRICS,
    defringe: DEFRINGE_METRICS,
    contrast_review_contract: { preview_required: "boolean" },
  },
};


export function safeDeliveryWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((warning) => {
    const match = /^([a-z][a-z0-9_]{0,63}):/.exec(String(warning));
    const candidate = match?.[1];
    const code = DELIVERY_WARNING_CODES.has(candidate) ? candidate : "delivery_not_ready";
    return `${code}: 本地图片交付条件尚未满足。`;
  });
}


export function safeDeliveryQa(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const result = {};
  if (value.schema_version === "qa.v1") result.schema_version = "qa.v1";
  const status = safeEnum(value.status, QA_STATUSES);
  if (status !== undefined) result.status = status;

  if (Array.isArray(value.artifacts)) {
    result.artifacts = value.artifacts
      .slice(0, 10)
      .map(safeQaArtifact)
      .filter((item) => item !== undefined);
  }
  if (Array.isArray(value.conditions)) {
    result.conditions = value.conditions
      .slice(0, 20)
      .map(safeQaCondition)
      .filter((item) => item !== undefined);
  }
  if (Array.isArray(value.checks)) {
    result.checks = value.checks
      .slice(0, 20)
      .map(safeQaCheck)
      .filter((item) => item !== undefined);
  } else {
    const checks = safeWhitelistedMetrics(value.checks, TRANSPARENCY_CHECK_METRICS);
    if (checks !== undefined) result.checks = checks;
  }
  if (Array.isArray(value.warnings)) {
    result.warnings = safeDeliveryWarnings(value.warnings);
  }
  if (Array.isArray(value.errors)) {
    result.errors = safeDeliveryWarnings(value.errors);
  }
  return Object.keys(result).length ? result : undefined;
}


export function safeDeliverySummary(value) {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;

  const result = {};
  const source = safeSourceSummary(value.source);
  if (source !== undefined) result.source = source;
  if (Array.isArray(value.transforms)) {
    result.transforms = value.transforms
      .slice(0, 10)
      .map(safeTransformSummary)
      .filter((item) => item !== undefined);
  }
  return Object.keys(result).length ? result : undefined;
}


function safeQaArtifact(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  const role = safeEnum(value.role, QA_ROLES);
  if (role !== undefined) result.role = role;
  const inspection = safeInspection(value.inspection);
  if (inspection !== undefined) result.inspection = inspection;
  if (Array.isArray(value.checks)) {
    result.checks = value.checks
      .slice(0, 20)
      .map(safeQaCheck)
      .filter((item) => item !== undefined);
  }
  return Object.keys(result).length ? result : undefined;
}


function safeInspection(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  const format = safeEnum(value.format, IMAGE_FORMATS);
  if (format !== undefined) result.format = format;
  const width = safePositiveInteger(value.width);
  const height = safePositiveInteger(value.height);
  if (width !== undefined) result.width = width;
  if (height !== undefined) result.height = height;
  if (value.mode === "rgba") result.mode = "rgba";
  if (typeof value.has_alpha === "boolean") result.has_alpha = value.has_alpha;
  const alphaBbox = safeAlphaBbox(value.alpha_bbox);
  const alphaCoverage = safeFiniteNumber(value.alpha_coverage, 0, 1);
  const alphaMargins = safeAlphaMargins(value.alpha_margins);
  const components = safeComponents(value.components);
  const cornerAlpha = safeCornerAlpha(value.corner_alpha);
  const edgeAlpha = safeEdgeAlpha(value.edge_alpha);
  const nontransparentPixels = safeNonNegativeInteger(value.nontransparent_pixels);
  const semiTransparentRatio = safeFiniteNumber(value.semi_transparent_ratio, 0, 1);
  if (alphaBbox !== undefined) result.alpha_bbox = alphaBbox;
  if (alphaCoverage !== undefined) result.alpha_coverage = alphaCoverage;
  if (alphaMargins !== undefined) result.alpha_margins = alphaMargins;
  if (components !== undefined) result.components = components;
  if (cornerAlpha !== undefined) result.corner_alpha = cornerAlpha;
  if (edgeAlpha !== undefined) result.edge_alpha = edgeAlpha;
  if (nontransparentPixels !== undefined) result.nontransparent_pixels = nontransparentPixels;
  if (semiTransparentRatio !== undefined) result.semi_transparent_ratio = semiTransparentRatio;
  return Object.keys(result).length ? result : undefined;
}


function safeQaCheck(value) {
  if (!isRecord(value)) return undefined;
  const name = safeEnum(value.name, QA_CHECK_NAMES);
  const status = safeEnum(value.status, CHECK_STATUSES);
  if (name === undefined || status === undefined) return undefined;
  const result = { name, status };
  const expected = safeCheckValue(value.expected);
  const actual = safeCheckValue(value.actual);
  if (expected !== undefined) result.expected = expected;
  if (actual !== undefined) result.actual = actual;
  return result;
}


function safeQaCondition(value) {
  if (!isRecord(value)) return undefined;
  const kind = safeEnum(value.kind, QA_CONDITION_KINDS);
  const status = safeEnum(value.status, CHECK_STATUSES);
  if (kind === undefined || status === undefined) return undefined;
  const result = { kind };
  if (typeof value.requested === "boolean") result.requested = value.requested;
  result.status = status;
  const scope = safeEnum(value.scope, QA_SCOPES);
  if (scope !== undefined) result.scope = scope;
  const evidence = safeQaEvidence(value.evidence);
  if (evidence !== undefined) result.evidence = evidence;
  return result;
}


function safeSourceSummary(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  const format = safeEnum(value.format, IMAGE_FORMATS);
  const width = safePositiveInteger(value.width);
  const height = safePositiveInteger(value.height);
  if (format !== undefined) result.format = format;
  if (width !== undefined) result.width = width;
  if (height !== undefined) result.height = height;
  return Object.keys(result).length ? result : undefined;
}


function safeTransformSummary(value) {
  if (!isRecord(value)) return undefined;
  const kind = safeEnum(value.kind, TRANSFORM_KINDS);
  if (kind === undefined) return undefined;
  const result = { kind };
  if (kind === "transparent") {
    const mode = safeEnum(value.mode, TRANSPARENCY_MODES);
    const status = safeEnum(value.status, TRANSPARENCY_STATUSES);
    if (mode !== undefined) result.mode = mode;
    if (status !== undefined) result.status = status;
  } else if (kind === "exact-size") {
    const size = safeSize(value.size);
    const fit = safeEnum(value.fit, new Set(["contain", "stretch"]));
    const resample = safeEnum(value.resample, new Set(["bilinear", "nearest"]));
    const safeMargin = safeFiniteNumber(value.safeMargin, 0, 0.5);
    if (size !== undefined) result.size = size;
    if (fit !== undefined) result.fit = fit;
    if (resample !== undefined) result.resample = resample;
    if (safeMargin !== undefined) result.safeMargin = safeMargin;
  } else if (kind === "grid") {
    for (const key of ["rows", "cols", "count"]) {
      const count = safePositiveInteger(value[key], 100);
      if (count !== undefined) result[key] = count;
    }
  } else if (kind === "preview-board") {
    const count = safePositiveInteger(value.count, 100);
    if (count !== undefined) result.count = count;
  }
  return result;
}


function safeCheckValue(value) {
  if (value === null || typeof value === "boolean") return value;
  const number = safeFiniteNumber(value, -1_000_000_000, 1_000_000_000);
  if (number !== undefined) return number;
  const format = safeEnum(value, IMAGE_FORMATS);
  if (format !== undefined) return format;
  if (!Array.isArray(value)) return undefined;
  const result = value.slice(0, 8).map(safeCheckValue);
  return result.every((item) => item !== undefined) ? result : undefined;
}


function safeWhitelistedMetrics(value, schema) {
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const [key, descriptor] of Object.entries(schema)) {
    const metric = safeWhitelistedMetric(value[key], descriptor);
    if (metric !== undefined) result[key] = metric;
  }
  return Object.keys(result).length ? result : undefined;
}


function safeWhitelistedMetric(value, descriptor) {
  if (isRecord(descriptor)) return safeWhitelistedMetrics(value, descriptor);
  if (descriptor === "boolean") return typeof value === "boolean" ? value : undefined;
  if (descriptor === "count") return safeNonNegativeInteger(value);
  if (descriptor === "number") return safeFiniteNumber(value, -1_000_000_000, 1_000_000_000);
  if (descriptor === "nullable-number") {
    return value === null ? null : safeFiniteNumber(value, -1_000_000_000, 1_000_000_000);
  }
  if (descriptor === "ratio") return safeFiniteNumber(value, 0, 1);
  if (descriptor === "size") return safeSize(value);
  return undefined;
}


function safeQaEvidence(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  const artifacts = safePositiveInteger(value.artifacts, 10);
  if (artifacts !== undefined) result.artifacts = artifacts;
  if (Array.isArray(value.alpha) && value.alpha.length <= 10 && value.alpha.every((item) => typeof item === "boolean")) {
    result.alpha = [...value.alpha];
  }
  return Object.keys(result).length ? result : undefined;
}


function safeAlphaBbox(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const result = value.map((item) => safeNonNegativeInteger(item));
  return result.every((item) => item !== undefined) ? result : undefined;
}


function safeAlphaMargins(value) {
  if (value === null) return null;
  return safeIntegerRecord(value, ["left", "top", "right", "bottom"]);
}


function safeComponents(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const key of ["count", "largest_pixels", "tiny_count", "tiny_max_pixels"]) {
    const metric = safeNonNegativeInteger(value[key]);
    if (metric !== undefined) result[key] = metric;
  }
  const largestRatio = safeFiniteNumber(value.largest_ratio, 0, 1);
  if (largestRatio !== undefined) result.largest_ratio = largestRatio;
  return Object.keys(result).length ? result : undefined;
}


function safeCornerAlpha(value) {
  return safeIntegerRecord(value, ["top_left", "top_right", "bottom_left", "bottom_right"], 255);
}


function safeEdgeAlpha(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const key of ["pixels", "nontransparent_pixels", "partial_alpha_pixels"]) {
    const metric = safeNonNegativeInteger(value[key]);
    if (metric !== undefined) result[key] = metric;
  }
  if (typeof value.touches_canvas === "boolean") result.touches_canvas = value.touches_canvas;
  return Object.keys(result).length ? result : undefined;
}


function safeIntegerRecord(value, keys, maximum = 1_000_000_000) {
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const key of keys) {
    const metric = safeNonNegativeInteger(value[key], maximum);
    if (metric !== undefined) result[key] = metric;
  }
  return Object.keys(result).length ? result : undefined;
}


function safeSize(value) {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const width = safePositiveInteger(value[0]);
  const height = safePositiveInteger(value[1]);
  return width !== undefined && height !== undefined ? [width, height] : undefined;
}


function safePositiveInteger(value, maximum = 100_000) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : undefined;
}


function safeNonNegativeInteger(value, maximum = 1_000_000_000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}


function safeFiniteNumber(value, minimum, maximum) {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : undefined;
}


function safeEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}


function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
