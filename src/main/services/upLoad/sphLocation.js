"use strict";

const SPH_LOCATION_TIMEOUT_MS = 60 * 1000;
const SPH_LOCATION_POLL_MS = 300;

function getErrorMessage(error) {
  return error?.message || String(error || "未知错误");
}

export function getSphLocationValue(data = {}) {
  return String(
    data?.data?.address ||
      data?.data?.location ||
      data?.address ||
      data?.location ||
      "",
  ).trim();
}

async function runSphLocationPageAction(page, action, target = "") {
  return page.evaluate(({ action: currentAction, target: currentTarget }) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, "")
        .trim();
    const rootOf = () => {
      const app = document.querySelector("wujie-app.wujie_iframe");
      return app && app.shadowRoot;
    };
    const queryDeep = (root, selector) => {
      const elements = [...root.querySelectorAll(selector)];
      for (const element of [...root.querySelectorAll("*")]) {
        if (element.shadowRoot) {
          elements.push(...queryDeep(element.shadowRoot, selector));
        }
      }
      return [...new Set(elements)];
    };
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const textOf = (element) => normalize(element?.textContent || "");
    const clickLikeUser = (element) => {
      const rect = element.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      if (typeof PointerEvent === "function") {
        element.dispatchEvent(new PointerEvent("pointerdown", init));
        element.dispatchEvent(new PointerEvent("pointerup", init));
      }
      element.dispatchEvent(new MouseEvent("mousedown", init));
      element.dispatchEvent(new MouseEvent("mouseup", init));
      element.dispatchEvent(new MouseEvent("click", init));
      element.click();
    };
    const hintOf = (element) =>
      normalize(
        `${element?.getAttribute?.("placeholder") || ""} ${
          element?.getAttribute?.("aria-label") || ""
        }`,
      );
    const isLocationInput = (element) => {
      if (!element || !visible(element)) return false;
      if (element.tagName === "INPUT") {
        const type = String(element.getAttribute("type") || "text").toLowerCase();
        if (["file", "hidden", "button", "submit", "checkbox", "radio"].includes(type)) {
          return false;
        }
      }
      return /添加位置|选择位置|搜索位置|输入位置|添加地点|选择地点|搜索地点|输入地点|位置|地点/.test(
        hintOf(element),
      );
    };
    const findInput = (root) =>
      queryDeep(
        root,
        'input, textarea, [contenteditable="true"], [role="textbox"]',
      ).find(isLocationInput) || null;
    const findTrigger = (root) => {
      const exact = new Set(["添加位置", "选择位置", "添加地点", "选择地点"]);
      const trigger = queryDeep(
        root,
        "button, [role='button'], [role='combobox'], label, div, span",
      )
        .filter((element) => {
          const text = textOf(element);
          return visible(element) && text && text.length <= 20 &&
            (exact.has(text) || text === "位置" || text === "地点");
        })
        .sort((left, right) => {
          const leftScore = exact.has(textOf(left)) ? 0 : 1;
          const rightScore = exact.has(textOf(right)) ? 0 : 1;
          return leftScore - rightScore;
        })[0] || null;
      if (!trigger) return null;
      const formItem = trigger.closest(".form-item");
      const positionDisplay = formItem?.querySelector?.(".position-display");
      if (positionDisplay) return positionDisplay;
      return (
        trigger.closest(
          "button, [role='button'], [role='combobox'], label, [class*='position'], [class*='location']",
        ) || trigger.parentElement || trigger
      );
    };
    const findCandidate = (root) => {
      const panel = queryDeep(root, ".location-filter-wrap").find(visible);
      if (!panel) return null;
      const normalizedTarget = normalize(currentTarget);
      const coreTargets = [
        normalizedTarget,
        normalizedTarget.slice(2),
        normalizedTarget.slice(3),
      ].filter((value) => value.length >= 2);
      return queryDeep(
        panel,
        "li, [role='option'], [role='listbox'] li, button, [role='button'], div, span, p",
      )
        .filter((element) => {
          if (!visible(element)) return false;
          const text = textOf(element);
          if (!text || text.length > Math.max(normalizedTarget.length + 60, 80)) return false;
          return coreTargets.some(
            (value) => text.includes(value) || (text.length >= 2 && value.includes(text)),
          );
        })
        .map((element) => {
          const text = textOf(element);
          const rect = element.getBoundingClientRect();
          return {
            element,
            text,
            score: (text === normalizedTarget ? 0 : text.startsWith(normalizedTarget) ? 1 : 2) + rect.top / 10000,
          };
        })
        .sort((left, right) => left.score - right.score)[0] || null;
    };

    const root = rootOf();
    if (!root) return { ok: false, reason: "shadow_root_not_found" };

    if (currentAction === "open") {
      if (findInput(root)) return { ok: true, alreadyOpen: true };
      const trigger = findTrigger(root);
      if (!trigger) return { ok: false, reason: "location_trigger_not_found" };
      trigger.scrollIntoView({ block: "center", inline: "center" });
      const rect = trigger.getBoundingClientRect();
      return {
        ok: true,
        alreadyOpen: false,
        clickPoint: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        },
      };
    }

    if (currentAction === "hasInput") {
      return { ok: Boolean(findInput(root)) };
    }

    if (currentAction === "fill") {
      const input = findInput(root);
      if (!input) return { ok: false, reason: "location_input_not_found" };
      input.focus();
      if (input.tagName === "INPUT" || input.tagName === "TEXTAREA") {
        const prototype = input.tagName === "INPUT"
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(input, currentTarget);
        else input.value = currentTarget;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        input.textContent = currentTarget;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return { ok: true };
    }

    const candidate = findCandidate(root);
    if (currentAction === "hasCandidate") {
      return { ok: Boolean(candidate) };
    }
    if (currentAction === "select") {
      if (!candidate) return { ok: false, reason: "location_candidate_not_found" };
      candidate.element.scrollIntoView({ block: "center", inline: "center" });
      clickLikeUser(candidate.element);
      return { ok: true, label: candidate.text };
    }

    return { ok: false, reason: "unknown_action" };
  }, { action, target });
}

async function waitForSphLocationAction(page, action, target, message) {
  const deadline = Date.now() + SPH_LOCATION_TIMEOUT_MS;
  let lastResult = null;
  while (Date.now() < deadline) {
    lastResult = await runSphLocationPageAction(page, action, target).catch((error) => ({
      ok: false,
      reason: getErrorMessage(error),
    }));
    if (lastResult?.ok) return lastResult;
    await page.waitForTimeout(SPH_LOCATION_POLL_MS);
  }
  const error = new Error(`${message}：${lastResult?.reason || "页面未就绪"}`);
  error.code = "sph_location_timeout";
  throw error;
}

export async function applySphLocation(page, data = {}) {
  const location = getSphLocationValue(data);
  if (!location) {
    console.log("[sph][location] 未提供位置，跳过");
    return { selected: false, skipped: true };
  }

  console.log("[sph][location] 开始选择位置:", location);
  const opened = await waitForSphLocationAction(
    page,
    "open",
    location,
    "视频号位置入口未出现",
  );
  if (!opened?.ok) {
    throw new Error(`视频号位置入口不可用：${opened?.reason || "unknown"}`);
  }
  if (!opened.alreadyOpen && opened.clickPoint && page.mouse?.click) {
    await page.mouse.click(opened.clickPoint.x, opened.clickPoint.y);
  }

  await waitForSphLocationAction(
    page,
    "hasInput",
    location,
    "视频号位置输入框未出现",
  );
  const filled = await runSphLocationPageAction(page, "fill", location);
  if (!filled?.ok) {
    throw new Error(`视频号位置输入失败：${filled?.reason || "unknown"}`);
  }

  await waitForSphLocationAction(
    page,
    "hasCandidate",
    location,
    `视频号未找到位置候选「${location}」`,
  );
  const selected = await runSphLocationPageAction(page, "select", location);
  if (!selected?.ok) {
    throw new Error(`视频号位置候选选择失败：${selected?.reason || "unknown"}`);
  }

  console.log("[sph][location] 已选择位置:", selected.label || location);
  return { selected: true, label: selected.label || location };
}
