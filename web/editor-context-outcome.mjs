import { draftStatusMessage } from "./editor-drafts.mjs";

export function observeComposerContext(result, draftRegistry, onAcknowledged, isActive = () => true) {
  if (result?.delivery !== "composer" || result.contextAcknowledged) return;
  void result.contextOutcome.then((outcome) => {
    if (!isActive()) return;
    const imageId = result.snapshot.imageId;
    if (!outcome.ok) {
      const rejected = draftRegistry.reject(imageId, result.submissionId);
      if (!rejected) return;
      onAcknowledged({
        imageId,
        status: rejected.previousPendingRestored
          ? "任务输入框更新失败，仍保留上一版，可重新更新"
          : "任务输入框更新失败，可重新提交",
        tone: "error",
      });
      return;
    }
    const pending = draftRegistry.acknowledge(imageId, result.submissionId);
    if (!pending) return;
    if (pending.completionApplied) {
      onAcknowledged({
        imageId,
        status: draftStatusMessage(pending.completionStatus),
        tone: "neutral",
      });
      return;
    }
    onAcknowledged({
      imageId,
      status: pending.updatingTaskInput
        ? "任务输入框已更新，请确认后发送"
        : "图文修改请求已放入任务输入框，请确认后发送",
      tone: "success",
    });
  });
}

export function submissionProgressStatus(stage, hasAnnotations) {
  return {
    preview: hasAnnotations ? "正在生成标注预览..." : "正在准备修改请求...",
    prepare: hasAnnotations ? "正在保存标注..." : "正在准备修改请求...",
    context: "正在准备修改请求...",
    message: "正在发送到会话...",
  }[stage];
}

export function composerSubmissionStatus(result, updatingTaskInput) {
  if (result.delivery !== "composer") return "修改请求已发送";
  if (!result.contextAcknowledged) return "任务输入框更新未获确认，请检查输入框；若未出现可重新提交";
  return `${updatingTaskInput ? "任务输入框已更新" : "图文修改请求已放入任务输入框"}，请确认后发送`;
}

export function submissionErrorStatus(stage) {
  return {
    capabilities: "当前 Codex App 不支持将图片和文字作为同一请求提交",
    busy: "上一次任务输入框更新仍在确认中，请稍后再提交",
    preview: "标注预览生成失败，请重试",
    prepare: "修改提交准备失败，请重试",
    context: "模型上下文更新失败，请重试",
    message: "会话消息发送失败，请重试",
  }[stage] || "提交失败，请重试";
}
