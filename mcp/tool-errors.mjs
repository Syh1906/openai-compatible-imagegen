const STABLE_TOOL_ERROR_ENTRIES = [
  ["annotation_image_mismatch", "标注与父图片不匹配。"],
  ["annotation_not_found", "未找到指定标注。"],
  ["annotation_save_failed", "保存图片标注失败。"],
  ["artifact_not_found", "未找到指定图片产物。"],
  ["artifact_read_failed", "读取图片产物失败。"],
  ["artifact_reveal_failed", "无法在文件夹中显示图片。"],
  ["editor_session_not_found", "画布会话不存在或已经释放。"],
  ["edit_submission_in_flight", "当前画布提交正在执行，暂时不能签发新修订。"],
  ["edit_submission_mismatch", "画布提交与当前父图片、标注或完整编辑请求不匹配。"],
  ["image_canvas_destroyed", "当前图片的画布已经销毁。"],
  ["image_task_failed", "图片任务执行失败。"],
  ["invalid_json", "图片运行时输入不是有效 JSON。"],
  ["invalid_task", "图片任务参数无效。"],
  ["mask_policy_missing", "当前标注缺少可验证的蒙版策略。"],
  ["mask_policy_unsupported", "当前标注使用旧版蒙版策略，请重新打开画布并提交。"],
  ["missing_edit_submission", "当前图片存在待发送画布提交，但缺少提交 ID。"],
  ["project_binding_conflict", "当前 MCP 进程已经绑定到另一个图片项目。"],
  ["project_binding_required", "当前 MCP 进程尚未绑定图片项目。"],
  ["project_root_invalid", "图片项目根目录无效。"],
  ["project_root_is_plugin_root", "插件安装目录不能作为图片项目根目录。"],
  ["stale_edit_submission", "画布提交已过期、已更新或已经使用。"],
  ["unsupported_capability", "当前图片模型不支持请求的能力。"],
  ["unsupported_model_profile", "当前图片模型配置不受支持。"],
  ["output_directory_invalid", "V2 输出目录必须是图片项目内的安全目录。"],
  ["v2_config_changed", "V2 配置在项目绑定后发生变化，请重启 MCP server 并重新绑定项目。"],
  ["v2_config_invalid", "V2 配置文件无效或不可安全读取。"],
  ["v2_config_missing", "V2 配置缺失。请创建用户配置或项目配置。"],
];

export const stableToolErrorMessages = new Map(STABLE_TOOL_ERROR_ENTRIES);

export function isStableToolErrorCode(code) {
  return typeof code === "string" && stableToolErrorMessages.has(code);
}

export function stableToolErrorCodeFromText(text) {
  if (typeof text !== "string") return null;
  const match = /^([a-z][a-z0-9_]{0,63}):(?:\s|$)/.exec(text);
  const code = match?.[1] || null;
  return isStableToolErrorCode(code) ? code : null;
}
