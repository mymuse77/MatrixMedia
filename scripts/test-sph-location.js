"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
});

const assert = require("assert");
const {
  applySphLocation,
  getSphLocationValue,
} = require("../src/main/services/upLoad/sphLocation");

assert.strictEqual(
  getSphLocationValue({ data: { address: "上海市" } }),
  "上海市",
);
assert.strictEqual(
  getSphLocationValue({ data: { location: "杭州市" } }),
  "杭州市",
);
assert.strictEqual(getSphLocationValue({}), "");

async function main() {
  let evaluateCalls = 0;
  const skipped = await applySphLocation(
    {
      evaluate: async () => {
        evaluateCalls += 1;
        return { ok: true };
      },
      waitForTimeout: async () => {},
    },
    { data: {} },
  );
  assert.deepStrictEqual(skipped, { selected: false, skipped: true });
  assert.strictEqual(evaluateCalls, 0);

  const responses = [
    { ok: true, alreadyOpen: false },
    { ok: true },
    { ok: true },
    { ok: true },
    { ok: true, label: "上海市人民广场" },
  ];
  const selected = await applySphLocation(
    {
      evaluate: async () => responses.shift(),
      waitForTimeout: async () => {},
    },
    { data: { address: "上海市" } },
  );
  assert.deepStrictEqual(selected, {
    selected: true,
    label: "上海市人民广场",
  });
  assert.strictEqual(responses.length, 0);

  console.log("test-sph-location passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
