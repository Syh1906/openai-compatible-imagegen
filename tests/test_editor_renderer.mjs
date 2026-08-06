import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { createEditorRenderer } from "../web/editor-renderer.mjs";


function editorState() {
  return {
    image: {
      id: "img_01J00000000000000000000000",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      parentIds: [],
    },
    lineage: [],
    annotations: [],
    activeTool: "select",
    selectedAnnotationId: null,
    color: "#ef4444",
    strokeWidth: 5,
    annotationVisible: true,
    zoom: 1,
    prompt: "",
  };
}

test("inline renderer exposes one bound canvas action per candidate", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  const renderer = createEditorRenderer(root);
  const opened = [];
  const first = editorState().image;
  const second = { ...first, id: "img_01J00000000000000000000001" };

  renderer.renderInline({
    candidates: [
      { ...first, imageUrl: "data:image/png;base64,first-image" },
      { ...second, imageUrl: "data:image/png;base64,second-image" },
    ],
    openingImageId: "",
    inlineStatus: "",
    inlineStatusTone: "neutral",
    onOpen: (imageId) => { opened.push(imageId); },
  });
  const buttons = root.querySelectorAll("[data-action=open-editor]");
  buttons[1].click();

  assert.equal(buttons.length, 2);
  assert.deepEqual(opened, [second.id]);
});

test("editor renderer keeps each annotation as an independent intent editor", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  const renderer = createEditorRenderer(root);
  const editor = editorState();
  editor.annotations = [
    { id: "a1", type: "arrow", x: 0.1, y: 0.1, width: 0.2, height: 0.2, from: { x: 0.1, y: 0.1 }, to: { x: 0.3, y: 0.3 }, points: [], text: "第一处", color: "#ef4444", strokeWidth: 5 },
    { id: "a2", type: "rectangle", x: 0.4, y: 0.4, width: 0.2, height: 0.2, points: [], text: "第二处", color: "#2563eb", strokeWidth: 3 },
  ];

  renderer.mountEditor();
  renderer.updateEditor({
    editor,
    imageUrl: "data:image/png;base64,image-data",
    submissionInFlight: false,
    artifactLoadInFlight: false,
    undoCount: 0,
    redoCount: 0,
    modelCapabilities: { mask: true },
    intentPanelOpen: true,
    submissionStatus: "",
    submissionStatusTone: "neutral",
  });

  assert.equal(root.querySelectorAll("[data-annotation-text]").length, 2);
  assert.equal(root.querySelector("[data-annotation-text=a1]").value, "第一处");
  assert.equal(root.querySelector("[data-annotation-text=a2]").value, "第二处");
  assert.equal(root.querySelector("[data-intent-count]").textContent, "2 处修改意图");
});
