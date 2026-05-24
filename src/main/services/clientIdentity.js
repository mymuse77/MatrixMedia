const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_ROOT = "MatrixMedia";
const CLIENT_ID_PATTERN = /^mm-[0-9a-f-]{36}$/i;

function getIdentityFilePath() {
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("documents"), DATA_ROOT, "data", "client-identity.json");
    }
  } catch (_) {
    // Fallback for non-Electron execution such as script tests.
  }
  return path.resolve(__dirname, "..", "server", "data", "client-identity.json");
}

function readIdentity(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (_) {
    return null;
  }
}

function createClientId() {
  if (typeof crypto.randomUUID === "function") {
    return `mm-${crypto.randomUUID()}`;
  }
  const hex = crypto.randomBytes(16).toString("hex");
  return `mm-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getClientIdentity() {
  const filePath = getIdentityFilePath();
  const identity = readIdentity(filePath);

  if (identity && CLIENT_ID_PATTERN.test(String(identity.clientId || ""))) {
    return {
      ...identity,
      clientId: identity.clientId,
      identityPath: filePath,
    };
  }

  const now = new Date().toISOString();
  const nextIdentity = {
    clientId: createClientId(),
    createdAt: now,
    updatedAt: now,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(nextIdentity, null, 2), "utf-8");

  return {
    ...nextIdentity,
    identityPath: filePath,
  };
}

function getClientId() {
  return getClientIdentity().clientId;
}

module.exports = {
  getClientId,
  getClientIdentity,
};
