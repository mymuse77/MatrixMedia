<template>
  <div class="container-box">
    <header class="manager-header">
      <div class="manager-header-copy">
        <div class="manager-eyebrow">本地发布工具</div>
        <h1>视频管理</h1>
        <p>
          统一查看本机发布记录、状态同步和发布日志。失败项可直接重发，所有内容都来自本机 pushData。
        </p>
      </div>
      <div class="manager-header-actions">
        <el-button type="primary" @click="selectVideoFile"
          >选择视频发布</el-button
        >
        <el-button type="primary" @click="openDirectoryPublish"
          >目录发布</el-button
        >
        <el-button type="success" @click="openArticlePublish"
          >发布文章</el-button
        >
        <el-tooltip content="数据刷新" placement="bottom">
          <el-button
            icon="el-icon-refresh"
            circle
            :loading="recordsLoading"
            @click="refreshRecords"
          />
        </el-tooltip>
      </div>
    </header>

    <section class="summary-grid">
      <div
        v-for="card in summaryCards"
        :key="card.label"
        class="summary-card"
        :class="card.className"
      >
        <div class="summary-card-label">{{ card.label }}</div>
        <div class="summary-card-value">{{ card.value }}</div>
        <div class="summary-card-hint">{{ card.hint }}</div>
      </div>
    </section>

    <LocalVideoPublish ref="localPublishRef" @published="loadRecords" />
    <LocalArticlePublish ref="articlePublishRef" @published="loadRecords" />

    <el-dialog
      title="填写发布内容"
      :visible.sync="contentDialogVisible"
      width="860px"
      top="8vh"
      append-to-body
      custom-class="publish-content-dialog"
    >
      <div v-if="contentContext" class="content-detail">
        <div class="content-summary">
          <div>
            <div class="content-title">{{ contentContext.bt || "-" }}</div>
            <div class="content-subtitle">
              {{ contentContext.textOtherName || contentContext.bookName || "-" }}
            </div>
          </div>
          <el-tag size="small" type="info">{{ contentContext.selectedFile || "未记录文件名" }}</el-tag>
        </div>
        <el-descriptions :column="2" border size="small" class="content-descriptions">
          <el-descriptions-item label="名称">
            {{ contentContext.textOtherName || contentContext.bookName || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="视频标题">
            {{ contentContext.bt || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="概括短标题">
            {{ contentContext.bt2 || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="视频标签">
            {{ contentContext.bq || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="创作声明">
            {{ creativeStatementText(contentContext.creativeStatement) }}
          </el-descriptions-item>
          <el-descriptions-item label="发布模式">
            {{ publishModeText(contentContext) }}
          </el-descriptions-item>
          <el-descriptions-item label="定时发布">
            {{ contentContext.scheduledPublishAtText || "-" }}
          </el-descriptions-item>
          <el-descriptions-item label="视频路径">
            {{ contentContext.filePath || "-" }}
          </el-descriptions-item>
        </el-descriptions>
        <div class="content-section-title">发布平台</div>
        <el-table
          :data="contentPlatforms"
          border
          size="small"
          class="content-platform-table"
        >
          <el-table-column prop="pt" label="平台" min-width="90" />
          <el-table-column prop="phone" label="账号" min-width="110" show-overflow-tooltip />
          <el-table-column prop="bt" label="标题" min-width="150" show-overflow-tooltip />
          <el-table-column prop="bq" label="标签" min-width="140" show-overflow-tooltip />
          <el-table-column label="声明" min-width="90" show-overflow-tooltip>
            <template slot-scope="scope">
              {{ creativeStatementText(scope.row.creativeStatement) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template slot-scope="scope">
              <el-tag size="mini" :type="publishStatusType(scope.row.publishStatus)">
                {{ publishStatusText(scope.row.publishStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastPublishMessage" label="结果说明" min-width="180" show-overflow-tooltip />
        </el-table>
      </div>
    </el-dialog>

    <el-dialog
      title="发布日志"
      :visible.sync="logDialogVisible"
      width="76%"
      top="6vh"
      append-to-body
    >
      <div v-loading="logLoading" class="publish-log-dialog">
        <div v-if="logContext" class="log-summary">
          <div>
            <div class="log-title">{{ logContext.textOtherName || logContext.bookName || "-" }}</div>
            <div class="log-subtitle">
              {{ logContext.selectedFile || logContext.filePath || "-" }}
            </div>
          </div>
          <div class="log-actions">
            <el-button size="mini" @click="copyVisibleLogs">复制日志</el-button>
            <el-button size="mini" :loading="logLoading" @click="reloadLogs">刷新</el-button>
          </div>
        </div>
        <el-empty v-if="!logLoading && logRuns.length === 0" description="暂无发布日志" />
        <template v-else>
          <div class="log-run-list">
            <div
              v-for="run in logRuns"
              :key="run.id"
              class="log-run-item"
              :class="{ active: run.id === selectedLogRunId }"
              @click="selectedLogRunId = run.id"
            >
              <div class="log-run-main">
                <span>{{ run.platform || "-" }}</span>
                <span>{{ run.phone || "-" }}</span>
                <span>{{ run.videoFile || "-" }}</span>
              </div>
              <el-tag size="mini" :type="publishRunStatusType(run.status)">
                {{ publishRunStatusText(run.status) }}
              </el-tag>
            </div>
          </div>
          <el-tabs v-model="activeLogTab" class="log-tabs">
            <el-tab-pane label="当前记录" name="current" />
            <el-tab-pane label="同任务全部" name="all" />
            <el-tab-pane label="错误" name="errors" />
            <el-tab-pane
              v-for="platformName in logPlatforms"
              :key="platformName"
              :label="platformName"
              :name="'platform:' + platformName"
            />
          </el-tabs>
          <div class="log-timeline">
            <div v-for="log in visibleLogEntries" :key="log.id" class="log-line">
              <span class="log-time">{{ formatLogTime(log.time) }}</span>
              <el-tag size="mini" :type="logLevelType(log.level)">{{ log.level || "info" }}</el-tag>
              <span class="log-stage">{{ log.stage || "-" }}</span>
              <span class="log-message">{{ log.message || "-" }}</span>
              <span v-if="log.detail" class="log-detail">{{ log.detail }}</span>
            </div>
            <el-empty v-if="visibleLogEntries.length === 0" description="当前筛选下暂无日志" />
          </div>
        </template>
      </div>
    </el-dialog>

    <div class="info-box">
      <template v-for="(item, index) in dataList">
        <el-card v-if="item && item.length" :key="index" class="record-card mb16">
          <div class="card-head">
            <div class="card-head-copy">
              <span class="date-label">{{ index }}</span>
              <span class="hint">本地发布记录</span>
              <span class="head-meta">{{ getGroupSummary(item).taskCount }} 条任务 · {{ getGroupSummary(item).platformCount }} 条平台明细</span>
            </div>
            <div class="card-head-stats">
              <el-tag size="mini" type="success">成功 {{ getGroupSummary(item).successCount }}</el-tag>
              <el-tag size="mini" type="danger">失败 {{ getGroupSummary(item).failCount }}</el-tag>
              <el-tag size="mini" type="warning">进行中 {{ getGroupSummary(item).activeCount }}</el-tag>
            </div>
          </div>
          <el-table :data="item" border style="width: 100%" class="responsive-table">
            <el-table-column label="名称" min-width="180" show-overflow-tooltip>
              <template slot-scope="scope">
                <div class="record-name-cell">
                  <div class="record-name">{{ scope.row.textOtherName || "-" }}</div>
                  <div class="record-subtitle">
                    <span>{{ scope.row.bt || "-" }}</span>
                    <el-tag size="mini" type="info">{{ scope.row.textType === "article" ? "文章" : "视频" }}</el-tag>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="平台状态" min-width="280">
              <template slot-scope="scope">
                <div
                  v-for="(sub, si) in scope.row.showAlltype"
                  :key="si"
                  class="status-row"
                >
                  <span class="pt-name" @click="copy(sub.videoLink)">{{ sub.pt }}</span>
                  <el-tag size="mini" :type="sub.videoLink ? 'success' : 'danger'">
                    {{ sub.videoLink ? "通过" : "未通过" }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="phone" label="发布账号" align="center" header-align="center" min-width="110" />
            <el-table-column label="发布进度" min-width="420">
              <template slot-scope="scope">
                <div
                  v-for="(sub, si) in scope.row.showAlltype"
                  :key="si"
                  class="progress-row"
                >
                  <span class="pt-name">{{ sub.pt }}</span>
                  <div class="progress-detail">
                    <span class="progress-count">重发 {{ normalizeCount(sub.republishCount) }} 次</span>
                    <span class="progress-count success">成功 {{ normalizeCount(sub.publishSuccessCount) }}</span>
                    <span class="progress-count fail">失败 {{ normalizeCount(sub.publishFailCount) }}</span>
                    <el-tag size="mini" :type="publishStatusType(sub.publishStatus)">
                      {{ publishStatusText(sub.publishStatus) }}
                    </el-tag>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="来源" width="72">
              <template slot-scope="scope">
                {{ scope.row.textType === "article" ? "文章" : "本地" }}
              </template>
            </el-table-column>
            <el-table-column label="操作" min-width="200">
              <template slot-scope="scope">
                <el-button
                  v-if="canViewPublishContent(scope.row)"
                  type="success"
                  size="mini"
                  class="mb8"
                  @click="handleViewPublishContent(scope.row)"
                >
                  填写内容
                </el-button>
                <el-button
                  type="info"
                  size="mini"
                  class="mb8"
                  :loading="logLoading && logContext === scope.row"
                  @click="handleGetLogs(scope.row)"
                >
                  日志
                </el-button>
                <el-button
                  v-if="canGetStatus(scope.row)"
                  type="primary"
                  size="mini"
                  class="mb8"
                  :loading="isStatusLoading(scope.row)"
                  :disabled="isStatusLoading(scope.row)"
                  @click="handleGetStatus(scope.row)"
                >
                  获取状态
                </el-button>
                <el-popconfirm
                  confirm-button-text="删除"
                  cancel-button-text="取消"
                  icon="el-icon-info"
                  icon-color="red"
                  title="确定删除这条记录吗？"
                  @confirm="handleDelete(scope.row, index, scope.$index)"
                >
                  <el-button slot="reference" type="danger" size="mini"
                    >删除</el-button
                  >
                </el-popconfirm>
                <el-button
                  v-if="canRepublish(scope.row)"
                  type="warning"
                  size="mini"
                  class="mb8"
                  @click="handleRepublish(scope.row)"
                >
                  重新发布
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </template>
    </div>

    <!-- 旧的 <webview> 登录弹窗已迁移到主进程独立 BrowserWindow -->
  </div>
</template>

<script>
import { ipcRenderer } from "electron";
import dataRequest from "@/utils/dataRequest";
import copyToClipboard from "@/utils/copy";
import ptConfig from "@/utils/configUrl";
import openLoginWindow from "@/utils/openLoginWindow";
import LocalVideoPublish from "@/components/LocalVideoPublish.vue";
import LocalArticlePublish from "@/components/LocalArticlePublish.vue";

export default {
  name: "VideoManager",
  components: {
    LocalVideoPublish,
    LocalArticlePublish,
  },
  data() {
    return {
      // 抖音获取发布状态的class名称
      statusCalss: ".video-card-zQ02ng",
      ptConfig,
      dataList: {},
      taskHandlers: new Map(),
      statusLoadingMap: {},
      recordsLoading: false,
      logDialogVisible: false,
      logLoading: false,
      activeLogTab: "current",
      selectedLogRunId: "",
      logRuns: [],
      logEntries: [],
      logContext: null,
      contentDialogVisible: false,
      contentContext: null,
      loginData: {},
      showLoginDialog: false,
    };
  },
  computed: {
    contentPlatforms() {
      return (this.contentContext && this.contentContext.showAlltype) || [];
    },
    logPlatforms() {
      return Array.from(
        new Set((this.logRuns || []).map((run) => run.platform).filter(Boolean))
      );
    },
    visibleLogEntries() {
      const entries = this.logEntries || [];
      if (this.activeLogTab === "errors") {
        return entries.filter((log) => ["error", "warn"].includes(log.level));
      }
      if (this.activeLogTab.startsWith("platform:")) {
        const platform = this.activeLogTab.replace("platform:", "");
        const runIds = new Set(
          this.logRuns
            .filter((run) => run.platform === platform)
            .map((run) => run.id)
        );
        return entries.filter((log) => runIds.has(log.runId));
      }
      if (this.activeLogTab === "current" && this.selectedLogRunId) {
        return entries.filter((log) => log.runId === this.selectedLogRunId);
      }
      return entries;
    },
    videoManagerSummary() {
      const summary = {
        groupCount: 0,
        taskCount: 0,
        platformCount: 0,
        successCount: 0,
        failCount: 0,
        activeCount: 0,
      };

      Object.values(this.dataList || {}).forEach((rows) => {
        if (!Array.isArray(rows) || rows.length === 0) return;
        summary.groupCount += 1;

        rows.forEach((row) => {
          summary.taskCount += 1;
          const details = Array.isArray(row && row.showAlltype) && row.showAlltype.length ? row.showAlltype : [row];
          summary.platformCount += details.length;

          details.forEach((sub) => {
            const status = String((sub && sub.publishStatus) || "").toLowerCase();
            if (status === "success") {
              summary.successCount += 1;
            } else if (["fail", "failed", "expired"].includes(status)) {
              summary.failCount += 1;
            } else {
              summary.activeCount += 1;
            }
          });
        });
      });

      return summary;
    },
    summaryCards() {
      const summary = this.videoManagerSummary;
      return [
        { label: "日期分组", value: summary.groupCount, hint: "按日期归档的记录", className: "is-neutral" },
        { label: "发布任务", value: summary.taskCount, hint: "去重后的任务条目", className: "is-primary" },
        { label: "平台明细", value: summary.platformCount, hint: "账号 / 平台维度", className: "is-info" },
        { label: "成功", value: summary.successCount, hint: "已写入成功状态", className: "is-success" },
        { label: "失败", value: summary.failCount, hint: "可直接重发", className: "is-danger" },
        { label: "进行中", value: summary.activeCount, hint: "发布中或待刷新", className: "is-warning" },
      ];
    },
  },
  mounted() {
    this._onPuppeteerDone = (event, data) => {
      const { taskId } = data;
      const handler = this.taskHandlers.get(taskId);
      if (handler) {
        handler(data);
        this.taskHandlers.delete(taskId);
      } else {
        this.syncPublishProgress(data);
      }
    };
    ipcRenderer.on("puppeteerFile-done", this._onPuppeteerDone);
    this._setupResizeObserver();
  },
  beforeDestroy() {
    ipcRenderer.removeListener("puppeteerFile-done", this._onPuppeteerDone);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  },
  activated() {
    this.loadRecords();
  },
  methods: {
    copy: copyToClipboard,
    _relayoutTables() {
      if (this._relayoutRaf) cancelAnimationFrame(this._relayoutRaf);
      this._relayoutRaf = requestAnimationFrame(() => {
        this._relayoutRaf = null;
        this.$el && this.$el.querySelectorAll('.el-table').forEach(table => {
          const vm = table.__vue__;
          if (vm && vm.doLayout) {
            vm.doLayout();
            table.querySelectorAll('colgroup col').forEach(col => {
              col.style.removeProperty('min-width');
            });
          }
        });
      });
    },
    _setupResizeObserver() {
      this._resizeObserver = new ResizeObserver(() => this._relayoutTables());
      this._resizeObserver.observe(this.$el);
    },
    canViewPublishContent(row) {
      return row && row.textType === "local";
    },
    handleViewPublishContent(row) {
      if (!this.canViewPublishContent(row)) {
        this.$message.warning("当前记录不是视频发布内容");
        return;
      }
      this.contentContext = row;
      this.contentDialogVisible = true;
    },
    creativeStatementText(value) {
      if (!value) return "-";
      const map = {
        auto: "自动判断",
        original: "原创",
        reproduced: "转载/非原创",
        ai: "AI 生成",
      };
      return map[value] || value;
    },
    publishModeText(row) {
      if (!row) return "-";
      if (row.publishMode === "draft" || row.publishToDraft) return "保存草稿";
      if (row.scheduledTask || row.scheduledPublishAt) return "定时发布";
      return "立即发布";
    },
    flattenDataResponse(data) {
      const result = [];
      Object.values(data || {}).forEach((rows) => {
        result.push(...(rows || []));
      });
      return result;
    },
    getRunPhone(run) {
      return String((run && run.phone) || "").split("-")[0];
    },
    getRunVideoFile(run) {
      return this.getFileName(run && (run.videoFile || run.filePath));
    },
    isRunMatchRecord(run, record) {
      if (!run || !record) return false;
      if (run.pushDataId && record.id && run.pushDataId === record.id) {
        return true;
      }
      const runTaskId = this.recordValue(run.taskId);
      const recordTaskId = this.recordValue(record.taskId);
      if (runTaskId && recordTaskId && runTaskId === recordTaskId) {
        return true;
      }
      return (
        this.recordValue(run.taskName) ===
          this.recordValue(record.textOtherName || record.bookName) &&
        this.recordValue(run.platform) === this.recordValue(record.pt) &&
        this.getRunPhone(run) === this.getRecordPhone(record) &&
        this.getRunVideoFile(run) === this.getFileName(record.selectedFile)
      );
    },
    async handleGetLogs(row) {
      this.logDialogVisible = true;
      this.logContext = row;
      this.activeLogTab = "current";
      await this.loadPublishLogs(row);
    },
    async reloadLogs() {
      if (!this.logContext) return;
      await this.loadPublishLogs(this.logContext);
    },
    async loadPublishLogs(row) {
      this.logLoading = true;
      try {
        const [runsResponse, logsResponse] = await Promise.all([
          dataRequest({
            type: "get",
            fileName: "publishRuns",
            item: { pageSize: 90 },
          }),
          dataRequest({
            type: "get",
            fileName: "publishRunLogs",
            item: { pageSize: 90 },
          }),
        ]);
        const details = (row && row.showAlltype) || [row];
        const runs = this.flattenDataResponse(runsResponse.data)
          .filter((run) => details.some((record) => this.isRunMatchRecord(run, record)))
          .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
        const runIds = new Set(runs.map((run) => run.id));
        const logs = this.flattenDataResponse(logsResponse.data)
          .filter((log) => runIds.has(log.runId))
          .sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
        this.logRuns = runs;
        this.logEntries = logs;
        this.selectedLogRunId = runs[0] ? runs[0].id : "";
      } catch (error) {
        console.error("读取发布日志失败", error);
        this.$message.error("读取发布日志失败");
      } finally {
        this.logLoading = false;
      }
    },
    copyVisibleLogs() {
      const text = this.visibleLogEntries
        .map(
          (log) =>
            `[${this.formatLogTime(log.time)}] [${log.level || "info"}] [${
              log.stage || "-"
            }] ${log.message || ""}${log.detail ? " " + log.detail : ""}`
        )
        .join("\n");
      if (!text) {
        this.$message.warning("当前没有可复制的日志");
        return;
      }
      this.copy(text);
      this.$message.success("日志已复制");
    },
    formatLogTime(value) {
      const time = Number(value);
      if (!Number.isFinite(time)) return "-";
      return new Date(time).toLocaleString();
    },
    logLevelType(level) {
      if (level === "error") return "danger";
      if (level === "warn") return "warning";
      if (level === "success") return "success";
      return "info";
    },
    publishRunStatusType(status) {
      if (status === "success") return "success";
      if (["failed", "interrupted"].includes(status)) return "danger";
      if (status === "skipped") return "info";
      return "warning";
    },
    publishRunStatusText(status) {
      if (status === "success") return "成功";
      if (status === "failed") return "失败";
      if (status === "interrupted") return "已中断";
      if (status === "skipped") return "已跳过";
      return "发布中";
    },
    getStatusRowKey(row) {
      if (!row) return "";
      return [
        row.textOtherName || "",
        String(row.phone || "").split("-")[0],
        row.selectedFile || "",
      ].join("-");
    },
    isStatusLoading(row) {
      const key = this.getStatusRowKey(row);
      return !!this.statusLoadingMap[key];
    },
    async handleGetStatus(row) {
      if (!this.canGetStatus(row) || this.isStatusLoading(row)) return;
      const canContinue = await this.confirmAndInterruptUploadingTasks();
      if (!canContinue) return;
      const key = this.getStatusRowKey(row);
      this.$set(this.statusLoadingMap, key, true);
      this.getStatus(row.showAlltype).catch((err) => {
        console.error("获取状态失败:", err);
      });
      setTimeout(() => {
        this.$set(this.statusLoadingMap, key, false);
        this.$alert("状态获取处理中，请等待 1-2 分钟后再查看结果。", "声明", {
          confirmButtonText: "知道了",
          type: "warning",
        });
      }, 10000);
    },
    canGetStatus(row) {
      if (!row) return false;
      if (row.textType !== "article") return true;
      return (row.showAlltype || [row]).some(
        (item) => item && item.textType === "article" && item.pt === "掘金"
      );
    },
    isUploadingPublishStatus(status) {
      return ["publishing", "drafting"].includes(String(status || ""));
    },
    getUploadingPublishRecords() {
      const recordMap = new Map();
      Object.values(this.dataList || {}).forEach((rows) => {
        (rows || []).forEach((row) => {
          (row.showAlltype || []).forEach((sub) => {
            if (
              sub &&
              sub.id &&
              sub.date &&
              this.isUploadingPublishStatus(sub.publishStatus)
            ) {
              recordMap.set(`${sub.date}-${sub.id}`, sub);
            }
          });
        });
      });
      return Array.from(recordMap.values());
    },
    async confirmAndInterruptUploadingTasks() {
      const records = this.getUploadingPublishRecords();
      if (records.length === 0) return true;
      try {
        await this.$confirm(
          `当前存在 ${records.length} 个发布中任务。获取状态会中断上传，确认后会将全部上传中任务标记为失败，并主动打断上传任务。是否继续？`,
          "获取状态",
          {
            confirmButtonText: "确认中断并获取状态",
            cancelButtonText: "取消",
            type: "warning",
          }
        );
      } catch (_) {
        return false;
      }
      ipcRenderer.send("puppeteerFile:cancelAll", {
        reason: "获取状态已中断上传",
      });
      await Promise.all(
        records.map((item) =>
          dataRequest({
            type: "update",
            fileName: "pushData",
            item: {
              id: item.id,
              date: item.date,
              publishStatus: "failed",
              publishFailCount: this.normalizeCount(item.publishFailCount) + 1,
              lastPublishMessage: "获取状态已中断上传",
              lastPublishAt: Date.now(),
            },
          })
        )
      );
      this.loadRecords();
      this.$message.warning("已中断上传任务，并将上传中记录标记为失败。");
      return true;
    },
    normalizeCount(v) {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    },
    publishStatusType(status) {
      if (status === "success") return "success";
      if (status === "fail" || status === "failed" || status === "expired")
        return "danger";
      if (status === "scheduled" || status === "skipped") return "info";
      if (status === "draft") return "info";
      return "warning";
    },
    publishStatusText(status) {
      if (status === "success") return "成功";
      if (status === "fail" || status === "failed") return "失败";
      if (status === "scheduled") return "等待定时发布";
      if (status === "skipped") return "已跳过";
      if (status === "expired") return "任务过期";
      if (status === "draft") return "已保存草稿";
      if (status === "drafting") return "保存草稿中";
      return "发布中";
    },
    getGroupSummary(rows) {
      const summary = {
        taskCount: 0,
        platformCount: 0,
        successCount: 0,
        failCount: 0,
        activeCount: 0,
      };

      (rows || []).forEach((row) => {
        summary.taskCount += 1;
        const details = Array.isArray(row && row.showAlltype) && row.showAlltype.length ? row.showAlltype : [row];
        summary.platformCount += details.length;

        details.forEach((sub) => {
          const status = String((sub && sub.publishStatus) || "").toLowerCase();
          if (status === "success") {
            summary.successCount += 1;
          } else if (["fail", "failed", "expired"].includes(status)) {
            summary.failCount += 1;
          } else {
            summary.activeCount += 1;
          }
        });
      });

      return summary;
    },
    isPublishFailed(row) {
      if (!row) return false;
      if (
        ["fail", "failed", "expired"].includes(String(row.publishStatus || ""))
      )
        return true;
      if (
        Number(row.publishFailCount) > 0 &&
        Number(row.publishSuccessCount) === 0
      )
        return true;
      if (String(row.lastPublishMessage || "").includes("失败")) return true;
      if (String(row.lastPublishMessage || "").includes("过期")) return true;
      return false;
    },
    canRepublish(row) {
      return row && (row.textType === "local" || row.textType === "article");
    },
    async handleRepublish(row) {
      const details = (row && row.showAlltype) || [];
      if (!details.length) {
        this.$message.warning("当前记录没有可重发的平台");
        return;
      }
      if (row.textType === "article") {
        const sample = details[0] || {};
        const failedTargets = details.filter(this.isPublishFailed).map((v) => ({
          pt: v.pt,
          phone: String(v.phone || "").split("-")[0],
        }));
        const ok = this.$refs.articlePublishRef.openRepublish({
          sample,
          records: details.map((v) => ({
            id: v.id,
            date: v.date,
            pt: v.pt,
            phone: String(v.phone || "").split("-")[0],
            publishAttemptCount: Number(v.publishAttemptCount) || 1,
            republishCount: Number(v.republishCount),
          })),
          failedTargets,
        });
        if (!ok) return;
        if (failedTargets.length === 0) {
          this.$message.info(
            "未检测到失败平台，已打开发布弹窗，请手动勾选需要重发的平台。"
          );
        }
        return;
      }
      let filePath = details.map((v) => v && v.filePath).find(Boolean);
      if (!filePath) {
        this.$message.info("历史记录缺少视频路径，请先重新选择视频文件。");
        filePath = await ipcRenderer.invoke("dialog:openVideoFile");
        if (!filePath) {
          this.$message.warning("未选择视频文件，已取消重发。");
          return;
        }
      } else {
        let shouldChooseNewVideo = false;
        try {
          await this.$confirm("是否重新选择视频文件后再重发？", "重新发布", {
            confirmButtonText: "重新选择视频",
            cancelButtonText: "沿用原视频",
            distinguishCancelAndClose: true,
            type: "warning",
          });
          shouldChooseNewVideo = true;
        } catch (action) {
          if (action === "close") {
            this.$message.info("已取消重发。");
            return;
          }
        }
        if (shouldChooseNewVideo) {
          const selectedPath = await ipcRenderer.invoke("dialog:openVideoFile");
          if (!selectedPath) {
            this.$message.warning("未选择视频文件，已取消重发。");
            return;
          }
          filePath = selectedPath;
        }
      }

      const sample = details[0] || {};
      const failedTargets = details.filter(this.isPublishFailed).map((v) => ({
        pt: v.pt,
        phone: String(v.phone || "").split("-")[0],
      }));

      const ok = this.$refs.localPublishRef.openRepublish({
        filePath,
        textOtherName: sample.textOtherName || "",
        form: {
          title: sample.bookName || sample.textOtherName || "",
          bt1: sample.bt || "",
          bt2: sample.bt2 || sample.bt || "",
          bq: sample.bq || "",
          creativeStatement: sample.creativeStatement,
        },
        records: details.map((v) => ({
          id: v.id,
          date: v.date,
          pt: v.pt,
          phone: String(v.phone || "").split("-")[0],
          publishAttemptCount: Number(v.publishAttemptCount) || 1,
          republishCount: Number(v.republishCount),
        })),
        failedTargets,
      });
      if (!ok) return;
      if (failedTargets.length === 0) {
        this.$message.info(
          "未检测到失败平台，已打开发布弹窗，请手动勾选需要重发的平台。"
        );
      }
    },
    getFileName(filePath) {
      if (!filePath) return "";
      const s = String(filePath).replace(/\\/g, "/");
      const arr = s.split("/");
      return arr[arr.length - 1] || "";
    },
    fillPublishStats(row) {
      const copyRow = { ...row };
      const attemptCount = Number(copyRow.publishAttemptCount) || 1;
      copyRow.publishAttemptCount = attemptCount;
      copyRow.republishCount = Number(copyRow.republishCount);
      if (
        !Number.isFinite(copyRow.republishCount) ||
        copyRow.republishCount < 0
      ) {
        copyRow.republishCount = Math.max(0, attemptCount - 1);
      }
      copyRow.publishSuccessCount = this.normalizeCount(
        copyRow.publishSuccessCount
      );
      copyRow.publishFailCount = this.normalizeCount(copyRow.publishFailCount);
      copyRow.publishStatus = copyRow.publishStatus || "publishing";
      return copyRow;
    },
    recordValue(value) {
      return String(value || "");
    },
    getRecordPhone(row) {
      return String((row && row.phone) || "").split("-")[0];
    },
    getArticleField(row, key) {
      if (!row) return "";
      if (row[key] !== undefined && row[key] !== null)
        return this.recordValue(row[key]);
      const data = row.data || {};
      return this.recordValue(data[key]);
    },
    getArticleTags(row) {
      if (!row) return "";
      const data = row.data || {};
      return this.recordValue(row.bq || row.tags || data.bq || data.tags);
    },
    buildArticleMergeKey(row) {
      return [
        this.recordValue(row && row.textOtherName),
        this.recordValue(row && row.textType),
        this.getRecordPhone(row),
        this.recordValue(row && row.partition),
        this.recordValue(row && row.selectedFile),
        this.getArticleField(row, "content"),
        this.getArticleField(row, "articleFilePath"),
        this.getArticleField(row, "coverPath"),
        this.getArticleField(row, "category"),
        this.getArticleTags(row),
        this.getArticleField(row, "summary"),
      ].join("\u0001");
    },
    isSameArticlePublishRecord(record, target) {
      return (
        this.buildArticleMergeKey(record) === this.buildArticleMergeKey(target)
      );
    },
    findLocalPublishRecord(donePayload) {
      const textType = donePayload.textType || "local";
      const textOtherName =
        donePayload.textOtherName ||
        (donePayload.data && donePayload.data.textOtherName) ||
        "";
      const selectedFile =
        donePayload.selectedFile || this.getFileName(donePayload.filePath);
      const pt = donePayload.pt;
      const phone = String(donePayload.phone || "").split("-")[0];
      const dateKeys = Object.keys(this.dataList || {});
      for (const dateKey of dateKeys) {
        const dayRows = this.dataList[dateKey] || [];
        for (const row of dayRows) {
          const details = row.showAlltype || [];
          for (const sub of details) {
            const subPhone = String(sub.phone || "").split("-")[0];
            if (textType === "article") {
              if (
                sub.textType === "article" &&
                sub.pt === pt &&
                this.isSameArticlePublishRecord(sub, donePayload)
              ) {
                return { date: dateKey, row: sub };
              }
              continue;
            }
            if (
              sub.textType === textType &&
              sub.pt === pt &&
              sub.textOtherName === textOtherName &&
              sub.selectedFile === selectedFile &&
              subPhone === phone
            ) {
              return { date: dateKey, row: sub };
            }
          }
        }
      }
      return null;
    },
    async syncPublishProgress(donePayload) {
      if (!donePayload || !["local", "article"].includes(donePayload.textType))
        return;
      if (donePayload.interrupted) return;
      if (
        !donePayload.pt ||
        String(donePayload.pt).includes("状态") ||
        String(donePayload.pt).includes("登录")
      )
        return;
      const target = this.findLocalPublishRecord(donePayload);
      if (!target || !target.row || !target.row.id) return;
      const row = this.fillPublishStats(target.row);
      if (donePayload.skipped) {
        await dataRequest({
          type: "update",
          fileName: "pushData",
          item: {
            id: row.id,
            date: target.date,
            publishStatus: "skipped",
            lastPublishMessage:
              donePayload.message || "用户关闭窗口，已跳过发布",
            lastPublishAt: Date.now(),
          },
        });
        this.loadRecords();
        return;
      }
      const success = !!donePayload.status;
      const isDraftMode =
        donePayload.publishMode === "draft" ||
        donePayload.publishToDraft === true;
      await dataRequest({
        type: "update",
        fileName: "pushData",
        item: {
          id: row.id,
          date: target.date,
          publishSuccessCount: success
            ? row.publishSuccessCount + 1
            : row.publishSuccessCount,
          publishFailCount: success
            ? row.publishFailCount
            : row.publishFailCount + 1,
          publishMode: isDraftMode ? "draft" : row.publishMode || "publish",
          publishStatus: success
            ? isDraftMode
              ? "draft"
              : "success"
            : "failed",
          lastPublishMessage:
            donePayload.message ||
            (success
              ? isDraftMode
                ? "保存草稿成功"
                : "发布成功"
              : "发布失败"),
          lastPublishAt: Date.now(),
        },
      });
      this.loadRecords();
    },
    openFeedback() {
      window.open(
        "https://wj.qq.com/s2/26701780/6de3/",
        "_blank"
      );
    },
    openQQGroup() {
      window.open(
        "https://qm.qq.com/cgi-bin/qm/qr?k=NLsaKNd7gqbOeW_JXNg7bRreFtcLKXmp&jump_from=webapi&authKey=Nd/DrSrJWaH+Nip9gEIGse4LdHWpLkp8bVfcKwinOk4hI8XfNTDvGf/smQgZvWHT",
        "_blank"
      );
    },
    async selectVideoFile() {
      const path = await ipcRenderer.invoke("dialog:openVideoFile");
      if (path) {
        this.$refs.localPublishRef.open(path);
      }
    },
    async openDirectoryPublish() {
      this.$refs.localPublishRef.openDirectory();
    },
    openArticlePublish() {
      this.$refs.articlePublishRef.open();
    },

    refreshRecords() {
      this.loadRecords(true);
    },

    loadRecords(showMessage = false) {
      const shouldNotify = showMessage === true;
      this.recordsLoading = true;
      return dataRequest({
        type: "get",
        fileName: "pushData",
      })
        .then((r) => {
          this.initDataFiltered(r.data || {});
          if (shouldNotify) {
            this.$message.success("数据已刷新");
          }
        })
        .catch((error) => {
          console.error("刷新视频管理数据失败", error);
          if (shouldNotify) {
            this.$message.error("数据刷新失败");
          }
        })
        .finally(() => {
          this.recordsLoading = false;
        });
    },

    initDataFiltered(data) {
      const tempObj = {};
      this.dataList = {};
      for (const key in data) {
        const tempData = {};
        const list = data[key] || [];
        list.forEach((row) => {
          if (!["local", "article"].includes(row.textType)) return;
          const mergeKey =
            row.textType === "article"
              ? this.buildArticleMergeKey(row)
              : row.textOtherName +
                "-" +
                row.textType +
                this.getRecordPhone(row) +
                row.selectedFile;
          if (!tempData[mergeKey]) {
            const copyRow = this.fillPublishStats(
              JSON.parse(JSON.stringify(row))
            );
            copyRow.showAlltype = [
              this.fillPublishStats(JSON.parse(JSON.stringify(row))),
            ];
            tempData[mergeKey] = copyRow;
          } else {
            tempData[mergeKey].showAlltype.push(
              this.fillPublishStats(JSON.parse(JSON.stringify(row)))
            );
          }
        });
        if (Object.keys(tempData).length) {
          tempObj[key] = tempData;
        }
      }
      for (const key in tempObj) {
        const v = Object.values(tempObj[key]).reverse();
        this.$set(this.dataList, key, v);
      }
    },

    async opPt(item) {
      try {
        const result = await openLoginWindow(item);
        if (result && result.ok === false) {
          this.$message.error(result.message || "打开登录窗口失败");
        } else if (result && result.reused) {
          this.$message.info("已切换到已打开的登录窗口");
        }
      } catch (e) {
        this.$message.error("打开登录窗口失败：" + (e && e.message ? e.message : e));
      }
    },

    getStatus(arr) {
      const isJuejinArticle = (item) =>
        item && item.textType === "article" && item.pt === "掘金";
      const targets = (arr || []).filter(
        (item) => item && (item.textType !== "article" || isJuejinArticle(item))
      );
      const arrAll = new Promise((resolve) => {
        let acLen = 0;
        let acLen2 = 0;
        const total = targets.length;
        if (total === 0) {
          resolve();
          return;
        }
        targets.forEach((item) => {
          if (!item.videoLink) {
            const taskId = Date.now() + Math.random();
            // JSON 兜底序列化，避免 Vue 响应式代理 / 不可克隆对象触发 IPC 错误
            ipcRenderer.send("puppeteerFile", JSON.parse(JSON.stringify({
              show: false,
              taskId,
              ...item,
              title: item.title || item.bt || item.textOtherName || "",
              pt: item.pt + "状态",
              statusCalss: (this.statusCalss || "").trim(),
            })));
            this.taskHandlers.set(taskId, (data) => {
              acLen++;
              const statusUrl =
                data.url ||
                (isJuejinArticle(item) && this.ptConfig[item.pt]
                  ? this.ptConfig[item.pt].listIndex
                  : "");
              if (statusUrl && data.status) {
                acLen2++;
                const payload = JSON.parse(JSON.stringify(item));
                delete payload.showAlltype;
                dataRequest({
                  type: "update",
                  fileName: "pushData",
                  item: {
                    ...payload,
                    status: true,
                    videoLink: statusUrl,
                  },
                });
              } else {
                console.log("获取视频链接失败:", item);
              }
              if (acLen === total) {
                resolve();
              }
            });
          } else {
            acLen++;
            if (acLen === total) {
              resolve();
            }
          }
        });
      });
      return new Promise((resolve) => {
        arrAll.then(() => {
          dataRequest({
            type: "get",
            fileName: "pushData",
          }).then((r) => {
            this.initDataFiltered(r.data || {});
            resolve();
          });
        });
      });
    },

    handleDelete(item, dateKey, idx) {
      const promises = item.showAlltype.map((v) =>
        dataRequest({
          type: "delete",
          fileName: "pushData",
          item: {
            id: v.id,
            date: dateKey,
          },
        })
      );
      Promise.all(promises).then(() => {
        this.dataList[dateKey].splice(idx, 1);
        if (this.dataList[dateKey].length === 0) {
          this.$delete(this.dataList, dateKey);
        }
      });
    },
  },
};
</script>

<style lang="scss" scoped>
.container-box {
  height: calc(100vh - 100px);
  overflow-y: auto;
  overflow-x: auto;
  padding: 20px 24px;
  background: #f3f6fb;
}

.manager-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 22px;
  margin-bottom: 16px;
  background: #ffffff;
  border: 1px solid #e5ebf3;
  border-radius: 14px;
  box-shadow: 0 4px 18px rgba(15, 23, 42, 0.04);
}

.manager-header-copy {
  min-width: 0;
}

.manager-eyebrow {
  font-size: 12px;
  font-weight: 600;
  color: #0f766e;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.manager-header-copy h1 {
  margin: 6px 0 0;
  font-size: 22px;
  line-height: 1.2;
  font-weight: 700;
  color: #0f172a;
}

.manager-header-copy p {
  margin: 8px 0 0;
  max-width: 820px;
  color: #64748b;
  font-size: 13px;
  line-height: 1.7;
}

.manager-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-card {
  padding: 14px 16px;
  background: #fff;
  border: 1px solid #e5ebf3;
  border-radius: 14px;
  box-shadow: 0 2px 12px rgba(15, 23, 42, 0.03);
}

.summary-card-label {
  font-size: 12px;
  color: #64748b;
}

.summary-card-value {
  margin-top: 8px;
  font-size: 24px;
  font-weight: 700;
  color: #0f172a;
}

.summary-card-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #94a3b8;
}

.summary-card.is-primary .summary-card-value {
  color: #2563eb;
}

.summary-card.is-info .summary-card-value {
  color: #0f766e;
}

.summary-card.is-success .summary-card-value {
  color: #16a34a;
}

.summary-card.is-danger .summary-card-value {
  color: #dc2626;
}

.summary-card.is-warning .summary-card-value {
  color: #d97706;
}

.toolbar {
  margin-bottom: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  background: #fff;
  border: 1px solid #e8edf5;
  border-radius: 10px;
  box-shadow: 0 2px 12px rgba(31, 45, 61, 0.04);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.info-box {
  min-height: 200px;
  overflow: hidden;
}

.record-card {
  overflow: hidden;
  border: 1px solid #e5ebf3;
  border-radius: 14px;
  box-shadow: 0 4px 18px rgba(15, 23, 42, 0.04);
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid #eef2f7;
  margin-bottom: 14px;
}

.card-head-copy {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
}

.head-meta {
  font-size: 12px;
  color: #64748b;
}

.date-label {
  color: #0f172a;
  font-weight: 700;
  font-size: 15px;
}

.hint {
  font-size: 12px;
  color: #0f766e;
  background: #ecfdf3;
  padding: 2px 8px;
  border-radius: 999px;
}

.card-head-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.record-name-cell {
  display: grid;
  gap: 6px;
}

.record-name {
  font-weight: 600;
  color: #0f172a;
}

.record-subtitle {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #64748b;
  font-size: 12px;
}

.status-row,
.progress-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.status-row {
  padding: 2px 0;
}

.status-row + .status-row,
.progress-row + .progress-row {
  border-top: 1px dashed #eef2f7;
  padding-top: 6px;
}

.pt-name {
  cursor: pointer;
  flex: 0 0 auto;
  min-width: 0;
  word-break: break-all;
  font-weight: 600;
  color: #334155;
}

.progress-row .pt-name {
  flex: 0 0 58px;
  font-size: 13px;
}

.status-row .pt-name {
  font-size: 13px;
}

.progress-detail {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: flex-start;
}

.progress-count {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 12px;
}

.progress-count.success {
  color: #15803d;
  background: #ecfdf3;
}

.progress-count.fail {
  color: #dc2626;
  background: #fef2f2;
}

.fail {
  color: #dc2626;
  cursor: pointer;
  font-weight: 600;
}

.mb16 {
  margin-bottom: 16px;
}

.mb8 {
  margin-bottom: 8px;
}

.info-box ::v-deep .responsive-table {
  width: 100% !important;
}

.info-box ::v-deep .el-card__body {
  padding: 18px 20px 20px;
}

.info-box ::v-deep .el-table__header th {
  background: #f8fafc;
  color: #344054;
  font-weight: 600;
}

.info-box ::v-deep .el-table__body tr:hover > td {
  background: #f8fbff !important;
}

.info-box ::v-deep .el-table__row td {
  padding-top: 14px;
  padding-bottom: 14px;
  vertical-align: top;
}

.info-box ::v-deep .el-button--mini {
  margin-left: 0;
  margin-right: 6px;
}

.info-box ::v-deep th,
.info-box ::v-deep td {
  min-width: 0 !important;
}

.content-detail {
  color: #303133;
}

.content-summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
}

.content-title {
  font-size: 16px;
  font-weight: 600;
  color: #1f2d3d;
}

.content-subtitle {
  margin-top: 4px;
  font-size: 13px;
  color: #667085;
}

.content-descriptions {
  margin-bottom: 16px;
}

.content-section-title {
  margin: 4px 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: #344054;
}

.content-platform-table {
  width: 100%;
}

.publish-log-dialog {
  min-height: 360px;
}

.log-summary {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 14px;
}

.log-title {
  font-weight: 600;
  color: #222;
}

.log-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: #777;
  word-break: break-all;
}

.log-actions {
  display: flex;
  gap: 8px;
}

.log-run-list {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
  max-height: 150px;
  overflow-y: auto;
}

.log-run-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid #e8edf5;
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.log-run-item:hover {
  border-color: #c0d8ff;
  background: #f5f8ff;
}

.log-run-item.active {
  border-color: #1677ff;
  background: #ecf5ff;
}

.log-run-main {
  display: flex;
  gap: 12px;
  min-width: 0;
  font-size: 13px;
  color: #444;
}

.log-tabs {
  margin-top: 8px;
}

.log-timeline {
  max-height: 420px;
  overflow-y: auto;
  border: 1px solid #e8edf5;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fafbfc;
}

.log-line {
  display: grid;
  grid-template-columns: 170px 70px 130px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 13px;
}

.log-line:last-child {
  border-bottom: none;
}

.log-time,
.log-stage,
.log-detail {
  color: #777;
}

.log-message,
.log-detail {
  word-break: break-all;
}

.log-detail {
  grid-column: 4;
  font-size: 12px;
}

</style>
