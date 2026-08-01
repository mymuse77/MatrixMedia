"use strict";

/**
 * 顶层导航（location.href 跳转 / <a> 点击 / 服务端 302 等触发的同窗口导航）
 * 允许通过的协议白名单。
 *
 * - http / https：正常网页跳转，必须放行。
 * - ws / wss：纯防御性放行。浏览器本身并不会把 ws(s) 当作需要交给系统外部
 *   程序处理的"未知协议"（Chromium 对顶层导航到 ws(s) 会直接报协议不支持，
 *   不会触发 Windows 的"选取应用"对话框），所以放不放行都不影响本守卫要
 *   解决的问题；但页面里用 `new WebSocket(url)` 发起的连接走的是 JS 网络
 *   请求，根本不属于 `will-navigate` / `will-redirect` 覆盖的"文档导航"
 *   范畴，天然不会被这里拦截——两者是完全独立的机制，互不影响。
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const SUPPRESSED_EXTERNAL_PROTOCOLS = ["bitbitbrowser"];
const ERR_ABORTED = -3;
const guardedWebContents = new WeakSet();
const guardedSessions = new WeakSet();

function isAllowedNavigationUrl(url) {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch (_) {
    return false;
  }
}

function suppressExternalProtocol(webContents, scheme) {
  const protocol = webContents?.session?.protocol;
  if (
    !protocol ||
    typeof protocol.isProtocolRegistered !== "function" ||
    typeof protocol.registerStringProtocol !== "function"
  ) {
    console.warn(`[nav-guard] 无法注册 ${scheme} 协议拦截器`);
    return false;
  }

  try {
    if (protocol.isProtocolRegistered(scheme)) return true;

    const registered = protocol.registerStringProtocol(
      scheme,
      (request, callback) => {
        console.warn(`[nav-guard] 已拦截外部协议请求: ${request.url}`);
        callback({ error: ERR_ABORTED });
      },
    );

    if (!registered) {
      console.warn(`[nav-guard] 注册 ${scheme} 协议拦截器失败`);
    }
    return registered;
  } catch (error) {
    console.warn(
      `[nav-guard] 注册 ${scheme} 协议拦截器异常:`,
      error?.message || error,
    );
    return false;
  }
}

function guardExternalProtocolPermissions(webContents) {
  const targetSession = webContents?.session;
  if (
    !targetSession ||
    guardedSessions.has(targetSession) ||
    typeof targetSession.setPermissionRequestHandler !== "function"
  ) {
    return;
  }

  targetSession.setPermissionRequestHandler(
    (_requestingWebContents, permission, callback, details = {}) => {
      if (permission !== "openExternal") {
        // Electron 默认允许远程页面的权限请求；这里只收紧外部协议，不改变其它行为。
        callback(true);
        return;
      }

      const externalUrl = String(details.externalURL || "未知地址");
      console.warn(`[nav-guard] 已拒绝外部协议权限: ${externalUrl}`);
      callback(false);
    },
  );
  guardedSessions.add(targetSession);
}

/**
 * 拦截目标平台页面里常见的"唤起 App / 自定义协议深链"跳转（如企业微信、
 * 分享组件里的 weixin:// 之类 applink，或某些 SDK 用来探测本机是否装了
 * 对应 App 的 scheme ping）。
 *
 * 这类跳转是同窗口顶层导航，不会被 setWindowOpenHandler（只管新开窗口/
 * window.open）拦住；Chromium 遇到自己不认识的协议时会把 URL 交给操作系统
 * 处理，Windows 上表现为弹出原生"选取一个应用"对话框，会打断/挂起无界面
 * 的自动化窗口。这里在文档导航阶段直接挡掉非 http(s)/ws(s) 协议，从根源
 * 上避免把这类 URL 交给系统。
 *
 * 当前 session 会拒绝全部 openExternal 权限，并为已知协议注册取消处理器，
 * 从而覆盖 iframe 等不会触发顶层导航事件的协议探测；不影响网页网络请求。
 *
 * @param {import("electron").WebContents} webContents
 */
export function guardExternalNavigation(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  guardExternalProtocolPermissions(webContents);
  for (const scheme of SUPPRESSED_EXTERNAL_PROTOCOLS) {
    suppressExternalProtocol(webContents, scheme);
  }

  if (guardedWebContents.has(webContents)) return;
  guardedWebContents.add(webContents);

  const blockIfExternal = (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    console.warn("[nav-guard] 已拦截非 http(s)/ws(s) 协议的外部跳转:", url);
    event.preventDefault();
  };
  webContents.on("will-navigate", blockIfExternal);
  webContents.on("will-redirect", blockIfExternal);
}

export {
  guardExternalProtocolPermissions,
  isAllowedNavigationUrl,
  suppressExternalProtocol,
};
