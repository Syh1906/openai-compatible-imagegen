import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { revealImageArtifact } from "../mcp/artifact-revealer.mjs";


const IMAGE_ID = "img_01J00000000000000000000000";

test("reveal fails closed when the artifact root is missing or relative", async () => {
  await assert.rejects(revealImageArtifact(IMAGE_ID, { platform: "win32" }), /artifact root is required/i);
  await assert.rejects(
    revealImageArtifact(IMAGE_ID, { artifactRoot: "output/imagegen", platform: "win32" }),
    /artifact root is required/i,
  );
});

test("reveal gives only the artifact root and image ID to the bundled Windows shell helper", async () => {
  const fixture = await createArtifactFixture({ projectName: "workspace 空格, &()" });
  const runtimePath = path.join(fixture.root, "reveal_in_explorer.py");
  const launches = [];

  try {
    const result = await revealImageArtifact(IMAGE_ID, {
      artifactRoot: fixture.dataRoot,
      platform: "win32",
      pythonCommand: "python-test",
      runtimePath,
      spawnProcess(command, args, options) {
        launches.push({ command, args, options });
        return completedChild({
          stdout: '{"status":"revealed","targetSelected":true,"windowVisible":true,"windowForeground":true}\n',
        });
      },
    });

    assert.deepEqual(result, { status: "revealed", imageId: IMAGE_ID });
    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, "python-test");
    assert.deepEqual(launches[0].args, [
      runtimePath,
      "--artifact-root",
      fixture.dataRoot,
      "--image-id",
      IMAGE_ID,
    ]);
    assert.equal(launches[0].args.includes(fixture.imagePath), false);
    assert.equal(launches[0].options.cwd, path.dirname(runtimePath));
    assert.deepEqual(launches[0].options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(launches[0].options.windowsHide, true);
    assert.equal(launches[0].options.env.PYTHONDONTWRITEBYTECODE, "1");
    assert.equal(launches[0].options.env.PYTHONIOENCODING, "utf-8");
  } finally {
    await fixture.dispose();
  }
});

test("reveal rejects a helper response that does not confirm both target selection and window visibility", async () => {
  const fixture = await createArtifactFixture();
  try {
    await assert.rejects(
      revealImageArtifact(IMAGE_ID, {
        artifactRoot: fixture.dataRoot,
        platform: "win32",
        spawnProcess() {
          return completedChild({
            stdout: '{"status":"revealed","targetSelected":true,"windowVisible":false,"windowForeground":true}\n',
          });
        },
      }),
      /confirmation is incomplete/i,
    );
  } finally {
    await fixture.dispose();
  }
});

test("reveal rejects a helper response that selected the target in a background Explorer window", async () => {
  const fixture = await createArtifactFixture();
  try {
    await assert.rejects(
      revealImageArtifact(IMAGE_ID, {
        artifactRoot: fixture.dataRoot,
        platform: "win32",
        spawnProcess() {
          return completedChild({
            stdout: '{"status":"revealed","targetSelected":true,"windowVisible":true,"windowForeground":false}\n',
          });
        },
      }),
      /confirmation is incomplete/i,
    );
  } finally {
    await fixture.dispose();
  }
});

test("reveal terminates a stuck shell helper at the deadline instead of leaving the UI request pending", async () => {
  const fixture = await createArtifactFixture();
  const child = hangingChild();
  try {
    await assert.rejects(
      revealImageArtifact(IMAGE_ID, {
        artifactRoot: fixture.dataRoot,
        platform: "win32",
        helperTimeoutMs: 20,
        helperTerminationGraceMs: 100,
        spawnProcess() {
          return child;
        },
      }),
      /timed out/i,
    );
    assert.deepEqual(child.kills, ["SIGTERM"]);
    assert.equal(child.closed, true);
  } finally {
    await fixture.dispose();
  }
});

test("reveal bounds a helper that ignores both termination signals", async () => {
  const fixture = await createArtifactFixture();
  const child = hangingChild({ closeOnSignal: null, killResult: false });
  try {
    await assert.rejects(
      revealImageArtifact(IMAGE_ID, {
        artifactRoot: fixture.dataRoot,
        platform: "win32",
        helperTimeoutMs: 5,
        helperTerminationGraceMs: 5,
        spawnProcess() {
          return child;
        },
      }),
      /termination was not confirmed/i,
    );
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
    assert.equal(child.closed, false);
  } finally {
    child.dispose();
    await fixture.dispose();
  }
});

test("reveal rejects unsupported platforms without invoking the shell helper", async () => {
  const fixture = await createArtifactFixture();
  let launches = 0;
  const spawnProcess = () => {
    launches += 1;
    return completedChild({ stdout: '{"status":"revealed"}\n' });
  };
  try {
    await assert.rejects(
      revealImageArtifact(IMAGE_ID, { artifactRoot: fixture.dataRoot, platform: "linux", spawnProcess }),
      /not supported/i,
    );
    assert.equal(launches, 0);
  } finally {
    await fixture.dispose();
  }
});

test("reveal reports a stable shell helper startup failure once without leaking a local path", async () => {
  const fixture = await createArtifactFixture();
  let launches = 0;
  try {
    await assert.rejects(
      revealImageArtifact(IMAGE_ID, {
        artifactRoot: fixture.dataRoot,
        platform: "win32",
        spawnProcess() {
          launches += 1;
          return failedStartChild(new Error("launcher failed at C:/Users/private/image.png"));
        },
      }),
      (error) => {
        assert.match(error.message, /failed to start/i);
        assert.equal(error.message.includes("C:/Users/private"), false);
        return true;
      },
    );
    assert.equal(launches, 1);
  } finally {
    await fixture.dispose();
  }
});

test("reveal rejects a shell API failure without leaking helper details", async () => {
  const fixture = await createArtifactFixture();
  try {
    await assert.rejects(
      revealImageArtifact(IMAGE_ID, {
        artifactRoot: fixture.dataRoot,
        platform: "win32",
        spawnProcess() {
          return completedChild({ stderr: "shell_api_failed at C:/Users/private/image.png\n", code: 1 });
        },
      }),
      (error) => {
        assert.match(error.message, /helper failed/i);
        assert.equal(error.message.includes("C:/Users/private"), false);
        return true;
      },
    );
  } finally {
    await fixture.dispose();
  }
});

async function createArtifactFixture({
  projectName = "workspace",
  imageFile = "image.png",
  mimeType = "image/png",
  createImage = true,
  customArtifactRoot = false,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "imagegen-reveal-"));
  const projectRoot = path.join(root, projectName);
  const dataRoot = customArtifactRoot
    ? path.join(root, "custom-image-output")
    : path.join(projectRoot, "output", "imagegen");
  const artifactRoot = path.join(dataRoot, "artifacts", IMAGE_ID);
  const imagePath = path.join(artifactRoot, imageFile);
  await mkdir(artifactRoot, { recursive: true });
  if (createImage && ![".", ".."].includes(imageFile)) await writeFile(imagePath, "image");
  await writeFile(path.join(dataRoot, "index.json"), JSON.stringify({
    version: 1,
    artifacts: {
      [IMAGE_ID]: { id: IMAGE_ID, imageFile, mimeType },
    },
  }));
  return {
    root,
    projectRoot,
    dataRoot,
    imagePath,
    dispose: async () => await rm(root, { recursive: true }),
  };
}

function completedChild({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  queueMicrotask(() => {
    child.emit("spawn");
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code);
  });
  return child;
}

function hangingChild({ closeOnSignal = "SIGTERM", closeDelayMs = 10, killResult = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.closed = false;
  child.kill = (signal) => {
    child.kills.push(signal);
    if (signal === closeOnSignal) {
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.closed = true;
        child.emit("close", null, signal);
      }, closeDelayMs);
    }
    return killResult;
  };
  child.dispose = () => {
    child.stdout.end();
    child.stderr.end();
  };
  return child;
}

function failedStartChild(error) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit("error", error));
  return child;
}
