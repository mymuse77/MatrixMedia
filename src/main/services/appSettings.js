"use strict";

import { changeData } from "../server/utils";
import { normalizeAppSettings } from "../../shared/appSettings";

export function getAppSettings() {
  const res = changeData({
    fileName: "appSettings",
    type: "config",
    item: { action: "get" },
  });
  return normalizeAppSettings(res && res.data);
}

export function updateAppSettings(patch = {}) {
  const next = normalizeAppSettings({
    ...getAppSettings(),
    ...(patch || {}),
  });
  changeData({
    fileName: "appSettings",
    type: "config",
    item: {
      action: "update",
      data: next,
    },
  });
  return next;
}
