"use strict";

/**
 * 抖音「带地理位置」发布 — 模拟 websocketHandlers 入参
 *
 * 两种模式：
 * 1) 默认 dry-run：mock puppeteer，校验 payload.data.address / location 是否正确下发
 * 2) --live：拉起 electron CLI，走真实 handlePublishVideo + dy.js
 *
 * 用法：
 *   node scripts/test-ws-dy-location-publish.js
 *   node scripts/test-ws-dy-location-publish.js --live --location 武汉东站 --show
 *   node scripts/test-ws-dy-location-publish.js --live --all-locations --show --limit 2
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const DEFAULT_PHONE = "开发测试抖音2";
const DEFAULT_PLATFORM = "抖音";
const DEFAULT_VIDEO_DIR = "D:\\Files\\video\\shu-macroPreviews";
const DEFAULT_LOCATIONS = ["武汉站", "武汉东站", "襄阳站", "襄阳东站"];

function parseArgv(argv) {
  const out = {
    live: false,
    phone: DEFAULT_PHONE,
    platform: DEFAULT_PLATFORM,
    locations: [],
    allLocations: false,
    file: null,
    dir: DEFAULT_VIDEO_DIR,
    show: false,
    limit: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--phone") out.phone = argv[++i];
    else if (a === "--platform") out.platform = argv[++i];
    else if (a === "--location") out.locations.push(String(argv[++i] || "").trim());
    else if (a === "--locations") {
      String(argv[++i] || "")
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((x) => out.locations.push(x));
    } else if (a === "--all-locations") out.allLocations = true;
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--show") out.show = true;
    else if (a === "--limit") out.limit = Number(argv[++i]);
  }
  if (out.allLocations) out.locations = [...DEFAULT_LOCATIONS];
  if (!out.locations.length) out.locations = ["武汉东站"];
  if (out.limit > 0) out.locations = out.locations.slice(0, out.limit);
  return out;
}

function printHelp() {
  console.log(`
抖音地理位置发布测试（websocketHandlers 链路）

  node scripts/test-ws-dy-location-publish.js              # dry-run：校验 payload
  node scripts/test-ws-dy-location-publish.js --live --show  # 真实发布

选项同 electron . cli test-dy-location（--phone --location --all-locations --file --dir --show --limit）

默认账号: ${DEFAULT_PHONE}
默认视频目录: ${DEFAULT_VIDEO_DIR}
默认地点: ${DEFAULT_LOCATIONS.join("、")}
`);
}

function pickVideo(dir, file) {
  if (file) {
    const p = path.resolve(file);
    if (!fs.existsSync(p)) throw new Error(`视频不存在: ${p}`);
    return p;
  }
  const rootDir = path.resolve(dir);
  if (!fs.existsSync(rootDir)) {
    // dry-run 允许目录不存在时用临时假文件
    return null;
  }
  const files = fs
    .readdirSync(rootDir)
    .filter((n) => /\.(mp4|mov|webm|mkv)$/i.test(n))
    .sort();
  if (!files.length) return null;
  return path.join(rootDir, files[0]);
}

async function runDryRun(opts) {
  require("@babel/register")({
    extensions: [".js"],
    ignore: [/node_modules/],
    babelrc: false,
    configFile: false,
    presets: [
      ["@babel/preset-env", { modules: "commonjs", targets: { node: "current" } }],
    ],
  });

  const captured = [];
  const changeDataCalls = [];
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => path.join(os.tmpdir(), "matrixmedia-dy-loc-test"),
        },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    if (request === "../server/utils") {
      return {
        changeData: async (payload) => {
          changeDataCalls.push(payload);
          return { success: true, data: [] };
        },
      };
    }
    if (request === "./puppeteerFile") {
      return {
        runPuppeteerTask(data, transport, onFinish) {
          captured.push(data);
          setImmediate(() => {
            transport.reply("puppeteerFile-done", {
              ...data,
              status: true,
              message: "dry-run published",
            });
            if (typeof onFinish === "function") onFinish();
          });
        },
        createIpcTransport() {
          return { reply() {} };
        },
      };
    }
    if (request === "./resolvePublishFile") {
      return {
        resolvePublishFile: async (file) => ({
          localPath: path.resolve(file),
          remoteUrl: null,
          cleanup: null,
        }),
      };
    }
    if (request === "../config/ptConfig") {
      return {
        __esModule: true,
        default: {
          抖音: {
            index: "https://creator.douyin.com/",
            upload:
              "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
            useragent: "MatrixMediaTest/1.0",
            listIndex: "https://creator.douyin.com/",
          },
        },
      };
    }
    if (request === "./accountLoginStatus") {
      return {
        getAccountLoginStatus: async () => ({
          isLoggedIn: true,
          loginStatus: "valid",
        }),
        getAccountPartition: (phone, platform) => `persist:${phone}${platform}`,
      };
    }
    if (request === "./accountLoginWindow") {
      return { openAccountLoginWindow: async () => ({ ok: true }) };
    }
    if (request === "./scheduledPublish") {
      return {
        createScheduledRecord: (item) => item,
        schedulePublishRecord: () => {},
        subscribeScheduledPublishEvents: () => () => {},
      };
    }
    if (request === "./appSettings") {
      return { getAppSettings: () => ({}) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    let videoPath = pickVideo(opts.dir, opts.file);
    if (!videoPath) {
      videoPath = path.join(os.tmpdir(), "matrixmedia-dy-loc-fake.mp4");
      fs.writeFileSync(videoPath, "fake-video");
      console.log("[dry-run] 使用临时假视频:", videoPath);
    } else {
      console.log("[dry-run] 使用视频:", videoPath);
    }

    const { handlePublishVideo } = require("../src/main/services/websocketHandlers");

    const wsClient = {
      sendProgress(taskId, progress, message) {
        console.log(`[dry-run progress] ${progress}% ${message || ""}`);
      },
      sendTaskResult() {},
    };

    for (let i = 0; i < opts.locations.length; i++) {
      const location = opts.locations[i];
      const taskId = `dry-dy-loc-${Date.now()}-${i}`;
      console.log(`\n[dry-run] 模拟 publish_video location=${location}`);

      const before = captured.length;
      const result = await handlePublishVideo(
        {
          taskId,
          type: "publish_video",
          data: {
            phone: opts.phone,
            platform: opts.platform,
            videoPath,
            title: `地点测试-${location}`,
            taskName: `dry-${location}`,
            description: `验证地理位置：${location}`,
            tags: "#位置测试 #自动化",
            location,
            show: opts.show,
          },
        },
        wsClient,
      );

      assert.ok(result && result.success, "handlePublishVideo 应 success");
      assert.strictEqual(captured.length, before + 1, "应触发一次 runPuppeteerTask");

      const payload = captured[captured.length - 1];
      console.log(
        "[dry-run] puppeteer payload 摘要:",
        JSON.stringify(
          {
            pt: payload.pt,
            phone: payload.phone,
            partition: payload.partition,
            filePath: payload.filePath,
            show: payload.show,
            data: payload.data,
          },
          null,
          2,
        ),
      );

      assert.strictEqual(payload.pt, "抖音");
      assert.strictEqual(payload.phone, opts.phone);
      assert.ok(payload.data, "payload.data 必须存在");
      assert.strictEqual(
        payload.data.address,
        location,
        `data.address 应为 ${location}`,
      );
      assert.strictEqual(
        payload.data.location,
        location,
        `data.location 应为 ${location}`,
      );
      assert.ok(
        String(payload.data.bt1 || "").includes(location) ||
          payload.data.bt1 === `地点测试-${location}`,
        "标题应带地点信息",
      );
      console.log(`[dry-run] ✓ location=${location} 已正确写入 data.address`);
    }

    console.log(
      `\n[dry-run] 全部通过：${opts.locations.length} 个地点，payload 字段对齐 dy.js`,
    );
    console.log(
      "真实发布请执行:\n  node scripts/test-ws-dy-location-publish.js --live --location 武汉东站 --show",
    );
    console.log(
      "或:\n  electron . cli test-dy-location --location 武汉东站 --show",
    );
  } finally {
    Module._load = originalLoad;
  }
}

function runLive(opts) {
  const electronBin = require("electron");
  const cliArgs = [
    ".",
    "cli",
    "test-dy-location",
    "--phone",
    opts.phone,
    "--platform",
    opts.platform,
  ];

  if (opts.allLocations || opts.locations.length > 1) {
    if (opts.locations.length === DEFAULT_LOCATIONS.length &&
      opts.locations.every((v, i) => v === DEFAULT_LOCATIONS[i])) {
      cliArgs.push("--all-locations");
    } else {
      cliArgs.push("--locations", opts.locations.join(","));
    }
  } else {
    cliArgs.push("--location", opts.locations[0]);
  }

  if (opts.file) cliArgs.push("--file", opts.file);
  else if (opts.dir) cliArgs.push("--dir", opts.dir);
  if (opts.show) cliArgs.push("--show");
  if (opts.limit > 0) cliArgs.push("--limit", String(opts.limit));

  console.log("[live] 启动:", electronBin, cliArgs.join(" "));
  console.log("[live] 请确保账号已登录:", opts.phone, opts.platform);

  const childEnv = { ...process.env };
  // Electron 只要检测到这个变量存在就会以 Node 模式运行；赋空字符串仍会
  // 导致主进程中的 require("electron") 返回路径字符串而不是 Electron API。
  delete childEnv.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    const child = spawn(electronBin, cliArgs, {
      cwd: root,
      stdio: "inherit",
      env: childEnv,
      shell: false,
    });
    child.on("exit", (code) => resolve(code || 0));
    child.on("error", (err) => {
      console.error("[live] 启动 electron 失败:", err.message);
      console.error(
        "可手动执行: electron . cli test-dy-location --location 武汉东站 --show",
      );
      resolve(1);
    });
  });
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.live) {
    return runLive(opts);
  }
  await runDryRun(opts);
  return 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
