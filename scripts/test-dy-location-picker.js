"use strict";

require("@babel/register")({ extensions: [".js"], ignore: [/node_modules/] });
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { inspectDyLocationPick, pickFirstDyLocation } = require("../src/main/services/upLoad/dyLocationPicker.js");

// 浏览器回调使用可控的 DOM 和时钟执行，覆盖选项顺序及点击后的真实状态转换。
class Element {
  constructor(tag, attrs = {}, text = "", top = 0, height = 30) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.text = text;
    this.children = [];
    this.parentElement = null;
    this.top = top;
    this.height = height;
    this.hidden = false;
  }
  get className() { return this.attrs.class || ""; }
  get classList() { return { contains: (name) => this.className.split(/\s+/).includes(name) }; }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...children) { children.forEach((child) => { child.parentElement = this; this.children.push(child); }); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (value.startsWith(".")) return this.classList.contains(value.slice(1));
      const attr = /^\[([\w-]+)(?:(\*=|=)'([^']*)')?\]$/.exec(value);
      if (attr) {
        const actual = this.getAttribute(attr[1]);
        return actual != null && (!attr[2] || (attr[2] === "=" ? actual === attr[3] : actual.includes(attr[3])));
      }
      return this.tagName === value.toUpperCase();
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")])
      .filter((node) => selector === "*" || node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  scrollIntoView() {}
  getBoundingClientRect() {
    let hidden = false;
    for (let node = this; node; node = node.parentElement) hidden ||= node.hidden;
    return { left: 100, right: 500, top: this.top, bottom: this.top + this.height, width: hidden ? 0 : 400, height: hidden ? 0 : this.height };
  }
}

function fixture(names = ["东风康明斯", "东风康明斯发动机有限公司"]) {
  const keyword = "东风康明斯发动机有限公司";
  const body = new Element("body");
  // 来自实际发布页：城市 item 与地点 listbox 是兄弟节点，搜索 input 位于 semi-select 内。
  const scope = new Element("div", { class: "anchor-item-UTleEn" }, "", 100, 430);
  const control = new Element("div", { class: "semi-select semi-select-open" }, "", 100, 32);
  const label = new Element("span", { class: "semi-select-selection-text semi-select-selection-placeholder" }, "输入地理位置", 100, 30);
  const input = new Element("input", { "data-mm-dy-location": "1", "aria-controls": "poi-results" }, "", 100);
  input.value = keyword;
  control.append(label, input);
  const popup = new Element("div", { class: "select-dropdown-v2-_MsMmv" }, "", 132, 300);
  const tabs = new Element("div", { class: "tab-_dqQ4l" }, "", 132, 26);
  const city = new Element("div", { class: "item-container-EH81ZP" }, "武汉", 132, 26);
  tabs.append(city);
  const list = new Element("div", { role: "listbox", id: "poi-results", class: "semi-select-option-list" }, "", 160, 260);
  const addOption = (name, i) => {
    const row = new Element("div", { class: "semi-select-option option-v2-_HHRPT", role: "option" }, "", 160 + i * 60, 54);
    row.append(new Element("div", { class: "name-QUhTI4" }, name, row.top + 4, 16), new Element("div", { class: "address-rO52tq" }, "湖北省襄阳市", row.top + 30, 16));
    list.append(row);
    return row;
  };
  const rows = names.map(addOption);
  popup.append(tabs, list);
  scope.append(control, popup);
  body.append(new Element("div", { class: "form-item" }, "关联热点", 135), scope);
  const document = {
    activeElement: null,
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelectorAll(selector)[0] || null,
    getElementById: (id) => body.querySelectorAll("*").find((node) => node.getAttribute("id") === id) || null,
    elementFromPoint: (x, y) => body.querySelectorAll("*").reverse().find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width && rect.height && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }) || null,
  };
  input.blur = () => { document.activeElement = null; };
  const state = { keyword, body, input, popup, rows, document, control, label, list, city, addOption, clicks: [], searches: 0, resets: 0 };
  state.accept = ({ keepInput = false, selected = state.clicks[0] } = {}) => {
    popup.hidden = true;
    control.setAttribute("class", "semi-select");
    label.setAttribute("class", "semi-select-selection-text");
    label.text = selected;
    if (!keepInput && input.parentElement) {
      input.parentElement.children = input.parentElement.children.filter((child) => child !== input);
      input.parentElement = null;
    }
  };
  return state;
}

async function withPage(state, onClick, action) {
  const original = { document: global.document, window: global.window, now: Date.now };
  let now = 0;
  global.document = state.document;
  global.window = { getComputedStyle: (node) => ({ display: "block", visibility: "visible", cursor: node.cursor || "auto" }) };
  Date.now = () => now;
  const page = {
    $: async (selector) => {
      const element = state.document.querySelector(selector);
      return element ? { focus: async () => { if (!state.blockFocus) state.document.activeElement = element; } } : null;
    },
    evaluate: async (callback, args) => vm.runInNewContext(`(${callback.toString()})`, {
      document: state.document,
      window: global.window,
    })(args),
    waitForTimeout: async (ms) => { now += ms; state.onWait?.(now); },
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async (key) => {
        if (key === "KeyA") state.searchSelected = state.document.activeElement === state.input;
        if (key === "Backspace" && state.searchSelected && !state.blockClear) state.input.value = "";
        if (key === "Escape") {
          state.popup.hidden = true;
          state.control.setAttribute("class", "semi-select");
        }
      },
    },
    mouse: { click: async (x, y) => { const hit = state.document.elementFromPoint(x, y); state.clicks.push(hit?.closest("[role='option']")?.querySelector("[class*='name-']")?.textContent || hit?.textContent); onClick(); } },
  };
  try { await action(page); }
  finally { global.document = original.document; global.window = original.window; Date.now = original.now; }
}

function loadRetry(page, state, selectOverride) {
  const source = fs.readFileSync(path.join(__dirname, "../src/main/services/upLoad/dy.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("async function selectDyLocationWithRetry(");
  const end = source.indexOf("\nexport default", start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    DY_LOCATION_ATTEMPTS: 3,
    DY_LOCATION_PICK_TIMEOUT_MS: 500,
    selectDyLocation: selectOverride || (async () => { state.searches += 1; return pickFirstDyLocation(page, state.keyword, { timeoutMs: 500 }); }),
    resetDyLocationAttempt: async () => { state.resets += 1; },
    throwIfPublishCanceled() {},
    console,
  });
}

async function main() {
  const tests = [
    ["第一条无需包含完整关键词，第二条完全匹配也不能抢先", async () => {
      const state = fixture(["襄阳康明斯", "东风康明斯发动机有限公司"]);
      await withPage(state, () => { state.accept(); }, async (page) => {
        const picked = await pickFirstDyLocation(page, state.keyword);
        assert.strictEqual(picked.label, "襄阳康明斯");
        assert.deepStrictEqual(state.clicks, ["襄阳康明斯"]);
      });
    }],
    ["短名称的第一条数据也必须保留，城市筛选和表单项不算结果", async () => {
      const state = fixture(["康明", "东风康明斯发动机有限公司"]);
      await withPage(state, () => { state.accept(); }, async (page) => {
        assert.strictEqual((await pickFirstDyLocation(page, state.keyword)).label, "康明");
      });
    }],
    ["城市item即便带option角色，也不能越过地点listbox被点选", async () => {
      const state = fixture();
      state.city.setAttribute("role", "option");
      await withPage(state, () => { state.accept(); }, async (page) => {
        assert.strictEqual((await pickFirstDyLocation(page, state.keyword)).label, "东风康明斯");
        assert.deepStrictEqual(state.clicks, ["东风康明斯"]);
      });
    }],
    ["候选层关闭但仍是占位符时不能误报选中", async () => {
      const state = fixture();
      await withPage(state, () => {
        state.popup.hidden = true;
        state.control.setAttribute("class", "semi-select");
        state.input.removeAttribute("data-mm-dy-location");
      }, async (page) => {
        await assert.rejects(loadRetry(page, state)(page, { data: { address: state.keyword } }), (error) => error.nonRetryable === true);
        assert.strictEqual(state.clicks.length, 1);
      });
    }],
    ["显示的已选名称与点击首条不符时必须停止发布", async () => {
      const state = fixture();
      await withPage(state, () => { state.accept({ selected: "其它地址" }); }, async (page) => {
        await assert.rejects(loadRetry(page, state)(page, { data: { address: state.keyword } }), (error) => error.nonRetryable === true);
        assert.strictEqual(state.clicks.length, 1);
      });
    }],
    ["候选层向上展开时仍按列表第一条选择", async () => {
      const state = fixture();
      state.input.top = 450;
      await withPage(state, () => { state.accept(); }, async (page) => {
        assert.strictEqual((await pickFirstDyLocation(page, state.keyword)).label, "东风康明斯");
      });
    }],
    ["点选后旧输入框消失仍首轮成功，不重新搜索三次", async () => {
      const state = fixture();
      await withPage(state, () => { state.accept(); state.input.removeAttribute("data-mm-dy-location"); }, async (page) => {
        const result = await loadRetry(page, state)(page, {});
        assert.strictEqual(result.selected, true);
        assert.strictEqual(state.searches, 1);
        assert.strictEqual(state.resets, 0);
        assert.strictEqual(state.clicks.length, 1);
      });
    }],
    ["地点选中后保留搜索文字也能确认，不要求输入框清空", async () => {
      const state = fixture();
      await withPage(state, () => { state.accept({ keepInput: true }); }, async (page) => {
        assert.strictEqual((await pickFirstDyLocation(page, state.keyword)).selected, true);
        assert.strictEqual(state.input.value, state.keyword);
      });
    }],
    ["候选层延迟关闭时持续确认，不因700毫秒快照误重试", async () => {
      const state = fixture();
      state.onWait = (now) => { if (now >= 1_200) state.accept(); };
      await withPage(state, () => {}, async (page) => {
        assert.strictEqual((await loadRetry(page, state)(page, {})).selected, true);
        assert.strictEqual(state.searches, 1);
        assert.strictEqual(state.clicks.length, 1);
      });
    }],
    ["等待异步搜索数据后选择第一条，加载期间不点城市筛选", async () => {
      const state = fixture([]);
      let loaded = false;
      state.onWait = (now) => {
        if (!loaded && now >= 600) {
          loaded = true;
          state.addOption("首条搜索数据", 0);
        }
      };
      await withPage(state, () => { state.accept(); }, async (page) => {
        assert.strictEqual((await pickFirstDyLocation(page, state.keyword)).label, "首条搜索数据");
        assert.deepStrictEqual(state.clicks, ["首条搜索数据"]);
      });
    }],
    ["已填写地址但点选未确认时必须报错，不能继续发布或换选", async () => {
      const state = fixture();
      await withPage(state, () => {}, async (page) => {
        await assert.rejects(loadRetry(page, state)(page, { data: { address: state.keyword } }), (error) => error.dyLocationSelectionAttempted === true && error.nonRetryable === true);
        assert.strictEqual(state.searches, 1);
        assert.strictEqual(state.resets, 0);
        assert.strictEqual(state.clicks.length, 1);
      });
    }],
    ["没有填写地址时正常跳过，不影响普通发布", async () => {
      const state = fixture();
      await withPage(state, () => {}, async (page) => {
        const source = fs.readFileSync(path.join(__dirname, "../src/main/services/upLoad/dy.js"), "utf8").replace(/\r\n/g, "\n");
        const start = source.indexOf("async function selectDyLocation(");
        const end = source.indexOf("\nasync function setDyPlatformSchedule", start);
        const select = vm.runInNewContext(`(${source.slice(start, end).trim()})`, { DY_LOCATION_PICK_TIMEOUT_MS: 500, console });
        const result = await loadRetry(page, state, select)(page, {});
        assert.strictEqual(result.selected, false);
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(state.searches, 0);
        assert.strictEqual(state.clicks.length, 0);
      });
    }],
    ["等待后仍没有搜索结果时清空搜索词并跳过地点，不中断发布", async () => {
      const state = fixture([]);
      await withPage(state, () => { throw new Error("没有结果时不能点击"); }, async (page) => {
        const result = await loadRetry(page, state)(page, { data: { address: state.keyword } });
        assert.strictEqual(result.selected, false);
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.reason, "no-search-options");
        assert.strictEqual(state.input.value, "");
        assert.strictEqual(state.control.classList.contains("semi-select-open"), false);
        assert.strictEqual(state.label.classList.contains("semi-select-selection-placeholder"), true);
        assert.strictEqual(state.searches, 1);
        assert.strictEqual(state.resets, 0);
        assert.strictEqual(state.clicks.length, 0);
      });
    }],
    ["搜索框丢失属于控件异常，不能按无搜索结果跳过", async () => {
      const state = fixture([]);
      state.input.removeAttribute("data-mm-dy-location");
      await withPage(state, () => { throw new Error("不能点击"); }, async (page) => {
        await assert.rejects(loadRetry(page, state)(page, {}),
          error => error.nonRetryable === true && /search-input-missing/.test(error.message));
        assert.strictEqual(state.searches, 3);
        assert.strictEqual(state.input.value, state.keyword);
      });
    }],
    ["无结果但搜索词清空失败时停止，不重新搜索或继续发布", async () => {
      const state = fixture([]);
      state.blockClear = true;
      await withPage(state, () => { throw new Error("不能点击"); }, async (page) => {
        await assert.rejects(loadRetry(page, state)(page, {}),
          error => error.nonRetryable === true && /清理抖音地点失败/.test(error.message));
        assert.strictEqual(state.input.value, state.keyword);
        assert.strictEqual(state.searches, 1);
        assert.strictEqual(state.resets, 0);
      });
    }],
    ["清理前必须确认搜索框焦点，避免删除其它表单内容", async () => {
      const state = fixture([]);
      state.blockFocus = true;
      await withPage(state, () => { throw new Error("不能点击"); }, async (page) => {
        await assert.rejects(loadRetry(page, state)(page, {}),
          error => error.nonRetryable === true && /未获得焦点/.test(error.message));
        assert.strictEqual(state.input.value, state.keyword);
        assert.strictEqual(state.searchSelected, undefined);
      });
    }],
    ["恢复的已选地点未清除时不能假装无地点发布", async () => {
      const state = fixture([]);
      state.label.setAttribute("class", "semi-select-selection-text");
      state.label.text = "旧地点";
      await withPage(state, () => { throw new Error("不能点击"); }, async (page) => {
        await assert.rejects(loadRetry(page, state)(page, {}),
          error => error.nonRetryable === true && /清理抖音地点失败/.test(error.message));
        assert.strictEqual(state.searches, 1);
      });
    }],
    ["第一条被遮挡时不能越过它选择第二条", async () => {
      const state = fixture();
      state.document.elementFromPoint = () => new Element("div", { class: "overlay" });
      await withPage(state, () => {}, async (page) => {
        await assert.rejects(pickFirstDyLocation(page, state.keyword, { timeoutMs: 500 }), /first-option-covered/);
        assert.strictEqual(state.clicks.length, 0);
      });
    }],
    ["结果曾被遮挡后消失时仍报错，不能按无搜索结果放行", async () => {
      const state = fixture();
      state.document.elementFromPoint = () => new Element("div", { class: "overlay" });
      state.onWait = () => { state.list.children = []; };
      await withPage(state, () => { throw new Error("不能点击"); }, async (page) => {
        await assert.rejects(pickFirstDyLocation(page, state.keyword, { timeoutMs: 500 }), /first-option-covered/);
        assert.strictEqual(state.input.value, state.keyword);
      });
    }],
  ];
  for (const [name, action] of tests) { await action(); console.log(`PASS ${name}`); }
  console.log(`test-dy-location-picker passed (${tests.length} cases)`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
