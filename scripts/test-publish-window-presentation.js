"use strict";

const assert = require("assert");
const path = require("path");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const output = path.join(root, "test/.cache/publishWindowPresentation.cjs");

buildSync({
  entryPoints: [
    path.join(root, "src/main/services/publishWindowPresentation.js"),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: output,
});

const {
  hidePublishWindowMenu,
  revealPublishVerificationWindow,
} = require(output);

const calls = [];
const window = {
  isDestroyed: () => false,
  isMinimized: () => true,
  isVisible: () => false,
  removeMenu: () => calls.push(["removeMenu"]),
  setMenuBarVisibility: value => calls.push(["setMenuBarVisibility", value]),
  restore: () => calls.push(["restore"]),
  setAlwaysOnTop: (enabled, level) =>
    calls.push(["setAlwaysOnTop", enabled, level]),
  show: () => calls.push(["show"]),
  moveTop: () => calls.push(["moveTop"]),
  focus: () => calls.push(["focus"]),
};

assert.strictEqual(hidePublishWindowMenu(window), true);
assert.deepStrictEqual(calls.splice(0), [
  ["removeMenu"],
  ["setMenuBarVisibility", false],
]);

assert.strictEqual(revealPublishVerificationWindow(window), true);
assert.deepStrictEqual(calls, [
  ["removeMenu"],
  ["setMenuBarVisibility", false],
  ["restore"],
  ["setAlwaysOnTop", true, "screen-saver"],
  ["show"],
  ["moveTop"],
  ["focus"],
]);

const fallbackCalls = [];
assert.strictEqual(
  hidePublishWindowMenu({
    isDestroyed: () => false,
    setMenu: value => fallbackCalls.push(["setMenu", value]),
    setMenuBarVisibility: value =>
      fallbackCalls.push(["setMenuBarVisibility", value]),
  }),
  true
);
assert.deepStrictEqual(fallbackCalls, [
  ["setMenu", null],
  ["setMenuBarVisibility", false],
]);

assert.strictEqual(
  revealPublishVerificationWindow({ isDestroyed: () => true }),
  false
);

console.log("publish window presentation tests passed");
