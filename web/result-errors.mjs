import { isStableToolErrorCode, stableToolErrorCodeFromText } from "../mcp/tool-errors.mjs";


export function artifactLoadFailure(error) {
  const stage = {
    artifact_bridge_unavailable: "IMG-BRIDGE",
    artifact_tool_call_failed: "IMG-TOOL-CALL",
    artifact_server_error: "IMG-SERVER",
    artifact_payload_invalid: "IMG-PAYLOAD",
    artifact_schema_missing: "IMG-SCHEMA",
  }[error?.code] || "IMG-UNKNOWN";
  return `图片读取失败 · ${stage}`;
}

export function resultFailureCode(result) {
  if (result?.isError) return "artifact_server_error";
  if (isStableToolErrorCode(result?.structuredContent?.error?.code)) return "artifact_server_error";
  const firstContent = Array.isArray(result?.content) ? result.content[0] : null;
  if (stableToolErrorCodeFromText(firstContent?.text)) return "artifact_server_error";
  return null;
}
