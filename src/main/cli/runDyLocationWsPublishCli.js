"use strict";

/**
 * CLI：通过 websocketHandlers.handlePublishVideo 发布带地理位置的抖音视频。
 * 与 Web 端下发 publish_video 任务走同一条链路，便于复现地点选择问题。
 */

import fs from "fs";
import path from "path";
import { handlePublishVideo } from "../services/websocketHandlers";
import { getAccountPartition } from "../services/accountLoginStatus";

const DEFAULT_PHONE = "开发测试抖音2";
const DEFAULT_PLATFORM = "抖音";
const DEFAULT_VIDEO_DIR = "D:\\Files\\video\\shu-macroPreviews";
const DEFAULT_LOCATIONS = ["武汉站", "武汉东站", "襄阳站", "襄阳东站"];

function printHelp() {
  console.log(`
用法:
  electron . cli test-dy-location [选项]

通过 websocketHandlers.handlePublishVideo 模拟第三方 publish_video 任务，
向本机已登录的抖音号发布「带地理位置」的本地视频。

选项:
  --phone <名>         账号 phone（默认: ${DEFAULT_PHONE}）
  --platform <名>      平台（默认: ${DEFAULT_PLATFORM}）
  --location <地点>    单个地点（如 武汉东站）
  --locations <a,b>    多个地点逗号分隔；与 --all-locations 二选一
  --all-locations      依次发布默认地点: ${DEFAULT_LOCATIONS.join("、")}
  --file <path>        指定单个视频文件
  --dir <path>         视频目录（默认: ${DEFAULT_VIDEO_DIR}）
  --title <text>       标题（默认: 地点测试-<地点>）
  --description <text> 描述
  --tags <text>        标签（默认: #位置测试 #自动化）
  --show               显示发布浏览器窗口（推荐调试地点下拉）
  --no-close-window    发布后不自动关窗
  --limit <n>          最多发布 n 条（多地点时）
  -h, --help           帮助

示例:
  electron . cli test-dy-location --location 武汉东站 --show
  electron . cli test-dy-location --all-locations --show --limit 2
  electron . cli test-dy-location --file D:\\\\Files\\\\video\\\\shu-macroPreviews\\\\Reset_position.mp4 --location 襄阳站 --show
`);
}

function parseArgs(argv) {
  const out = {
    phone: DEFAULT_PHONE,
    platform: DEFAULT_PLATFORM,
    locations: [],
    allLocations: false,
    file: null,
    dir: DEFAULT_VIDEO_DIR,
    title: null,
    description: "",
    tags: "#位置测试 #自动化",
    show: false,
    closeWindowAfterPublish: true,
    limit: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--phone") out.phone = String(argv[++i] || "").trim();
    else if (a === "--platform") out.platform = String(argv[++i] || "").trim();
    else if (a === "--location") out.locations.push(String(argv[++i] || "").trim());
    else if (a === "--locations") {
      String(argv[++i] || "")
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((loc) => out.locations.push(loc));
    } else if (a === "--all-locations") out.allLocations = true;
    else if (a === "--file") out.file = String(argv[++i] || "").trim();
    else if (a === "--dir") out.dir = String(argv[++i] || "").trim();
    else if (a === "--title") out.title = String(argv[++i] || "");
    else if (a === "--description") out.description = String(argv[++i] || "");
    else if (a === "--tags") out.tags = String(argv[++i] || "");
    else if (a === "--show") out.show = true;
    else if (a === "--no-close-window") out.closeWindowAfterPublish = false;
    else if (a === "--limit") out.limit = Number(argv[++i]);
  }

  if (out.allLocations) {
    out.locations = [...DEFAULT_LOCATIONS];
  }
  if (!out.locations.length) {
    out.locations = ["武汉东站"];
  }
  if (out.limit != null && Number.isFinite(out.limit) && out.limit > 0) {
    out.locations = out.locations.slice(0, out.limit);
  }

  return out;
}

function listVideos(dir, singleFile) {
  if (singleFile) {
    const p = path.resolve(singleFile);
    if (!fs.existsSync(p)) {
      throw new Error(`视频文件不存在: ${p}`);
    }
    return [p];
  }
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) {
    throw new Error(`视频目录不存在: ${root}`);
  }
  const files = fs
    .readdirSync(root)
    .filter((name) => /\.(mp4|mov|webm|mkv)$/i.test(name))
    .map((name) => path.join(root, name))
    .sort();
  if (!files.length) {
    throw new Error(`目录下没有视频: ${root}`);
  }
  return files;
}

function createMockWsClient() {
  return {
    sendProgress(taskId, progress, message) {
      const p =
        typeof progress === "number" ? `${progress.toFixed(1)}%` : String(progress);
      console.log(`[ws-progress] task=${taskId} ${p} ${message || ""}`);
    },
    sendTaskResult(taskId, status, data) {
      console.log(
        `[ws-result] task=${taskId} status=${status}`,
        JSON.stringify(data || {}, null, 0).slice(0, 500),
      );
    },
  };
}

/**
 * @param {string[]} argv cli test-dy-location 之后的参数
 * @returns {Promise<number>} exit code
 */
export async function runDyLocationWsPublishCli(argv = []) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  const videos = listVideos(opts.dir, opts.file);
  const partition = getAccountPartition(opts.phone, opts.platform);
  const wsClient = createMockWsClient();

  console.log("[test-dy-location] 将走 websocketHandlers.handlePublishVideo");
  console.log(
    JSON.stringify(
      {
        phone: opts.phone,
        platform: opts.platform,
        partition,
        locations: opts.locations,
        videoCount: videos.length,
        show: opts.show,
        sampleVideo: videos[0],
      },
      null,
      2,
    ),
  );

  const results = [];
  for (let i = 0; i < opts.locations.length; i++) {
    const location = opts.locations[i];
    const videoPath = videos[i % videos.length];
    const taskId = `cli-dy-loc-${Date.now()}-${i}`;
    const title =
      (opts.title && String(opts.title).trim()) ||
      `地点测试-${location}-${path.basename(videoPath, path.extname(videoPath))}`;
    const description =
      (opts.description && String(opts.description).trim()) ||
      `自动化验证地理位置选择：${location}`;

    console.log("\n========================================");
    console.log(`[test-dy-location] (${i + 1}/${opts.locations.length})`);
    console.log(`  location : ${location}`);
    console.log(`  video    : ${videoPath}`);
    console.log(`  title    : ${title}`);
    console.log(`  taskId   : ${taskId}`);
    console.log("========================================\n");

    try {
      const result = await handlePublishVideo(
        {
          taskId,
          type: "publish_video",
          data: {
            phone: opts.phone,
            platform: opts.platform,
            partition,
            videoPath,
            title,
            taskName: `dy-location-${location}`,
            description,
            tags: opts.tags,
            location,
            show: opts.show,
            closeWindowAfterPublish: opts.closeWindowAfterPublish,
          },
        },
        wsClient,
      );
      console.log("[test-dy-location] 成功:", JSON.stringify(result));
      results.push({ location, videoPath, ok: true, result });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error("[test-dy-location] 失败:", message);
      results.push({ location, videoPath, ok: false, error: message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  console.log(
    "\n[test-dy-location] 汇总:",
    JSON.stringify(
      {
        total: results.length,
        succeeded,
        failed,
        results: results.map((r) => ({
          location: r.location,
          ok: r.ok,
          error: r.error || null,
          video: path.basename(r.videoPath),
        })),
      },
      null,
      2,
    ),
  );

  if (failed === 0) return 0;
  if (succeeded === 0) return 3;
  return 1;
}
