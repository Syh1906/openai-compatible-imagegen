import { z } from "zod";

export function registerConfigTools(server, configManager, toolError) {
  server.registerTool("initialize_image_config", {
    title: "初始化图片配置",
    description: "在固定用户路径创建一次图片配置模板。不会读取、接收或写入 API key；已有配置不会被覆盖。传入项目根目录时会幂等更新项目 .gitignore。",
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
    title: "查询图片配置",
    description: "查询用户配置及可选项目覆盖的脱敏内容和固定路径，不返回 api_key 或其他凭据。",
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
    title: "修改图片配置",
    description: "按配置白名单修改用户配置或项目覆盖。禁止写入 API key，项目作用域只能修改安全覆盖字段；修改后需重新绑定项目。",
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
