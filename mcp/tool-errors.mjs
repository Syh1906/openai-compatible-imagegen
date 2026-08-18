const STABLE_TOOL_ERROR_ENTRIES = [
  ["annotation_image_mismatch", "标注与父图片不匹配。"],
  ["annotation_not_found", "未找到指定标注。"],
  ["annotation_save_failed", "保存图片标注失败。"],
  ["artifact_not_found", "未找到指定图片产物。"],
  ["artifact_ignore_write_failed", "无法安全保护图片产物目录。"],
  ["artifact_read_failed", "读取图片产物失败。"],
  ["artifact_reveal_failed", "无法在文件夹中显示图片。"],
  ["editor_session_not_found", "画布会话不存在或已经释放。"],
  ["editor_state_invalid", "画布状态无效。"],
  ["editor_state_unavailable", "画布状态暂时不可用。"],
  ["edit_submission_in_flight", "当前画布提交正在执行，暂时不能签发新修订。"],
  ["edit_submission_limit", "当前图片的画布提交记录已达到上限。"],
  ["edit_submission_mismatch", "画布提交与当前父图片、标注或完整编辑请求不匹配。"],
  ["edit_submission_state_invalid", "画布提交状态无效。"],
  ["edit_submission_state_unavailable", "画布提交状态暂时不可用。"],
  ["host_observation_state_invalid", "宿主观察状态无效。"],
  ["host_observation_unavailable", "宿主观察状态暂时不可用。"],
  ["image_canvas_destroyed", "当前图片的画布已经销毁。"],
  ["image_task_failed", "图片任务执行失败。"],
  ["invalid_json", "图片运行时输入不是有效 JSON。"],
  ["invalid_task", "图片任务参数无效。"],
  ["mask_policy_missing", "当前标注缺少可验证的蒙版策略。"],
  ["mask_policy_unsupported", "当前标注使用旧版蒙版策略，请重新打开画布并提交。"],
  ["missing_edit_submission", "当前图片存在待发送画布提交，但缺少提交 ID。"],
  ["project_binding_conflict", "当前图片项目绑定已经关联到另一个项目。"],
  ["project_binding_invalid", "图片项目绑定 ID 无效。"],
  ["project_binding_required", "缺少有效的图片项目绑定。"],
  ["project_binding_state_invalid", "图片项目绑定状态无效。"],
  ["project_binding_unavailable", "图片项目绑定状态暂时不可用。"],
  ["project_root_invalid", "图片项目根目录无效。"],
  ["project_root_is_plugin_root", "插件安装目录不能作为图片项目根目录。"],
  ["stale_edit_submission", "画布提交已过期、已更新或已经使用。"],
  ["unsupported_capability", "当前图片模型不支持请求的能力。"],
  ["unsupported_model_profile", "当前图片模型配置不受支持。"],
  ["image_config_changed", "图片配置在项目绑定后发生变化，请重新显式绑定当前图片项目。"],
  ["image_config_invalid", "用户图片配置文件无效或不可安全读取。"],
  ["image_config_missing", "用户图片配置缺失。请创建 ~/.codex/openai-compatible-imagegen/config.json。"],
  ["image_config_exists", "用户图片配置已经存在，初始化不会覆盖现有文件。"],
  ["image_config_write_failed", "无法安全写入图片配置。"],
  ["image_config_update_invalid", "图片配置修改内容无效。"],
  ["image_config_update_forbidden", "图片配置修改包含不允许的字段。"],
  ["project_config_missing", "项目图片配置不存在，请先初始化或创建项目覆盖文件。"],
  ["output_directory_invalid", "输出目录必须是图片项目内的安全目录。"],
  ["project_config_forbidden", "项目图片配置包含不允许覆盖的字段。"],
  ["project_config_invalid", "项目图片配置文件无效或不可安全读取。"],
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
