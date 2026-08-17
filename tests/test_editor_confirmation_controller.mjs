import assert from "node:assert/strict";
import test from "node:test";

import { createEditorConfirmationController } from "../web/editor-confirmation-controller.mjs";


test("confirmation controller opens, traps focus, and restores the trigger on escape", async () => {
  const focusOrder = [];
  const ownerDocument = { activeElement: null };
  const buttons = [
    { focus: () => { ownerDocument.activeElement = buttons[0]; focusOrder.push("cancel"); } },
    { focus: () => { ownerDocument.activeElement = buttons[1]; focusOrder.push("confirm"); } },
  ];
  const dialog = { querySelectorAll: () => buttons };
  const root = {
    ownerDocument,
    querySelector: (selector) => selector === "[data-confirm]"
      ? dialog
      : selector === "[data-cancel]" ? buttons[0] : null,
  };
  let renders = 0;
  const controller = createEditorConfirmationController({
    root,
    dialogSelector: "[data-confirm]",
    triggerSelector: "[data-trigger]",
    cancelSelector: "[data-cancel]",
    render: () => { renders += 1; },
  });
  const trigger = {
    isConnected: true,
    closest: () => trigger,
    focus: () => focusOrder.push("trigger"),
  };

  controller.open({ currentTarget: trigger });
  await Promise.resolve();
  assert.equal(controller.isOpen(), true);
  assert.deepEqual(focusOrder, ["cancel"]);

  assert.equal(controller.handleKeyDown(keyEvent("Tab")), true);
  assert.equal(controller.handleKeyDown(keyEvent("Tab", { shiftKey: true })), true);
  assert.deepEqual(focusOrder, ["cancel", "confirm", "cancel"]);

  assert.equal(controller.handleKeyDown(keyEvent("Escape")), true);
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(focusOrder, ["cancel", "confirm", "cancel", "trigger"]);
  assert.equal(renders, 2);
});

test("confirmation controller ignores keys while closed", () => {
  const controller = createEditorConfirmationController({
    root: { querySelector: () => null },
    dialogSelector: "[data-confirm]",
    triggerSelector: "[data-trigger]",
    cancelSelector: "[data-cancel]",
    render: () => {},
  });

  assert.equal(controller.handleKeyDown(keyEvent("Escape")), false);
  assert.equal(controller.handleKeyDown(keyEvent("Enter")), false);
});

function keyEvent(key, { shiftKey = false } = {}) {
  return { key, shiftKey };
}
