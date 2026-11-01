"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
});

const assert = require("assert");
const {
  isDefaultPublishToDraftEnabled,
  normalizeAccountPublishSettings,
  resolveEffectivePublishMode,
  updateAccountTreePublishSettings,
} = require("../src/shared/accountPublishSettings");

assert.deepStrictEqual(normalizeAccountPublishSettings({}), {
  defaultPublishToDraft: false,
  useRealBrowser: false,
});
assert.deepStrictEqual(
  normalizeAccountPublishSettings({ defaultPublishToDraft: true }),
  { defaultPublishToDraft: true, useRealBrowser: false }
);

assert.strictEqual(isDefaultPublishToDraftEnabled({}), false);
assert.strictEqual(
  isDefaultPublishToDraftEnabled({ defaultPublishToDraft: true }),
  true
);

assert.deepStrictEqual(resolveEffectivePublishMode(false, {}), {
  publishMode: "publish",
  publishToDraft: false,
});
assert.deepStrictEqual(
  resolveEffectivePublishMode(false, { defaultPublishToDraft: true }),
  {
    publishMode: "draft",
    publishToDraft: true,
  }
);
assert.deepStrictEqual(resolveEffectivePublishMode(true, {}), {
  publishMode: "draft",
  publishToDraft: true,
});

const accountTree = {
  13800138000: {
    children: [
      { meta: { pt: "小红书", phone: "13800138000", defaultPublishToDraft: false, useRealBrowser: true } },
      { meta: { pt: "抖音", phone: "13800138000", defaultPublishToDraft: false } },
    ],
  },
};
const nextTree = updateAccountTreePublishSettings(accountTree, {
  phone: "13800138000-备注",
  pt: "小红书",
  defaultPublishToDraft: true,
});
assert.strictEqual(
  nextTree["13800138000"].children[0].meta.defaultPublishToDraft,
  true
);
assert.strictEqual(
  nextTree["13800138000"].children[1].meta.defaultPublishToDraft,
  false
);
assert.strictEqual(
  accountTree["13800138000"].children[0].meta.defaultPublishToDraft,
  false
);

assert.strictEqual(nextTree["13800138000"].children[0].meta.useRealBrowser, true);
const disabledBrowser = updateAccountTreePublishSettings(nextTree, {
  phone: "13800138000", pt: "小红书", defaultPublishToDraft: true, useRealBrowser: false,
});
assert.strictEqual(disabledBrowser["13800138000"].children[0].meta.useRealBrowser, false);
assert.strictEqual(nextTree["13800138000"].children[0].meta.useRealBrowser, true);

console.log("test-account-publish-settings passed");
