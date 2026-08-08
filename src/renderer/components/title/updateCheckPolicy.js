export const UPDATE_CHECK_DATE_KEY = "matrixmedia-update-check-date";

export function getUpdateCheckDate(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shouldRunDailyUpdateCheck({
  storage,
  now = new Date(),
  key = UPDATE_CHECK_DATE_KEY,
} = {}) {
  // 保留该导出以兼容旧调用方，但不再按日期限制启动更新检查。
  void storage;
  void now;
  void key;
  return true;
}
