const DESCRIPTION_SELECTOR = ".zone-container.editor-kit-container";

function descriptionError(message, cause) {
  const error = new Error(message);
  error.code = "dy_description_mismatch";
  error.nonRetryable = true;
  if (cause) error.cause = cause;
  return error;
}

async function verifyDescription(page, expected, message) {
  try {
    await page.waitForFunction(
      (selector, text) => {
        const editor = document.querySelector(selector);
        if (!editor) return false;
        // 编辑器的空段落、零宽占位符和话题胶囊可能改变空白布局。
        const actual = String(editor.innerText || editor.textContent || "")
          .replace(/[\u200b\ufeff]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return actual === text;
      },
      { timeout: 2000, polling: 100 },
      DESCRIPTION_SELECTOR,
      expected,
    );
  } catch (cause) {
    throw descriptionError(message, cause);
  }
}

export async function replaceDyDescription(page, { bt2, bq } = {}) {
  const text = [bt2, bq]
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
  const editor = await page.$(DESCRIPTION_SELECTOR);
  if (!editor) throw descriptionError("未找到抖音正文编辑器，已停止发布");

  await editor.click();
  const focused = await editor.evaluate(element => {
    const active = element.ownerDocument.activeElement;
    return !!active && active.isContentEditable && element.contains(active);
  });
  if (!focused) throw descriptionError("抖音正文编辑器未获得焦点，已停止发布");

  // 原生编辑事件会同步平台的编辑器状态，并清除多段正文及话题胶囊。
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  try {
    await page.keyboard.press("KeyA");
  } finally {
    await page.keyboard.up(modifier);
  }
  await page.keyboard.press("Backspace");
  await verifyDescription(page, "", "抖音旧正文未清空，已停止发布");

  if (text) {
    await page.keyboard.type(text, { delay: 50 });
    // 空格提交最后一个话题，避免最后一个 #标签 停留在输入状态。
    await page.keyboard.press("Space");
  }
  const expected = text
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  await verifyDescription(page, expected, "抖音正文与待发布配文不一致，已停止发布");
}
