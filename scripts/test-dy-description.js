"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

// 使用项目自带 Electron 的真实编辑事件，不依赖另外安装浏览器。
if (!process.versions.electron) {
  const { spawnSync } = require("child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require("electron");
const pie = require("puppeteer-in-electron");
const puppeteer = require("puppeteer-core");
const { buildSync } = require("esbuild");

const initialization = pie.initialize(app);
const selector = ".zone-container.editor-kit-container";
let browser;
let window;

async function main() {
  const cacheDir = path.join(__dirname, "../test/.cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const bundlePath = path.join(cacheDir, "dyDescription.cjs");
  buildSync({
    entryPoints: [path.join(__dirname, "../src/main/services/upLoad/dyDescription.js")],
    outfile: bundlePath,
    bundle: true,
    minify: true,
    platform: "node",
    format: "cjs",
  });
  const { replaceDyDescription } = require(bundlePath);

  await initialization;
  await app.whenReady();
  browser = await pie.connect(app, puppeteer);
  window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  await window.loadURL("about:blank");
  const page = await pie.getPage(browser, window);

  async function fixture(html, { blockDelete = false, corruptText = false, editable = true } = {}) {
    await page.setContent(`<!doctype html><meta charset="utf-8">
      <input class="semi-input" value="原短标题">
      <div class="zone-container editor-kit-container" contenteditable="${editable}" style="min-height:120px;width:500px"></div>
      <button id="publish">发布</button>`);
    await page.$eval(selector, (editor, options) => {
      editor.innerHTML = options.html;
      window.model = editor.innerText;
      window.inputEvents = 0;
      window.published = 0;
      window.topicsCommitted = 0;
      editor.addEventListener("beforeinput", event => {
        if (options.blockDelete && event.inputType.startsWith("delete")) event.preventDefault();
      });
      editor.addEventListener("input", () => {
        window.model = editor.innerText;
        window.inputEvents += 1;
      });
      editor.addEventListener("keyup", event => {
        if (event.code !== "Space") return;
        if (options.corruptText) editor.textContent = "错误配文";
        else if (/#\S+\s$/.test(editor.innerText)) {
          // 模拟平台把以空格结束的话题转为不可编辑胶囊。
          const parts = editor.innerText.split(/(#[^\s]+)/);
          editor.replaceChildren(...parts.map(part => {
            if (!part.startsWith("#")) return document.createTextNode(part);
            const topic = document.createElement("span");
            topic.contentEditable = "false";
            topic.textContent = part;
            return topic;
          }));
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          window.topicsCommitted += 1;
        }
        window.model = editor.innerText;
      });
      document.querySelector("#publish").addEventListener("click", () => { window.published += 1; });
    }, { html, blockDelete, corruptText });
  }

  function normalize(value) {
    return value.replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
  }
  async function assertText(expected) {
    const state = await page.$eval(selector, editor => ({
      text: editor.innerText,
      model: window.model,
      title: document.querySelector(".semi-input").value,
      inputEvents: window.inputEvents,
    }));
    assert.strictEqual(normalize(state.text), normalize(expected));
    assert.strictEqual(normalize(state.model), normalize(expected));
    assert.strictEqual(state.title, "原短标题");
    assert.ok(state.inputEvents > 0, "必须通过原生编辑事件同步编辑器状态");
  }

  const caption = "平凡人也能把日子经营妥当";
  const cases = [
    ["恢复的两份正文只保留一份，连续重发三次也不叠加", async () => {
      await fixture(`<p>${caption}</p><p>${caption}</p>`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await replaceDyDescription(page, { bt2: caption });
        await assertText(caption);
      }
    }],
    ["清除多段旧正文、旧话题胶囊和零宽占位符，保留新正文及最后一个话题", async () => {
      await fixture('<p>旧正文🙂</p><p><span contenteditable="false">#旧话题</span>\u200b</p>');
      await replaceDyDescription(page, { bt2: "新正文🙂\n第二行", bq: "#工厂 #日常" });
      await assertText("新正文🙂 第二行 #工厂 #日常");
      assert.ok(await page.evaluate(() => window.topicsCommitted > 0));
    }],
    ["空正文清除恢复内容，支持首次发布仅有短标题", async () => {
      await fixture(`<p>${caption}</p>`);
      await replaceDyDescription(page, {});
      await assertText("");
    }],
    ["空编辑器正常填写，保留配文内重复词句", async () => {
      await fixture("<p>\u200b<br></p>");
      await replaceDyDescription(page, { bt2: "加油 加油！", bq: "#日常" });
      await assertText("加油 加油！ #日常");
    }],
    ["清空受阻时停止，不向旧正文插入新文字", async () => {
      await fixture(`<p>${caption}</p>`, { blockDelete: true });
      await assert.rejects(replaceDyDescription(page, { bt2: "新配文" }),
        error => error.nonRetryable === true && /旧正文未清空/.test(error.message));
      assert.strictEqual(normalize(await page.$eval(selector, editor => editor.innerText)), caption);
      assert.strictEqual(normalize(await page.evaluate(() => window.model)), caption);
      assert.strictEqual(await page.evaluate(() => window.inputEvents), 0);
    }],
    ["填写结果不一致时停止，阻止继续提交", async () => {
      await fixture("<p><br></p>", { corruptText: true });
      await assert.rejects(async () => {
        await replaceDyDescription(page, { bt2: caption });
        await page.click("#publish");
      }, error => error.nonRetryable === true && /与待发布配文不一致/.test(error.message));
      assert.strictEqual(await page.evaluate(() => window.published), 0);
    }],
    ["未获得编辑焦点时停止，保护其它表单内容", async () => {
      await fixture("旧正文", { editable: false });
      await assert.rejects(replaceDyDescription(page, { bt2: caption }),
        error => error.nonRetryable === true && /未获得焦点/.test(error.message));
      assert.strictEqual(await page.$eval(".semi-input", input => input.value), "原短标题");
    }],
  ];
  for (const [name, run] of cases) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`test-dy-description passed (${cases.length} cases, minified bundle, Electron Chromium)`);
}

main().then(() => {
  browser?.disconnect();
  window?.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  browser?.disconnect();
  window?.destroy();
  app.exit(1);
});
