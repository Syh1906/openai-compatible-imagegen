import { stableToolErrorMessages } from "../mcp/tool-errors.mjs";

const SOURCES = ["ui/notifications/tool-result", "tools/call"];
const RELEASE_FINGERPRINT_PATTERN = /^[a-f0-9]{20}$/;
const STABLE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|credential|password|secret|token|cookie)/i;
const RETAINED_KEY_NAMES = [
  "_meta",
  "accepted",
  "artifact",
  "artifacts",
  "blob",
  "canvasStatus",
  "capabilities",
  "childIds",
  "code",
  "content",
  "data",
  "dataBase64",
  "editorSession",
  "error",
  "errorCode",
  "height",
  "id",
  "imageId",
  "imageIds",
  "isError",
  "mask",
  "message",
  "mimeType",
  "model",
  "models",
  "operation",
  "parentIds",
  "provider",
  "resource",
  "status",
  "structuredContent",
  "text",
  "type",
  "uri",
  "widgetData",
  "width",
];
const RETAINED_KEYS = new Set(RETAINED_KEY_NAMES);
const PROBED_SENSITIVE_KEYS = [
  "api_key",
  "apiKey",
  "authorization",
  "credential",
  "password",
  "secret",
  "token",
  "cookie",
];
const PROBED_OBJECT_KEYS = [...RETAINED_KEY_NAMES, ...PROBED_SENSITIVE_KEYS];
const RETAINED_ERROR_CODES = new Set([
  ...stableToolErrorMessages.keys(),
  "artifact_bridge_unavailable",
  "artifact_payload_invalid",
  "artifact_server_error",
  "artifact_tool_call_failed",
  "release_identity_mismatch",
  "roots_list_failed",
  "tools_call_rejected",
]);
const MAX_DEPTH = 8;
const MAX_FIELDS = 256;
const MAX_CHILDREN = 32;
const MAX_ERROR_CODES = 32;
const MAX_PATH_LENGTH = 512;
const MAX_REPORTED_LENGTH = 64 * 1024 * 1024;
const MAX_REPORT_ATTEMPTS = 2;


export function summarizeHostEnvelope(source, value) {
  const fields = [];
  const errorCodes = new Set();
  const visited = new WeakSet();
  let truncated = false;

  try {
    visit(value, "$", 0, false);
  } catch {
    truncated = true;
  }
  return {
    source,
    fields,
    errorCodes: [...errorCodes].sort(),
    truncated,
  };

  function visit(current, path, depth, errorContainer) {
    if (fields.length >= MAX_FIELDS) {
      truncated = true;
      return;
    }

    const type = valueType(current);
    const container = sampleContainer(current, type);
    fields.push({ path, type, length: container.length });
    if (container.truncated) truncated = true;
    if (type !== "array" && type !== "object") return;
    if (visited.has(current)) {
      truncated = true;
      return;
    }
    visited.add(current);

    if (errorContainer && type === "object") retainErrorCode(current.code);
    if (type === "object") retainErrorCode(current.errorCode);

    const entries = container.entries;
    if (entries.length === 0) return;
    if (depth >= MAX_DEPTH) truncated = true;
    if (depth >= MAX_DEPTH) return;

    for (const [rawKey, child] of entries.slice(0, MAX_CHILDREN)) {
      if (fields.length >= MAX_FIELDS) {
        truncated = true;
        return;
      }
      const isArrayIndex = type === "array";
      const key = isArrayIndex ? String(rawKey) : safeKey(String(rawKey));
      const childPath = isArrayIndex ? `${path}[${key}]` : `${path}.${key}`;
      if (childPath.length > MAX_PATH_LENGTH) {
        truncated = true;
        continue;
      }
      const childIsError = !isArrayIndex && /error/i.test(String(rawKey));
      visit(child, childPath, depth + 1, childIsError);
    }
  }

  function retainErrorCode(code) {
    if (
      typeof code !== "string"
      || !STABLE_ERROR_CODE_PATTERN.test(code)
      || !RETAINED_ERROR_CODES.has(code)
      || errorCodes.has(code)
    ) return;
    if (errorCodes.size >= MAX_ERROR_CODES) {
      truncated = true;
      return;
    }
    errorCodes.add(code);
  }
}


export function createHostObservationReporter({ app, releaseFingerprint }) {
  const enabled = Boolean(
    app
    && typeof app.callServerTool === "function"
    && RELEASE_FINGERPRINT_PATTERN.test(releaseFingerprint || ""),
  );
  const observations = new Map();
  const pendingSources = new Set();
  let submissionStarted = false;
  let submissionState = enabled ? "collecting" : "disabled";
  let submissionAttempts = 0;

  return {
    getStatus: () => ({ state: submissionState, attempts: submissionAttempts }),
    observeNotification: (value) => observe(SOURCES[0], value),
    observeToolCall: (value) => {
      if (value?.isError === true) return;
      observe(SOURCES[1], value);
    },
  };

  function observe(source, value) {
    if (!enabled || submissionStarted || observations.has(source) || pendingSources.has(source)) return;
    pendingSources.add(source);
    Promise.resolve()
      .then(() => {
        observations.set(source, summarizeHostEnvelope(source, value));
        pendingSources.delete(source);
        if (observations.size !== SOURCES.length || submissionStarted) return null;
        submissionStarted = true;
        const pair = SOURCES.map((item) => observations.get(item));
        return submit(pair);
      })
      .catch(() => {});
  }

  async function submit(pair) {
    submissionState = "submitting";
    while (submissionAttempts < MAX_REPORT_ATTEMPTS) {
      submissionAttempts += 1;
      try {
        const result = await app.callServerTool({
          name: "report_imagegen_host_observation",
          arguments: { releaseFingerprint, observations: pair },
        });
        if (result?.isError === true) {
          if (submissionAttempts === MAX_REPORT_ATTEMPTS) submissionState = "failed";
          continue;
        }
        submissionState = "submitted";
        return;
      } catch {
        if (submissionAttempts === MAX_REPORT_ATTEMPTS) submissionState = "failed";
      }
    }
  }
}


function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  return ["boolean", "number", "string", "object"].includes(type) ? type : "unknown";
}


function sampleContainer(value, type) {
  if (type === "string") {
    return {
      length: Math.min(value.length, MAX_REPORTED_LENGTH),
      entries: [],
      truncated: value.length > MAX_REPORTED_LENGTH,
    };
  }
  if (type === "array") {
    const entries = [];
    const sampleLength = Math.min(value.length, MAX_CHILDREN);
    for (let index = 0; index < sampleLength; index += 1) {
      if (Object.prototype.hasOwnProperty.call(value, index)) entries.push([index, value[index]]);
    }
    return {
      length: Math.min(value.length, MAX_REPORTED_LENGTH),
      entries,
      truncated: value.length > MAX_CHILDREN || value.length > MAX_REPORTED_LENGTH,
    };
  }
  if (type === "object") {
    const entries = [];
    const projectedKeys = new Set();
    let truncated = false;
    for (const key of PROBED_OBJECT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const projectedKey = safeKey(key);
      if (projectedKeys.has(projectedKey)) continue;
      projectedKeys.add(projectedKey);
      if (entries.length >= MAX_CHILDREN) {
        truncated = true;
        break;
      }
      entries.push([key, value[key]]);
    }
    return { length: null, entries, truncated };
  }
  return { length: null, entries: [], truncated: false };
}


function safeKey(key) {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "redacted";
  return RETAINED_KEYS.has(key) ? key : "field";
}
