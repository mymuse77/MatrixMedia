export function createLaunchInstallerHandler({
  platform,
  spawn,
  shell,
  electronApp,
  hasActiveTasks = () => false,
  quitApp = () => electronApp.quit(),
}) {
  return async function launchInstaller(event, installerPath) {
    if (!installerPath || typeof installerPath !== "string") {
      return { ok: false, reason: "invalid-path" };
    }

    if (hasActiveTasks()) {
      return { ok: false, reason: "active-tasks" };
    }

    try {
      if (platform === "win32") {
        spawn(installerPath, [], { detached: true, stdio: "ignore" }).unref();
      } else {
        const openError = await shell.openPath(installerPath);
        if (openError) {
          return { ok: false, reason: "launch-failed", message: openError };
        }
      }

      quitApp();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: "launch-failed",
        message: error && error.message ? error.message : String(error),
      };
    }
  };
}
