"use strict";

export function resolveTaskTransportStatus(taskType, result) {
  if (taskType !== "publish_videos") return "success";

  const businessStatus = String(result?.status || "");
  if (
    result?.success === false ||
    businessStatus === "partial" ||
    businessStatus === "failed"
  ) {
    return "failed";
  }

  return "success";
}
