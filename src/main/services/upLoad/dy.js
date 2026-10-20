import path from "path";
import maybeClosePublishWindow from "./closeWindow.js";
import { resolveDyCreativeStatementLabel } from "../../../shared/creativeStatement.js";
import {
  WAIT_SELECTOR_APPEAR_MS,
  pollPageUntil,
  throwIfPublishCanceled,
} from "./uploadTimeouts.js";
import { waitForDyUploadProcessing } from "./dyUploadState.js";
import {
  findDyUploadInput,
  inspectDyPublishPage,
  waitForDyUploadPageReady,
} from "./dyPageState.js";
import { capturePublishFailureDiagnostics } from "./publishDiagnostics.js";
import {
  resolveDyPublishConfirmationTimeoutMs,
  waitForDyPublishConfirmation,
} from "./dyPublishConfirmation.js";
import { revealPublishVerificationWindow } from "../publishWindowPresentation.js";
import { inspectDyLocationPick, pickFirstDyLocation } from "./dyLocationPicker.js";
import { replaceDyDescription } from "./dyDescription.js";

const DY_PREFLIGHT_TIMEOUT_MS = 60 * 1000;
const DY_UPLOAD_INPUT_TIMEOUT_MS = 60 * 1000;
const DY_LOCATION_ATTEMPTS = 3;
const DY_LOCATION_PICK_TIMEOUT_MS = 15 * 1000;

function revealDyVerificationWindow(window) {
  try {
    return revealPublishVerificationWindow(window);
  } catch (error) {
    console.warn("[dy] 显示抖音短信验证窗口失败:", error?.message || error);
    return false;
  }
}

async function selectDyCreativeStatement(page, data) {
  const value = data.data && data.data.creativeStatement;
  console.log("[dy] creativeStatement 值 =", value);
  // 注意：「无标注」对应抖音「无需添加自主声明」，也必须主动点选，不能跳过
  const label = resolveDyCreativeStatementLabel(value);
  console.log("[dy] 准备选择自主声明:", label);

  const opened = await page.evaluate(() => {
    const norm = (t) => String(t).replace(/\s+/g, "").trim();
    const keywords = ["请选择自主声明", "添加自主声明", "自主声明"];
    const isSelectText = (el) => {
      const cls = el.className;
      if (typeof cls !== "string") return false;
      return cls.split(/\s+/).some((c) => c.startsWith("selectText-"));
    };
    for (const el of document.querySelectorAll("[class]")) {
      if (!isSelectText(el)) continue;
      const text = norm(el.textContent);
      if (!keywords.some((k) => text.includes(norm(k)))) continue;
      el.click();
      return true;
    }
    for (const el of document.querySelectorAll(
      "span, div, label, [role='button'], .semi-select"
    )) {
      const text = norm(el.textContent);
      if (!keywords.some((k) => text.includes(norm(k)))) continue;
      if (text.length > 24) continue;
      el.click();
      return true;
    }
    return false;
  });
  if (!opened) {
    throw new Error("未找到抖音「请选择自主声明」入口");
  }

  await pollPageUntil(
    page,
    () => {
      const option = document.querySelector(".semi-modal-body .semi-radio-addon");
      if (!option) return false;
      const style = window.getComputedStyle(option);
      const rect = option.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    },
    WAIT_SELECTOR_APPEAR_MS,
    500,
    "未找到抖音自主声明选项",
  );

  const picked = await page.evaluate((text) => {
    const modal = document.querySelector(".semi-modal-body");
    if (!modal) return false;
    for (const addon of modal.querySelectorAll(".semi-radio-addon")) {
      if (addon.textContent.trim() !== text) continue;
      const labelEl = addon.closest("label.semi-radio");
      if (labelEl) {
        labelEl.click();
        return true;
      }
    }
    return false;
  }, label);

  if (!picked) {
    throw new Error(`未找到抖音自主声明选项: ${label}`);
  }
  await page.waitForTimeout(400);

  // 点击弹窗里的「确认」按钮提交声明
  const confirmed = await page.evaluate(() => {
    const modal = document.querySelector(".semi-modal-body");
    const root = modal ? modal.closest(".semi-modal") || modal : document;
    const btn = root.querySelector(".semi-button.semi-button-primary");
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (!confirmed) {
    throw new Error("未找到抖音自主声明确认按钮");
  }
  console.log("[dy] 已点击声明确认按钮");
  await page.waitForTimeout(400);
}

async function selectDyCreativeStatementWithRetry(page, data, maxMs = 60000) {
  const deadline = Date.now() + maxMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await selectDyCreativeStatement(page, data);
      return;
    } catch (e) {
      throwIfPublishCanceled(page);
      lastErr = e;
      await page.waitForTimeout(2000);
    }
  }
  throw lastErr || new Error("抖音自主声明选择失败");
}

async function clickDyPublish(page, isDraftMode, beforeSubmit) {
  const submitSelector = isDraftMode
    ? "#popover-tip-container+button"
    : "#popover-tip-container";
  const hasSubmitButton = isDraftMode
    ? () => !!document.querySelector("#popover-tip-container+button")
    : () => !!document.querySelector("#popover-tip-container");
  await pollPageUntil(
    page,
    hasSubmitButton,
    WAIT_SELECTOR_APPEAR_MS,
    500,
    "未找到抖音发布按钮",
  );
  const submitBtn = await page.$(submitSelector);
  if (!submitBtn) throw new Error("未找到抖音发布按钮");
  throwIfPublishCanceled(page);
  beforeSubmit?.();
  await submitBtn.click({ delay: 200 });
  console.log(
    isDraftMode
      ? "[dy] 已点击存草稿按钮 (#popover-tip-container+button)"
      : "[dy] 已点击发布入口 (#popover-tip-container)"
  );
}

/**
 * 地理位置（截图结构）：
 *   扩展信息
 *     添加标签  [ 位置 ▾ ]  [ placeholder=输入地理位置 ]  ← 目标
 *     关联热点  ...
 *
 * 流程：滚到扩展区 → 定位该 input → 输入 → 点选下拉 POI
 * 注意：不要乱点扩展区其它控件，避免跳转到内容管理「搜索作品」。
 */
async function selectDyLocation(
  page,
  data,
  { pickTimeoutMs = DY_LOCATION_PICK_TIMEOUT_MS } = {},
) {
  const location = String(
    data?.data?.address ||
      data?.data?.location ||
      data?.address ||
      data?.location ||
      "",
  ).trim();
  if (!location) {
    console.log("[dy] 未提供 address/location，跳过地理位置");
    return { selected: false, skipped: true };
  }
  // 在中间栏 overflow 容器内滚动，直到出现「添加标签 / 输入地理位置」
  const revealLocationSection = async () => {
    await page
      .evaluate(() => {
        const norm = (v) =>
          String(v || "")
            .replace(/\s+/g, "")
            .trim();

        const scrollParents = (el) => {
          const list = [];
          let p = el;
          while (p && p !== document.documentElement) {
            if (p instanceof HTMLElement) {
              const st = window.getComputedStyle(p);
              const oy = st.overflowY || st.overflow;
              if (
                (oy === "auto" || oy === "scroll" || oy === "overlay") &&
                p.scrollHeight > p.clientHeight + 20
              ) {
                list.push(p);
              }
            }
            p = p.parentElement;
          }
          const se =
            document.scrollingElement ||
            document.documentElement ||
            document.body;
          if (se) list.push(se);
          return list;
        };

        // 优先滚到短文案节点
        for (const el of document.querySelectorAll(
          "div, span, label, section, h2, h3, input",
        )) {
          const raw = String(el.textContent || "").trim();
          const t = norm(raw);
          const ph = (el.getAttribute && el.getAttribute("placeholder")) || "";
          if (
            ((t === "扩展信息" || t === "添加标签" || t === "输入地理位置") &&
              raw.length < 24) ||
            /输入地理位置|地理位置/.test(ph)
          ) {
            try {
              el.scrollIntoView({ block: "center", inline: "nearest" });
            } catch (_) {
              /* ignore */
            }
            for (const sp of scrollParents(el)) {
              try {
                const r = el.getBoundingClientRect();
                const pr = sp.getBoundingClientRect();
                sp.scrollTop += r.top - pr.top - pr.height * 0.25;
              } catch (_) {
                /* ignore */
              }
            }
            return "hit";
          }
        }

        // 否则所有可滚容器下滚
        const boxes = new Set();
        for (const el of document.querySelectorAll("div, main, section")) {
          if (!(el instanceof HTMLElement)) continue;
          const st = window.getComputedStyle(el);
          const oy = st.overflowY || st.overflow;
          if (
            (oy === "auto" || oy === "scroll" || oy === "overlay") &&
            el.scrollHeight > el.clientHeight + 40
          ) {
            boxes.add(el);
          }
        }
        const se =
          document.scrollingElement ||
          document.documentElement ||
          document.body;
        if (se) boxes.add(se);
        for (const c of boxes) {
          try {
            c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + 480);
          } catch (_) {
            /* ignore */
          }
        }
        return "scroll";
      })
      .catch(() => {});
    try {
      await page.mouse.wheel({ deltaY: 600 });
    } catch (_) {
      /* ignore */
    }
  };

  // 浏览器内：按截图结构 mark 地理位置 input
  const markLocationInput = () => {
    document
      .querySelectorAll("[data-mm-dy-location]")
      .forEach((el) => el.removeAttribute("data-mm-dy-location"));

    const isVisible = (el) => {
      if (!el || el.disabled) return false;
      const st = window.getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width >= 30 && r.height >= 10;
    };

    const phOf = (el) =>
      `${el.getAttribute("placeholder") || ""} ${
        el.getAttribute("aria-label") || ""
      }`;

    const isTitleLike = (el) =>
      /标题|售价|付费|流量|热点|合集|搜索作品/.test(phOf(el));

    const isGeoPh = (ph) =>
      /输入地理位置|地理位置|输入位置|搜索位置/.test(String(ph || ""));

    const mark = (el, how) => {
      el.setAttribute("data-mm-dy-location", "1");
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_) {
        /* ignore */
      }
      return {
        how,
        ph: el.getAttribute("placeholder") || "",
        w: Math.round(el.getBoundingClientRect().width),
      };
    };

    const textInputs = (root = document) =>
      [
        ...root.querySelectorAll(
          "input, textarea, [contenteditable='true'], [role='textbox']",
        ),
      ].filter((el) => {
        if (el.tagName === "INPUT") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (
            ["file", "hidden", "checkbox", "radio", "button", "submit"].includes(
              type,
            )
          ) {
            return false;
          }
        }
        return isVisible(el) && !isTitleLike(el);
      });

    // A. placeholder = 输入地理位置（截图确认）
    for (const el of textInputs()) {
      if (isGeoPh(el.getAttribute("placeholder") || "")) {
        return mark(el, "placeholder:输入地理位置");
      }
    }
    for (const el of document.querySelectorAll("[placeholder]")) {
      if (!isGeoPh(el.getAttribute("placeholder") || "")) continue;
      if (!isVisible(el)) continue;
      if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        el.getAttribute("role") === "textbox"
      ) {
        if (!isTitleLike(el)) return mark(el, "placeholder-attr");
      }
      const inner = textInputs(el)[0];
      if (inner && isVisible(inner) && !isTitleLike(inner)) {
        return mark(inner, "placeholder-wrap");
      }
    }

    // B. 灰色占位文案节点「输入地理位置」旁的 input
    for (const el of document.querySelectorAll("span, div, label, p")) {
      const raw = String(el.textContent || "").trim();
      if (raw !== "输入地理位置" && raw !== "地理位置") continue;
      if (raw.length > 12 || !isVisible(el)) continue;
      let root = el.parentElement;
      for (let d = 0; d < 5 && root; d++) {
        const inputs = textInputs(root);
        if (inputs.length) return mark(inputs[0], "ghost-text:输入地理位置");
        root = root.parentElement;
      }
    }

    // C. 添加标签 同一行：位置 ▾ + 右侧输入框
    const tagAnchors = [...document.querySelectorAll("div, span, label")].filter(
      (el) => {
        const raw = String(el.textContent || "").trim();
        return (
          raw.replace(/\s+/g, "") === "添加标签" &&
          raw.length < 16 &&
          isVisible(el)
        );
      },
    );
    for (const anchor of tagAnchors) {
      let row = anchor.parentElement;
      for (let depth = 0; depth < 8 && row; depth++) {
        const rowText = String(row.innerText || "").replace(/\s+/g, "");
        // 整页表单太长，添加标签行应较短
        if (rowText.length > 180) {
          row = row.parentElement;
          continue;
        }
        const inputs = textInputs(row);
        const byPh = inputs.find((n) =>
          isGeoPh(n.getAttribute("placeholder") || ""),
        );
        if (byPh) return mark(byPh, "row-添加标签+ph");

        // 行内含「位置」时取最右侧较宽 input（截图：搜索框在右）
        if (rowText.includes("位置") && inputs.length) {
          inputs.sort(
            (a, b) =>
              a.getBoundingClientRect().left - b.getBoundingClientRect().left,
          );
          const right = inputs[inputs.length - 1];
          if (right.getBoundingClientRect().width >= 80) {
            return mark(right, "row-添加标签+rightmost");
          }
        }
        row = row.parentElement;
      }
    }

    // D. 抖音新版扩展信息的右侧输入框有时没有原生 placeholder/input。
    // 截图结构为「添加标签  [位置 ▾]  [输入地理位置]」，此时点击“位置”
    // 右侧的可见编辑区域即可把焦点交给内部控件，后续键盘输入仍然生效。
    const positionLabels = [...document.querySelectorAll("div, span, label, button")]
      .filter((el) => {
        const raw = String(el.textContent || "").replace(/\s+/g, "").trim();
        return raw === "位置" && isVisible(el);
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top - br.top || ar.left - br.left;
      });

    const isMeaningfulBox = (el) => {
      if (!isVisible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 80 && r.height >= 18 && r.height <= 100;
    };
    for (const positionLabel of positionLabels) {
      const labelRect = positionLabel.getBoundingClientRect();
      let row = positionLabel.parentElement;
      for (let depth = 0; depth < 6 && row; depth++) {
        const rowRect = row.getBoundingClientRect();
        const rowText = String(row.innerText || "").replace(/\s+/g, " ").trim();
        if (
          rowRect.width >= 260 &&
          rowRect.height <= 130 &&
          rowText.length <= 120
        ) {
          const candidates = [
            ...row.querySelectorAll(
              "input, textarea, [contenteditable='true'], [role='textbox'], div, span, button",
            ),
          ]
            .filter((el) => el !== positionLabel && isMeaningfulBox(el))
            .map((el) => {
              const r = el.getBoundingClientRect();
              const text = String(el.textContent || "").replace(/\s+/g, "").trim();
              const toRight = r.left >= labelRect.right - 24;
              const aligned =
                r.bottom > labelRect.top - 24 && r.top < labelRect.bottom + 24;
              const inputLike =
                el.tagName === "INPUT" ||
                el.tagName === "TEXTAREA" ||
                el.isContentEditable ||
                el.getAttribute("role") === "textbox";
              const geoText = /输入地理位置|地理位置|输入位置|搜索位置/.test(text);
              return {
                el,
                r,
                score:
                  (toRight ? 0 : 1000) +
                  (aligned ? 0 : 200) +
                  (geoText ? 0 : 80) +
                  (inputLike ? 0 : 30) +
                  Math.abs(r.left - labelRect.right),
              };
            })
            .filter((item) => item.score < 1300)
            .sort((a, b) => a.score - b.score || a.r.width - b.r.width);
          if (candidates.length) {
            return mark(candidates[0].el, "位置右侧编辑区");
          }
        }
        row = row.parentElement;
      }
    }

    // E. 有些抖音动态版本会先渲染「添加标签」行，但延后/隐藏左侧“位置”
    // 文字节点。截图中右侧编辑区仍在同一行，按该行几何结构兜底，避免因
    // 找不到“位置”二字而错过已经可点击的输入包装区。
    for (const tagAnchor of tagAnchors) {
      const tagRect = tagAnchor.getBoundingClientRect();
      let row = tagAnchor.parentElement;
      for (let depth = 0; depth < 8 && row; depth++) {
        const rowRect = row.getBoundingClientRect();
        if (rowRect.width < 420 || rowRect.height > 140) {
          row = row.parentElement;
          continue;
        }
        const candidates = [
          ...row.querySelectorAll(
            "input, textarea, [contenteditable='true'], [role='textbox'], div, span, button",
          ),
        ]
          .filter((el) => el !== tagAnchor && isMeaningfulBox(el))
          .map((el) => {
            const r = el.getBoundingClientRect();
            const inputLike =
              el.tagName === "INPUT" ||
              el.tagName === "TEXTAREA" ||
              el.isContentEditable ||
              el.getAttribute("role") === "textbox";
            const toRight = r.left >= tagRect.right - 16;
            const aligned =
              r.bottom > tagRect.top - 28 && r.top < tagRect.bottom + 28;
            return {
              el,
              r,
              score:
                (toRight ? 0 : 2000) +
                (aligned ? 0 : 400) +
                (inputLike ? 0 : 60) +
                (r.width >= 180 ? 0 : 120) +
                Math.abs(r.left - tagRect.right),
            };
          })
          .filter((item) => item.score < 900)
          .sort((a, b) => a.score - b.score || b.r.width - a.r.width);
        if (candidates.length) {
          return mark(candidates[0].el, "添加标签右侧编辑区");
        }
        row = row.parentElement;
      }
    }

    return null;
  };

  await revealLocationSection();

  const findDeadline = Date.now() + Math.min(WAIT_SELECTOR_APPEAR_MS, 120_000);
  let foundMeta = null;
  let dumpOnce = false;

  while (Date.now() < findDeadline) {
    foundMeta = await page.evaluate(markLocationInput).catch(() => null);
    if (foundMeta && foundMeta.how) {
      console.log(
        "[dy] 地理位置输入框:",
        foundMeta.how,
        `ph="${foundMeta.ph}" w=${foundMeta.w}`,
      );
      break;
    }
    await revealLocationSection();
    if (!dumpOnce && Date.now() > findDeadline - 100_000) {
      dumpOnce = true;
      const dump = await page
        .evaluate(() => {
          const body = document.body ? document.body.innerText || "" : "";
          return {
            url: location.href,
            has扩展信息: body.includes("扩展信息"),
            has添加标签: body.includes("添加标签"),
            has输入地理位置: body.includes("输入地理位置"),
            placeholders: [...document.querySelectorAll("[placeholder]")].map(
              (el) => ({
                ph: el.getAttribute("placeholder") || "",
                w: Math.round(el.getBoundingClientRect().width),
                h: Math.round(el.getBoundingClientRect().height),
              }),
            ),
          };
        })
        .catch(() => ({}));
      console.log("[dy] 地点区调试快照:", JSON.stringify(dump));
    }
    await page.waitForTimeout(400);
  }

  if (!(await page.$("[data-mm-dy-location='1']"))) {
    const dump = await page
      .evaluate(() => {
        const body = document.body ? document.body.innerText || "" : "";
        return {
          has扩展信息: body.includes("扩展信息"),
          has添加标签: body.includes("添加标签"),
          has输入地理位置: body.includes("输入地理位置"),
          placeholders: [...document.querySelectorAll("[placeholder]")]
            .map((el) => el.getAttribute("placeholder") || "")
            .filter(Boolean)
            .slice(0, 20),
        };
      })
      .catch(() => ({}));
    throw new Error(
      `未找到地理位置编辑区（扩展信息 > 添加标签 > 位置右侧输入框）；${JSON.stringify(dump)}`,
    );
  }

  // 右侧输入区会随左侧类型下拉复用。某些动态页面未直接显示“位置”文字时，
  // 先按「添加标签」行的几何关系打开左侧类型下拉，再选择下拉中的“位置”。
  console.log("[dy] 准备切换添加标签类型: 位置");
  const locationTypePicker = await page
    .evaluate(() => {
      const editor = document.querySelector("[data-mm-dy-location='1']");
      if (!editor) return null;
      const er = editor.getBoundingClientRect();
      const visible = (el) => {
        const st = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          st.display !== "none" &&
          st.visibility !== "hidden" &&
          r.width > 0 &&
          r.height > 0
        );
      };
      const textOf = (el) => {
        if (!el) return "";
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          return String(
            el.value ||
              el.getAttribute("value") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("aria-label") ||
              "",
          )
            .replace(/\s+/g, "")
            .trim();
        }
        return String(el.textContent || "").replace(/\s+/g, "").trim();
      };
      const tags = [...document.querySelectorAll("div, span, label")].filter(
        (el) => visible(el) && textOf(el) === "添加标签",
      );
      const tag = tags
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter((item) => item.r.bottom > er.top - 32 && item.r.top < er.bottom + 32)
        .sort((a, b) => Math.abs(a.r.top - er.top) - Math.abs(b.r.top - er.top))[0];
      if (!tag) return null;
      let row = tag.el.parentElement;
      for (let depth = 0; depth < 8 && row; depth++) {
        const rowRect = row.getBoundingClientRect();
        if (rowRect.width < 260 || rowRect.height > 180) {
          row = row.parentElement;
          continue;
        }
        const controls = [
          ...row.querySelectorAll(
            "button, [role='button'], [role='combobox'], [aria-haspopup='listbox'], input, div, span",
          ),
        ]
          .filter((el) => {
            if (el === tag.el || !visible(el) || el.contains(editor)) return false;
            const r = el.getBoundingClientRect();
            const text = textOf(el);
            const cls = String(el.className || "");
            const isTypeTrigger =
              cls.includes("semi-select") ||
              cls.includes("select-") ||
              el.getAttribute("role") === "combobox" ||
              el.getAttribute("aria-haspopup") === "listbox" ||
              el.tagName === "BUTTON";
            return (
              isTypeTrigger &&
              text !== "添加标签" &&
              r.left >= tag.r.right - 24 &&
              r.right <= rowRect.right + 24 &&
              r.bottom > tag.r.top - 32 &&
              r.top < tag.r.bottom + 32 &&
              r.width >= 40 &&
              r.width <= 260 &&
              r.height <= 120
            );
          })
          .map((el) => ({ el, r: el.getBoundingClientRect(), text: textOf(el) }))
          .sort((a, b) => b.r.left - a.r.left || a.r.width - b.r.width);
        const picker = controls[0];
        if (picker) {
          const rect = picker.r;
          return {
            text: picker.text,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            bottom: Math.round(rect.bottom),
          };
        }
        row = row.parentElement;
      }
      const samples = [];
      let debugRow = tag.el.parentElement;
      for (let depth = 0; depth < 8 && debugRow; depth++) {
        const dr = debugRow.getBoundingClientRect();
        if (dr.width < 260 || dr.height > 180) {
          debugRow = debugRow.parentElement;
          continue;
        }
        for (const el of debugRow.querySelectorAll(
          "button, [role='button'], [role='combobox'], [aria-haspopup='listbox'], input, div, span",
        )) {
          if (!visible(el) || el === tag.el || el.contains(editor)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 24 || r.height < 10 || r.left > er.left + 40) continue;
          samples.push({
            tag: el.tagName,
            text: textOf(el).slice(0, 40),
            value:
              el.tagName === "INPUT" || el.tagName === "TEXTAREA"
                ? String(el.value || "").slice(0, 40)
                : "",
            cls: String(el.className || "").slice(0, 40),
            left: Math.round(r.left),
            top: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          });
        }
        if (samples.length) break;
        debugRow = debugRow.parentElement;
      }
      return { debug: true, samples };
    })
    .catch(() => null);
  if (locationTypePicker) {
    if (locationTypePicker.debug) {
      console.log(
        "[dy] 地点类型候选调试:",
        JSON.stringify(locationTypePicker.samples || []),
      );
    }
  }
  if (locationTypePicker && !locationTypePicker.debug) {
    await page.mouse.click(locationTypePicker.x, locationTypePicker.y);
    console.log("[dy] 已点击添加标签类型下拉");
    await page.waitForTimeout(250);
    const selectedLocationType = await page
      .evaluate((pickerBottom) => {
        const visible = (el) => {
          const st = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return (
            st.display !== "none" &&
            st.visibility !== "hidden" &&
            r.width > 0 &&
            r.height > 0
          );
        };
        const option = [...document.querySelectorAll("li, [role='option']")]
          .filter((el) => {
            if (!visible(el)) return false;
            const r = el.getBoundingClientRect();
            return (
              String(el.textContent || "").replace(/\s+/g, "").trim() === "位置" &&
              r.top >= pickerBottom - 12 &&
              r.top <= pickerBottom + 420 &&
              r.height <= 90
            );
          })
          .sort(
            (a, b) =>
              a.getBoundingClientRect().top - b.getBoundingClientRect().top,
          )[0];
        if (!option) return null;
        const r = option.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          text: String(option.textContent || "").replace(/\s+/g, "").trim(),
        };
      }, locationTypePicker.bottom)
      .catch(() => null);
    if (selectedLocationType) {
      await page.mouse.click(selectedLocationType.x, selectedLocationType.y);
      console.log("[dy] 已切换添加标签类型为位置");
      await page.waitForTimeout(250);
    }
  }

  // 用真实鼠标事件点击：新版页面右侧有时是包装 div，DOM click 不会触发
  // 内部输入控件的 mousedown/focus 行为。
  const markedInput = await page.$("[data-mm-dy-location='1']");
  const markedBox = markedInput ? await markedInput.boundingBox() : null;
  if (!markedBox) {
    throw new Error("location editor has no visible bounding box");
  }
  await page.mouse.click(
    markedBox.x + Math.min(Math.max(markedBox.width / 2, 12), markedBox.width - 12),
    markedBox.y + Math.min(Math.max(markedBox.height / 2, 8), markedBox.height - 8),
  );
  const focusMeta = await page.evaluate(() => {
    const marked = document.querySelector("[data-mm-dy-location='1']");
    if (!marked) throw new Error("location input missing");
    const active = document.activeElement;
    const isTextEditor = (el) =>
      !!el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        el.getAttribute("role") === "textbox");
    // 鼠标点击包装区后，浏览器可能把焦点交给其内部或浮层内的原生 input。
    // 后续候选项搜索也应以实际焦点作为锚点。
    const input = isTextEditor(active) ? active : marked;
    if (input !== marked) {
      marked.removeAttribute("data-mm-dy-location");
      input.setAttribute("data-mm-dy-location", "1");
    }
    try {
      input.focus();
    } catch (_) {
      /* ignore */
    }
    if (input.tagName === "INPUT" || input.tagName === "TEXTAREA") {
      const desc = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      );
      if (desc && desc.set) desc.set.call(input, "");
      else input.value = "";
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "deleteContentBackward",
        }),
      );
    } else if (input.isContentEditable || input.getAttribute("role") === "textbox") {
      input.textContent = "";
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "deleteContentBackward",
        }),
      );
    }
    return {
      markedTag: marked.tagName,
      activeTag: active && active.tagName,
      activeType: active && active.getAttribute("type"),
      usedActive: input === active,
    };
  });
  console.log("[dy] 地理位置编辑区焦点:", JSON.stringify(focusMeta));
  await page.waitForTimeout(250);
  await page.keyboard.type(location, { delay: 70 });
  // 抖音部分动态版本的地点控件不会仅凭键盘事件发起 POI 请求；补发一次
  // 冒泡 input/change 通知即可同步其受控状态。这里不再写 input.value，避免
  // 旧实现覆盖 React 状态后把搜索词清空。
  await page
    .evaluate((value) => {
      const input = document.querySelector("[data-mm-dy-location='1']");
      if (!input) return false;
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          data: value,
          inputType: "insertText",
        }),
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, location)
    .catch(() => false);
  const postTypeMeta = await page.evaluate(() => {
    const marked = document.querySelector("[data-mm-dy-location='1']");
    const active = document.activeElement;
    const isTextEditor = (el) =>
      !!el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        el.getAttribute("role") === "textbox");
    const input = isTextEditor(active) ? active : marked;
    if (input && input !== marked && marked) {
      marked.removeAttribute("data-mm-dy-location");
      input.setAttribute("data-mm-dy-location", "1");
    }
    return {
      markedTag: marked && marked.tagName,
      markedValue: marked && (marked.value || ""),
      activeTag: active && active.tagName,
      activeValue: active && (active.value || ""),
      usedActive: input === active,
    };
  }).catch(() => null);
  console.log("[dy] 地理位置输入后焦点:", JSON.stringify(postTypeMeta));
  console.log("[dy] 已输入地理位置，等待候选项:", location);
  await page.waitForTimeout(700);

  return pickFirstDyLocation(page, location, {
    timeoutMs: Math.min(WAIT_SELECTOR_APPEAR_MS, pickTimeoutMs),
  });
}

async function setDyPlatformSchedule(page, data) {
  if (data.platformScheduleMode !== "platform") return;

  const scheduledAt = Number(data.platformScheduledPublishAt);
  const minAt = Date.now() + 2 * 60 * 60 * 1000;
  const maxAt = Date.now() + 14 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(scheduledAt) || scheduledAt < minAt || scheduledAt > maxAt) {
    throw new Error("抖音平台定时发布时间必须在 2 小时后至 14 天内");
  }

  const dt = new Date(scheduledAt);
  const pad = (value) => String(value).padStart(2, "0");
  const dateText = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  const timeText = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  const scheduledText = `${dateText} ${timeText}`;

  const opened = await page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
    const target = [...document.querySelectorAll("label, span, div, button")].find(
      (el) => normalize(el.textContent) === "定时发布" && visible(el),
    );
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.click();
    return true;
  });
  if (!opened) throw new Error("未找到抖音「定时发布」选项");

  await page.waitForTimeout(500);
  const inputResult = await page.evaluate((value) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const input = [...document.querySelectorAll('input[placeholder="日期和时间"]')]
      .find(visible);
    if (!input) return { ok: false, value: "" };
    input.scrollIntoView({ block: "center", inline: "nearest" });
    input.focus();
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (valueSetter) valueSetter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    return { ok: true, value: input.value };
  }, scheduledText);

  if (!inputResult.ok) {
    throw new Error("未找到抖音平台定时输入框: placeholder=日期和时间");
  }
  await page.waitForTimeout(300);
  const actualText = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="日期和时间"]');
    return input ? String(input.value || "") : "";
  });
  if (actualText !== scheduledText) {
    throw new Error(`抖音平台定时输入框写入失败，期望 ${scheduledText}，实际 ${actualText || "空"}`);
  }
  console.log(`[dy] 已设置平台定时发布时间: ${scheduledText}`);
}

async function resetDyLocationAttempt(page, { clearValue = false } = {}) {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .evaluate((shouldClearValue) => {
      const marked = document.querySelector("[data-mm-dy-location='1']");
      if (marked && shouldClearValue) {
        if (marked.tagName === "INPUT" || marked.tagName === "TEXTAREA") {
          const prototype =
            marked.tagName === "INPUT"
              ? window.HTMLInputElement.prototype
              : window.HTMLTextAreaElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (descriptor?.set) descriptor.set.call(marked, "");
          else marked.value = "";
          marked.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              cancelable: true,
              inputType: "deleteContentBackward",
            }),
          );
          marked.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (
          marked.isContentEditable ||
          marked.getAttribute("role") === "textbox"
        ) {
          marked.textContent = "";
          marked.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              cancelable: true,
              inputType: "deleteContentBackward",
            }),
          );
        }
      }
      if (marked) marked.removeAttribute("data-mm-dy-location");
      const active = document.activeElement;
      if (active && typeof active.blur === "function") active.blur();
    }, clearValue)
    .catch(() => {});
  await page.waitForTimeout(750);
}

async function selectDyLocationWithRetry(page, data) {
  let lastError = null;
  for (let attempt = 1; attempt <= DY_LOCATION_ATTEMPTS; attempt += 1) {
    try {
      const result = await selectDyLocation(page, data, {
        pickTimeoutMs: DY_LOCATION_PICK_TIMEOUT_MS,
      });
      if (result?.selected !== true && result?.skipped !== true) {
        throw new Error("地理位置未确认选中，已停止发布");
      }
      return result;
    } catch (error) {
      throwIfPublishCanceled(page);
      if (error?.dyLocationSelectionAttempted || error?.nonRetryable) {
        // 点击后未确认，或无结果后清理失败时停止，不能重新搜索换选。
        error.nonRetryable = true;
        throw error;
      }
      lastError = error;
      console.warn(
        `[dy] 地理位置选择失败 (${attempt}/${DY_LOCATION_ATTEMPTS}):`,
        error?.message || error,
      );
      if (attempt < DY_LOCATION_ATTEMPTS) {
        await resetDyLocationAttempt(page);
      }
    }
  }

  const error = lastError || new Error("抖音地理位置未选中，已停止发布");
  error.nonRetryable = true;
  throw error;
}

export default async function (page, data, window, event, _finish, task = {}) {
  const isDraftMode =
    data.publishMode === "draft" || data.publishToDraft === true;
  let publishSubmitted = false;
  const stage = (value, options) => task.setStage?.(value, options);

  // 统一失败上报：event.reply("puppeteerFile-done", {status:false,...}) 在
  // puppeteerFile.js 的 createAttemptTransport 里会 throw，从而正确触发上层
  // 队列的重试/最终失败逻辑。此前这里只 console.error 不上报，会导致上传
  // 输入框/标题输入框找不到时静默放过，流程继续往下走，最终在几十分钟到
  // 3 小时后才因为一个不相关的超时消息失败，掩盖了真实原因。
  const reportFailure = async (stage, e) => {
    // 外层取消已负责回传终态和截图，不再重复诊断已关闭的页面。
    if (task.signal?.aborted) return;
    const confirmationUnknown = e?.confirmationUnknown === true ||
      (publishSubmitted && !e?.verificationRequired && e?.code !== "publish_rejected");
    const detail =
      e?.verificationRequired === true
        ? `抖音账号 ${data.phone || data.partition || ""} 需要接收短信验证码，请完成验证后重新发布`
        : confirmationUnknown
          ? "抖音已点击发布，但在确认窗口内未收到最终结果，请到抖音作品管理核验，勿重复发布"
          : (e && e.message) || String(e);
    console.error(`❌ ${stage}`, e);
    const pageSnapshot =
      e?.dyPageSnapshot ||
      e?.dyPublishConfirmation ||
      (await inspectDyPublishPage(page).catch(() => null));
    const diagnostic = await capturePublishFailureDiagnostics({
      page,
      data,
      stage,
      error: e,
      pageSnapshot,
    });
    event.reply("puppeteerFile-done", {
      ...data,
      status: false,
      message: detail.length > 200 ? `${detail.slice(0, 200)}…` : detail,
      diagnostic,
      nonRetryable: e?.nonRetryable === true || publishSubmitted,
      verificationRequired: e?.verificationRequired === true,
      confirmationUnknown,
      confirmationWaitedMs: e?.waitedMs || 0,
    });
  };

  if (data.mmPreflightOnly) {
    try {
      const snapshot = await waitForDyUploadPageReady(page, {
        timeoutMs: DY_PREFLIGHT_TIMEOUT_MS,
        intervalMs: 500,
        timeoutMessage: "抖音发布页预检未找到视频上传输入框",
      });
      console.log(
        `[dy] 发布页预检通过: ${data.phone || data.partition} locator=${snapshot.matchedLocatorId}`,
      );
      event.reply("puppeteerFile-done", {
        ...data,
        status: true,
        preflight: true,
        message: "抖音发布页预检通过",
      });
    } catch (e) {
      await reportFailure("发布页预检失败", e);
    }
    return;
  }

  console.log(
    "[dy] 上传阶段开始:",
    JSON.stringify({
      phone: data.phone || data.partition || "",
      filePath: data.filePath || "",
    }),
  );
  try {
    stage("等待视频上传控件");
    console.log("[dy] 等待视频上传输入框");
    await waitForDyUploadPageReady(page, {
      timeoutMs: DY_UPLOAD_INPUT_TIMEOUT_MS,
      intervalMs: 500,
      timeoutMessage: "未找到抖音视频上传输入框",
    });
    const uploadInput = await findDyUploadInput(page);
    if (!uploadInput) {
      throw new Error("抖音视频上传输入框在文件选择前消失");
    }
    console.log(
      "[dy] 上传控件已定位:",
      JSON.stringify({ locator: uploadInput.locator.id, filePath: data.filePath || "" }),
    );
    console.log("[dy] 开始调用文件上传");
    stage("选择视频文件");
    await uploadInput.handle.uploadFile(path.resolve(data.filePath));
    console.log("[dy] 文件上传调用已返回，等待视频处理");
    stage("等待视频上传和预览");
    let lastLoggedAt = 0;
    let lastState = "";
    await waitForDyUploadProcessing(page, {
      onProgress: (progress) => task.uploadProgress?.(progress),
      onSnapshot: (snapshot) => {
        task.setSnapshot?.(snapshot);
        stage(snapshot.state === "uploading" ? "等待视频上传完成" : "等待视频处理和预览", { progress: false });
        const now = Date.now();
        if (snapshot.state !== lastState || now - lastLoggedAt >= 15000) {
          console.log("[dy] 上传处理状态:", JSON.stringify(snapshot));
          lastLoggedAt = now;
          lastState = snapshot.state;
        }
      },
    });
    console.log("[dy] 视频上传和预览已就绪");
  } catch (e) {
    await reportFailure("视频上传或处理失败", e);
    return;
  }
  try {
    stage("填写标题、描述和标签");
    console.log("[dy] 等待标题输入框");
    await pollPageUntil(
      page,
      () => !!document.querySelector(".semi-input"),
      WAIT_SELECTOR_APPEAR_MS,
      500,
      "未找到抖音标题输入框",
    );
    // 获取元素句柄
    const input = await page.$(".semi-input");
    // 点击并清空内容
    await input.click({ clickCount: 3 }); // 三击全选
    await page.keyboard.press("Backspace"); // 删除内容
    await page.type(".semi-input", data.data.bt1, { delay: 50 });

    await replaceDyDescription(page, data.data);
    console.log("[dy] 标题、描述和标签已填写");
  } catch (e) {
    await reportFailure("填写标题、描述或标签失败", e);
    return;
  }

  try {
    stage("设置保存权限");
    // 「保存权限」区域往往在预览视频就绪后才挂载；放在预览等待之后，并放宽文案/控件匹配
    await pollPageUntil(
      page,
      () => {
        const norm = (t) => String(t).replace(/\s+/g, "").trim();
        const hasSaveTitleIn = (root) =>
          [...root.querySelectorAll("span")].some((s) =>
            norm(s.textContent).includes("保存权限")
          );
        for (const label of document.querySelectorAll("label")) {
          if (!label.textContent.includes("不允许")) continue;
          const inp = label.querySelector('input[value="0"]');
          if (!inp || (inp.type !== "checkbox" && inp.type !== "radio"))
            continue;
          let a = label;
          for (let i = 0; i < 28 && a; i++) {
            if (hasSaveTitleIn(a)) return true;
            a = a.parentElement;
          }
        }
        return false;
      },
      30_000,
      500,
      "未找到保存权限设置",
    );
    const saved = await page.evaluate(() => {
      const norm = (t) => String(t).replace(/\s+/g, "").trim();
      const hasSaveTitleIn = (root) =>
        [...root.querySelectorAll("span")].some((s) =>
          norm(s.textContent).includes("保存权限")
        );
      for (const label of document.querySelectorAll("label")) {
        if (!label.textContent.includes("不允许")) continue;
        const inp = label.querySelector('input[value="0"]');
        if (!inp || (inp.type !== "checkbox" && inp.type !== "radio")) continue;
        let a = label;
        for (let i = 0; i < 28 && a; i++) {
          if (hasSaveTitleIn(a)) {
            label.click();
            return true;
          }
          a = a.parentElement;
        }
      }
      return false;
    });
    if (!saved) throw new Error("未找到保存权限-不允许");
    console.log("[dy] 保存权限已设置");

    // 自主声明入口在视频转码完成后才出现，必须在点击发布前完成
    console.log("[dy] 开始处理自主声明、地理位置和定时配置");
    stage("设置自主声明");
    await selectDyCreativeStatementWithRetry(page, data);
    stage("设置地理位置");
    const locationSelection = await selectDyLocationWithRetry(page, data);
    stage("设置平台定时");
    await setDyPlatformSchedule(page, data);

    if (locationSelection.selected) {
      const locationState = await page.evaluate(inspectDyLocationPick, {
        selected: locationSelection.label,
      });
      if (!locationState.accepted) {
        const error = new Error(
          `发布前地理位置未确认选中，已停止发布：${locationSelection.label}；${JSON.stringify(locationState)}`,
        );
        error.nonRetryable = true;
        throw error;
      }
    }

    console.log("[dy] 配置完成，准备点击发布");
    stage("定位发布按钮");
    await clickDyPublish(page, isDraftMode, () => {
      publishSubmitted = true;
      task.markSubmitted?.();
    });
    console.log("[dy] 已点击发布，等待平台确认");
    const confirmationTimeoutMs = resolveDyPublishConfirmationTimeoutMs({
      publishTimeoutMs: data.publishTimeoutMs,
    });
    console.log(
      `[dy] 发布确认最长等待 ${Math.round(confirmationTimeoutMs / 1000)} 秒`,
    );
    const confirmation = await waitForDyPublishConfirmation(page, {
      isDraftMode,
      publishTimeoutMs: data.publishTimeoutMs,
      onSnapshot: (snapshot, meta) => {
        if (!snapshot) return;
        console.log(
          `[dy] 发布确认状态: ${snapshot.state}，已等待 ${Math.round(
            meta.elapsedMs / 1000,
          )} 秒，提示=${JSON.stringify(snapshot.messages || [])}`,
        );
        if (snapshot.state !== "verification_required") return;

        const windowShown = revealDyVerificationWindow(window);
        const message = `抖音账号 ${data.phone || data.partition || ""} 需要接收短信验证码，请在弹出的抖音窗口中完成验证`;
        try {
          event.reply("puppeteerFile-reply", {
            ...data,
            status: "verification_required",
            code: "dy_verification_required",
            message: windowShown
              ? message
              : `${message}（窗口显示失败，请手动打开抖音发布窗口）`,
            verificationRequired: true,
          });
        } catch (error) {
          console.warn("[dy] 推送短信验证状态失败:", error?.message || error);
        }
      },
    });
    console.log(
      isDraftMode ? "✅ 抖音已确认保存草稿成功" : "✅ 抖音已确认视频发布成功",
      JSON.stringify(confirmation),
    );
    event.reply("puppeteerFile-done", {
      ...data,
      status: true,
      publishConfirmed: true,
      message: isDraftMode ? "保存草稿成功" : "发布成功",
    });
    maybeClosePublishWindow(data, window);
  } catch (e) {
    await reportFailure("上传失败", e);
  }
}
