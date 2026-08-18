import { z } from "zod";

export function registerConfigTools(server, configManager, toolError) {
  server.registerTool("initialize_image_config", {
    title: "Initialize image configuration",
    description: "Create an image configuration template at the fixed user path without overwriting an existing file. Protect user and optional project configuration directories with a local .gitignore containing only *, and prefer api_key_env in the template.",
    inputSchema: { projectRoot: z.string().min(1).optional() },
    outputSchema: z.object({ created: z.literal(true), path: z.string().min(1), config: z.record(z.any()), gitignoreUpdated: z.boolean() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ projectRoot }) => {
    try {
      const result = await configManager.initialize({ projectRoot });
      return { content: [{ type: "text", text: "已创建图片配置模板。请编辑固定用户配置文件并设置对应环境变量后重新绑定项目。" }], structuredContent: result };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("inspect_image_config", {
    title: "Inspect image configuration",
    description: "Return redacted user configuration, optional project overrides, and fixed paths without returning api_key or other credentials.",
    inputSchema: { projectRoot: z.string().min(1).optional() },
    outputSchema: z.object({ user: z.record(z.any()), project: z.record(z.any()) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ projectRoot }) => {
    try {
      const result = await configManager.inspect({ projectRoot });
      return { content: [{ type: "text", text: "已读取脱敏图片配置。" }], structuredContent: result };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("update_image_config", {
    title: "Update image configuration",
    description: "Update allowlisted user or project configuration fields and protect the target configuration directory with a local .gitignore containing only *. User-level api_key writes require an explicit request and remain redacted; project scope rejects credentials and non-allowlisted fields. Rebind the project after an update.",
    inputSchema: { scope: z.enum(["user", "project"]).default("user"), projectRoot: z.string().min(1).optional(), changes: z.record(z.any()) },
    outputSchema: z.object({ scope: z.enum(["user", "project"]), path: z.string().min(1), config: z.record(z.any()) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ scope, projectRoot, changes }) => {
    try {
      const result = await configManager.update({ scope, projectRoot, changes });
      return { content: [{ type: "text", text: "已更新图片配置。请重新绑定项目后继续图片任务。" }], structuredContent: result };
    } catch (error) { return toolError(error); }
  });
}
