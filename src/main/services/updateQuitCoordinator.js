let updateQuitHandler = null;

export function registerUpdateQuitHandler(handler) {
  updateQuitHandler = typeof handler === "function" ? handler : null;
}

export function quitForUpdate(electronApp) {
  if (updateQuitHandler) {
    updateQuitHandler();
    return;
  }
  electronApp.quit();
}
