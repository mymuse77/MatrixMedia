"use strict";

/** 抖音按阶段和实际上传进展计时；硬上限保证异常页面不会永久占用队列。 */
export function createPublishWatchdog({ idleMs, maxMs, onTimeout }) {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let stage = "初始化";
  let submitted = false;
  let stopped = false;
  let idleTimer;
  let hardTimer;

  const snapshot = () => ({
    stage,
    submitted,
    elapsedMs: Date.now() - startedAt,
    idleMs: Date.now() - lastProgressAt,
  });
  const stop = () => {
    stopped = true;
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  };
  const expire = (kind) => {
    if (stopped) return;
    const details = { ...snapshot(), kind };
    stop();
    onTimeout(details);
  };
  const progress = () => {
    if (stopped) return;
    lastProgressAt = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire("idle"), idleMs);
  };
  hardTimer = setTimeout(() => expire("total"), maxMs);
  progress();

  return {
    progress,
    setStage(value, { progress: advances = true } = {}) {
      if (stopped || value === stage) return;
      stage = value;
      if (advances) progress();
    },
    markSubmitted() {
      if (stopped) return;
      submitted = true;
      stage = "等待平台发布确认";
      progress();
    },
    snapshot,
    stop,
  };
}
