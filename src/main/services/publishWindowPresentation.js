"use strict";

function isUsableWindow(window) {
  return Boolean(
    window &&
      typeof window.isDestroyed === "function" &&
      !window.isDestroyed()
  );
}

export function hidePublishWindowMenu(window) {
  if (!isUsableWindow(window)) return false;

  if (typeof window.removeMenu === "function") {
    window.removeMenu();
  } else if (typeof window.setMenu === "function") {
    window.setMenu(null);
  }
  if (typeof window.setMenuBarVisibility === "function") {
    window.setMenuBarVisibility(false);
  }
  return true;
}

export function revealPublishVerificationWindow(window) {
  if (!isUsableWindow(window)) return false;

  hidePublishWindowMenu(window);
  if (typeof window.isMinimized === "function" && window.isMinimized()) {
    window.restore();
  }
  if (typeof window.setAlwaysOnTop === "function") {
    window.setAlwaysOnTop(true, "screen-saver");
  }
  if (typeof window.isVisible !== "function" || !window.isVisible()) {
    window.show();
  }
  if (typeof window.moveTop === "function") window.moveTop();
  if (typeof window.focus === "function") window.focus();
  return true;
}
