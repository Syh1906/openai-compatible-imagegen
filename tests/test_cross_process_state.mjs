import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImagegenServer } from "../mcp/create-server.mjs";
import { createFileEditSubmissionRegistry } from "../mcp/file-edit-submission-registry.mjs";
import { createFileHostObservationStore } from "../mcp/host-observation-store.mjs";
import { createProjectContext } from "../mcp/project-context.mjs";
import { createReleaseBundle, RELEASE_IDENTITY_PLACEHOLDER } from "../mcp/release-identity.mjs";


const PARENT_ID = "img_01J00000000000000000000000";
const RESULT_ID = "img_01J00000000000000000000001";
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL1WQAAAABJRU5ErkJggg==";


test("a widget submission is consumed once and replayed across MCP processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-cross-process-state-"));
  const pluginRoot = path.join(root, "plugin");
  const projectRoot = path.join(root, "project");
  const artifactRoot = path.join(projectRoot, "output", "imagegen");
  const stateRoot = path.join(root, "user-state");
  await Promise.all([mkdir(pluginRoot), mkdir(artifactRoot, { recursive: true })]);
  const releaseIdentity = createReleaseBundle({
    pluginId: "openai-compatible-imagegen",
    pluginVersion: "0.1.0-cross-process-test",
    serverBuildInputs: [{ path: "mcp/server.mjs", content: "cross process state" }],
    widgetHtml: `<html><head>${RELEASE_IDENTITY_PLACEHOLDER}</head></html>`,
  }).releaseIdentity;
  const artifacts = new Map([
    [PARENT_ID, artifact(PARENT_ID, "generate")],
    [RESULT_ID, artifact(RESULT_ID, "edit")],
  ]);
  const taskCalls = [];
  const createServer = () => createImagegenServer({
    releaseIdentity,
    launchContext: { cwd: pluginRoot, pluginRoot },
    projectContext: createProjectContext({
      pluginRoot,
      stateRoot,
      resolveConfigBinding: async () => configBinding({ projectRoot, artifactRoot, stateRoot }),
      verifyConfigBinding: async () => {},
    }),
    editSubmissions: createFileEditSubmissionRegistry(),
    readWidgetHtml: async () => "<html></html>",
    runTask: async (task) => {
      taskCalls.push(task);
      return { ok: true, artifacts: [artifacts.get(RESULT_ID)] };
    },
    readArtifact: async (imageId) => ({ metadata: artifacts.get(imageId), data: PNG_BASE64 }),
    readAnnotation: async () => { throw new Error("not used"); },
    saveAnnotations: async () => { throw new Error("not used"); },
    deleteAnnotation: async () => { throw new Error("not used"); },
  });
  const widgetServer = createServer();
  const modelServer = createServer();
  try {
    const bound = await widgetServer._registeredTools.bind_imagegen_project.handler({ projectRoot });
    const projectBindingId = bound.structuredContent.projectBindingId;
    assert.equal(bound.structuredContent.status, "bound");
    assert.match(projectBindingId, /^pbind_[0-9a-f]{64}$/);
    const prepared = await widgetServer._registeredTools.prepare_image_edit_submission.handler({
      projectBindingId,
      parentImageId: PARENT_ID,
      items: [],
      sourcePrompt: "move the highlight",
    });
    assert.equal(prepared.isError, undefined, prepared.content?.[0]?.text);
    const submissionId = prepared.structuredContent.submission.id;

    const firstEdit = await modelServer._registeredTools.edit_image.handler({
      projectBindingId,
      parentImageId: PARENT_ID,
      prompt: "move the highlight",
      submissionId,
    });
    assert.equal(firstEdit.isError, undefined, firstEdit.content?.[0]?.text);
    assert.equal(firstEdit.structuredContent.artifact.id, RESULT_ID);

    const replay = await widgetServer._registeredTools.edit_image.handler({
      projectBindingId,
      parentImageId: PARENT_ID,
      prompt: "move the highlight",
      submissionId,
    });
    assert.equal(replay.isError, undefined, replay.content?.[0]?.text);
    assert.equal(replay.structuredContent.artifact.id, RESULT_ID);
    assert.equal(taskCalls.length, 1);
    assert.equal(taskCalls[0].submissionId, submissionId);
  } finally {
    await Promise.all([widgetServer.close(), modelServer.close()]);
    await rm(root, { recursive: true });
  }
});


test("file host observation state rejects reports outside the frozen contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-host-observation-state-"));
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(artifactRoot);
  const store = createFileHostObservationStore();
  try {
    await assert.rejects(
      store.write({
        context: { artifactRoot, bindingKey: "1".repeat(64) },
        releaseFingerprint: "2".repeat(20),
        report: { arbitrary: "not a host observation report" },
      }),
      (error) => error?.code === "host_observation_state_invalid",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});


test("file host observation state persists the largest valid report", async () => {
  await withHostObservationStore("max-report", async ({ input, store }) => {
    const report = maximalHostObservationReport();
    await store.write({ ...input, report });
    assert.deepEqual(await store.read(input), report);
  });
});


test("reading a missing host observation does not create runtime directories", async () => {
  await withHostObservationStore("read-only", async ({ input, root, store }) => {
    assert.equal(await store.read(input), null);
    await assert.rejects(
      lstat(path.join(root, "artifacts", ".runtime")),
      (error) => error?.code === "ENOENT",
    );
  });
});


test("host observation readers see one complete snapshot during atomic replacement", async () => {
  await withHostObservationStore("concurrent-snapshot", async ({ input, store }) => {
    const small = input.report;
    const large = maximalHostObservationReport();
    await store.write({ ...input, report: small });
    const writer = (async () => {
      for (let index = 0; index < 120; index += 1) {
        await store.write({ ...input, report: index % 2 === 0 ? large : small });
      }
    })();
    const reader = (async () => {
      for (let index = 0; index < 600; index += 1) {
        const report = await store.read(input);
        const fieldCount = report.observations[0].fields.length;
        assert.ok(fieldCount === 0 || fieldCount === 256);
      }
    })();
    await Promise.all([writer, reader]);
  });
});


test("file host observation state fails closed instead of replacing corrupt or linked records", async (t) => {
  await t.test("corrupt record", async () => {
    await withHostObservationStore("corrupt", async ({ input, recordPath, store }) => {
      await store.write(input);
      await writeFile(recordPath, "{", "utf8");
      await assert.rejects(store.read(input), errorWithCode("host_observation_state_invalid"));
      await assert.rejects(store.write(input), errorWithCode("host_observation_state_invalid"));
    });
  });

  await t.test("linked record", async () => {
    await withHostObservationStore("linked", async ({ input, recordPath, root, store }) => {
      await store.write(input);
      const foreignPath = path.join(root, "foreign-observation.json");
      await writeFile(foreignPath, await readFile(recordPath));
      await rm(recordPath);
      await symlink(foreignPath, recordPath, "file");
      await assert.rejects(store.read(input), errorWithCode("host_observation_state_invalid"));
      await assert.rejects(store.write(input), errorWithCode("host_observation_state_invalid"));
    });
  });
});


async function withHostObservationStore(name, callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), `imagegen-host-observation-${name}-`));
  const artifactRoot = path.join(root, "artifacts");
  const bindingKey = "1".repeat(64);
  const releaseFingerprint = "2".repeat(20);
  await mkdir(artifactRoot);
  const input = {
    context: { artifactRoot, bindingKey },
    releaseFingerprint,
    report: {
      provenance: "unverified_widget_report",
      scope: "project_binding_latest",
      observations: [
        { source: "ui/notifications/tool-result", fields: [], errorCodes: [], truncated: false },
        { source: "tools/call", fields: [], errorCodes: [], truncated: false },
      ],
    },
  };
  const recordPath = path.join(
    artifactRoot,
    ".runtime",
    "host-observations",
    bindingKey,
    `${releaseFingerprint}.json`,
  );
  try {
    await callback({ input, recordPath, root, store: createFileHostObservationStore() });
  } finally {
    await rm(root, { recursive: true });
  }
}


function errorWithCode(code) {
  return (error) => error instanceof Error && error.code === code;
}


function maximalHostObservationReport() {
  const fullSegment = `f${"x".repeat(63)}`;
  const tailSegment = `f${"x".repeat(54)}`;
  const fieldPath = `$${Array.from({ length: 7 }, () => `.${fullSegment}`).join("")}.${tailSegment}`;
  const fields = Array.from({ length: 256 }, () => ({
    path: fieldPath,
    type: "string",
    length: 64 * 1024 * 1024,
  }));
  const errorCodes = Array.from({ length: 32 }, (_, index) => (
    `e${String(index).padStart(2, "0")}_${"x".repeat(60)}`
  ));
  return {
    provenance: "unverified_widget_report",
    scope: "project_binding_latest",
    observations: [
      { source: "ui/notifications/tool-result", fields, errorCodes, truncated: true },
      { source: "tools/call", fields, errorCodes, truncated: true },
    ],
  };
}


function configBinding({ projectRoot, artifactRoot, stateRoot }) {
  return Object.freeze({
    userConfigPath: path.join(stateRoot, "config.json"),
    userConfigSha256: "1".repeat(64),
    projectConfigPath: path.join(projectRoot, ".codex", "openai-compatible-imagegen", "config.json"),
    projectConfigSha256: null,
    effectiveConfigJson: "{}",
    effectiveConfigSha256: "2".repeat(64),
    activeProfile: "primary/gpt-image-2",
    runtimeDefaults: Object.freeze({ timeout_seconds: 600, concurrency: 3 }),
    artifactRoot,
  });
}


function artifact(id, operation) {
  return {
    id,
    parentIds: operation === "edit" ? [PARENT_ID] : [],
    childIds: [],
    mimeType: "image/png",
    width: 1,
    height: 1,
    provider: "primary",
    model: "gpt-image-2",
    operation,
    prompt: "cross process fixture",
    parameters: {},
    annotationId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}
