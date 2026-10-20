// 浏览器回调必须自包含。选择器来自实际发布页：城市页签不在地点 listbox 内。
export function findFirstDyLocationOption(keyword) {
  const input = document.querySelector("[data-mm-dy-location='1']");
  if (!input) return { ok: false, reason: "search-input-missing" };
  const value = String(input.value == null ? input.textContent || "" : input.value).trim();
  if (value !== String(keyword).trim()) return { ok: false, reason: "search-value-not-ready" };
  const control = input.closest(".semi-select");
  if (!control) return { ok: false, reason: "location-control-missing" };
  control.setAttribute("data-mm-dy-location-control", "1");
  const visible = (node) => {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  // 实际页面把城市 tab 和结果 listbox 放在同一个浮层内，只能从 listbox 取 option。
  const list = [...control.parentElement.querySelectorAll("[role='listbox']")].find(visible);
  if (!list) return { ok: false, reason: "location-listbox-missing" };
  const first = [...list.querySelectorAll("[role='option']")]
    .find((node) => visible(node) && node.getAttribute("aria-disabled") !== "true");
  if (!first) return { ok: false, reason: "no-search-options", listText: String(list.textContent || "").slice(0, 160) };
  first.scrollIntoView({ block: "nearest", inline: "nearest" });
  const rect = first.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || !first.contains(hit)) return { ok: false, reason: "first-option-covered" };
  const name = first.querySelector("[class*='name-']");
  const selected = String(name ? name.textContent : first.textContent).trim();
  if (!selected) return { ok: false, reason: "first-option-empty" };
  return { ok: true, selected, optionText: String(first.textContent || "").trim(), x, y };
}

export function inspectDyLocationPick({ selected }) {
  const control = document.querySelector("[data-mm-dy-location-control='1']");
  const label = control && control.querySelector(".semi-select-selection-text");
  const selectedText = label ? String(label.textContent || "").trim() : "";
  const placeholder = !!label && label.classList.contains("semi-select-selection-placeholder");
  const open = !!control && control.classList.contains("semi-select-open");
  const normalize = (text) => String(text || "").replace(/\s+/g, "").trim();
  const rect = control && control.getBoundingClientRect();
  const style = control && window.getComputedStyle(control);
  const visible = !!rect && rect.width > 0 && rect.height > 0 &&
    style.display !== "none" && style.visibility !== "hidden";
  // 输入框消失、搜索词清空、候选层关闭均不能单独作为成功证据，必须有已选名称。
  return {
    accepted: visible && !!label && !placeholder && !open &&
      !!normalize(selected) && normalize(selectedText) === normalize(selected),
    selectedText,
    placeholder,
    open,
    inputPresent: !!control && !!control.querySelector("input"),
  };
}

async function clearEmptyDyLocationSearch(page) {
  try {
    const input = await page.$("[data-mm-dy-location='1']");
    if (!input) throw new Error("未找到地点搜索框");
    await input.focus();
    const focused = await page.evaluate(() =>
      document.activeElement === document.querySelector("[data-mm-dy-location='1']"),
    );
    if (!focused) throw new Error("地点搜索框未获得焦点");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    try {
      await page.keyboard.press("KeyA");
    } finally {
      await page.keyboard.up(modifier);
    }
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active && typeof active.blur === "function") active.blur();
    });

    const deadline = Date.now() + 2_000;
    do {
      await page.waitForTimeout(200);
      const cleared = await page.evaluate(() => {
        // 外层 select 在搜索 input 被移除后仍存在，用它核验最终状态。
        const control = document.querySelector("[data-mm-dy-location-control='1']");
        const label = control && control.querySelector(".semi-select-selection-text");
        const input = control && control.querySelector("input, textarea, [contenteditable='true']");
        const value = input ? String(input.value == null ? input.textContent || "" : input.value).trim() : "";
        return !!control && !!label && !value &&
          label.classList.contains("semi-select-selection-placeholder") &&
          !control.classList.contains("semi-select-open");
      });
      if (cleared) return;
    } while (Date.now() < deadline);
    throw new Error("搜索词或已选地点仍有残留");
  } catch (cause) {
    const error = new Error(`无搜索结果时清理抖音地点失败，已停止发布：${cause.message}`);
    error.nonRetryable = true;
    throw error;
  }
}

export async function pickFirstDyLocation(page, keyword, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "no-search-options";
  let optionFailure = "";
  while (Date.now() < deadline) {
    const first = await page.evaluate(findFirstDyLocationOption, keyword);
    if (!first.ok) {
      lastReason = first.reason;
      if (first.reason === "first-option-covered" || first.reason === "first-option-empty") {
        optionFailure = first.reason;
      }
      await page.waitForTimeout(300);
      continue;
    }
    // 从此处起，无论确认结果如何，都不允许重新搜索、换选另一条地点。
    try {
      await page.mouse.click(first.x, first.y);
      console.log("[dy] 已点击地理位置搜索结果第一条:", first.optionText);
      const confirmDeadline = Date.now() + 2_000;
      let state;
      do {
        await page.waitForTimeout(200);
        state = await page.evaluate(inspectDyLocationPick, { selected: first.selected });
        if (state.accepted) {
          console.log("[dy] 已确认地点控件显示首条地点:", state.selectedText);
          return { selected: true, label: first.selected };
        }
      } while (Date.now() < confirmDeadline);
      throw new Error(`首条地点未确认选中，已停止发布：${first.selected}；${JSON.stringify(state)}`);
    } catch (error) {
      error.dyLocationSelectionAttempted = true;
      throw error;
    }
  }
  if (lastReason === "no-search-options" && !optionFailure) {
    await clearEmptyDyLocationSearch(page);
    console.warn(`[dy] 地点搜索无结果，已清空并跳过地点，继续发布：${keyword}`);
    return { selected: false, skipped: true, reason: "no-search-options" };
  }
  throw new Error(`未找到抖音地点搜索结果：${keyword}（${optionFailure || lastReason}）`);
}
