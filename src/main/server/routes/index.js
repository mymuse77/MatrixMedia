var express = require("express");
const { changeData } = require("../utils");
const { getClientIdentity } = require("../../services/clientIdentity");

var router = express.Router();

function sendClientIdentity(req, res) {
  try {
    const identity = getClientIdentity();
    res.json({
      success: true,
      clientId: identity.clientId,
      clientType: "matrix_pc_client",
      createdAt: identity.createdAt || "",
      updatedAt: identity.updatedAt || "",
    });
  } catch (error) {
    console.error("[HTTP /client-id]", error);
    res.status(500).json({
      success: false,
      message: error && error.message ? error.message : String(error),
    });
  }
}

router.get("/", function (req, res) {
  res.send("<h1>MatrixMedia API</h1>");
});

router.get("/test", function (req, res) {
  res.json({
    success: true,
    message: "ok",
  });
});

router.get("/client-id", sendClientIdentity);
router.get("/clientId", sendClientIdentity);

router.get("/platforms", async function (req, res) {
  try {
    const { getVideoPublishPlatformList } = await import(
      "../../../shared/publishPlatforms.js"
    );
    const ptConfig = (await import("../../config/ptConfig.js")).default;
    res.json({
      success: true,
      platforms: getVideoPublishPlatformList(ptConfig),
    });
  } catch (error) {
    console.error("[HTTP /platforms]", error);
    res.status(500).json({
      success: false,
      message: error && error.message ? error.message : String(error),
    });
  }
});

router.get("/creative-statements", async function (req, res) {
  try {
    const { getCreativeStatementApiSpec } = await import(
      "../../../shared/creativeStatement.js"
    );
    res.json({
      success: true,
      ...getCreativeStatementApiSpec(),
    });
  } catch (error) {
    console.error("[HTTP /creative-statements]", error);
    res.status(500).json({
      success: false,
      message: error && error.message ? error.message : String(error),
    });
  }
});

router.post("/changeData", function (req, res) {
  res.send(changeData({ ...req.body }));
});

router.post("/publish", async function (req, res) {
  try {
    const { parseMultiPublishRequest } = await import(
      "../../cli/parsePublishArgs.js"
    );
    const publishService = await import("../../services/publishVideo.js");

    const parsed = parseMultiPublishRequest(req.body || {});
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        status: "failed",
        message: parsed.error,
      });
    }

    const result = parsed.multi
      ? await publishService.runMultiPlatformPublish(parsed.value)
      : await publishService.runSingleFilePublish(parsed.value);

    const success = result.success === true || result.exitCode === 0;
    const httpStatus =
      result.exitCode === 2 && !parsed.multi ? 400 : success ? 200 : 200;

    const response = { ...result };
    response.success = success;
    if (parsed.skipped && parsed.skipped.length > 0) {
      response.skipped = parsed.skipped;
    }

    return res.status(httpStatus).json(response);
  } catch (error) {
    console.error("[HTTP /publish]", error);
    return res.status(500).json({
      success: false,
      status: "failed",
      message: error && error.message ? error.message : String(error),
    });
  }
});

module.exports = router;
