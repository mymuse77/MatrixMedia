<!--  -->
<template>
  <div class="window-title" v-if="!IsUseSysTitle && !IsWeb">
    <!-- 软件logo预留位置 -->
    <img
      src="@/assets/icon.png"
      style="width: 30px; height: 30px"
      :style="{ marginLeft: !isNotMac ? 'auto' : '' }"
    />
    <!-- 菜单栏位置 -->
    <div></div>
    <!-- 中间标题位置 -->
    <div style="-webkit-app-region: drag" class="title"></div>
    <div class="controls-container" v-if="isNotMac">
      <div class="windows-icon-bg" @click="Mini">
        <svg-icon icon-class="mini" class-name="icon-size"></svg-icon>
      </div>
      <div class="windows-icon-bg" @click="MixOrReduction">
        <svg-icon
          v-if="mix"
          icon-class="reduction"
          class-name="icon-size"
        ></svg-icon>
        <svg-icon v-else icon-class="mix" class-name="icon-size"></svg-icon>
      </div>
      <div class="windows-icon-bg close-icon" @click="Close">
        <svg-icon icon-class="close" class-name="icon-size"></svg-icon>
      </div>
    </div>
    <div
      v-if="updateStatus !== 'idle'"
      class="update-notice"
      @mousedown.stop
    >
      <div class="update-notice__content">
        <div class="update-notice__title">{{ updateNoticeTitle }}</div>
        <div class="update-notice__message">{{ updateNoticeMessage }}</div>
        <el-progress
          v-if="updateStatus === 'downloading'"
          :percentage="percentage"
          :stroke-width="8"
          :show-text="false"
        />
      </div>
      <div class="update-notice__actions">
        <template v-if="updateStatus === 'available'">
          <el-button size="mini" @click="dismissUpdateNotice">稍后</el-button>
          <el-button size="mini" type="primary" @click="startUpdateDownload">
            下载更新
          </el-button>
        </template>
        <template v-else-if="updateStatus === 'ready'">
          <el-button size="mini" @click="dismissUpdateNotice">稍后安装</el-button>
          <el-button
            size="mini"
            type="primary"
            :loading="installingUpdate"
            @click="confirmInstallUpdate"
          >
            退出并安装
          </el-button>
        </template>
        <template v-else-if="updateStatus === 'error'">
          <el-button size="mini" @click="dismissUpdateNotice">关闭</el-button>
          <el-button size="mini" type="primary" @click="startUpdateDownload">
            重试
          </el-button>
        </template>
      </div>
    </div>
  </div>
</template>

<script>
import { ipcRenderer } from "electron";
import { DEFAULT_APP_SETTINGS } from "../../../shared/appSettings.js";
export default {
  data: () => ({
    mix: false,
    IsUseSysTitle: false,
    isNotMac: process.platform !== "darwin",
    IsWeb: process.env.IS_WEB,
    updateStatus: "idle",
    updateNoticeTitle: "",
    updateNoticeMessage: "",
    remoteVersion: "",
    installingUpdate: false,
    appSettings: { ...DEFAULT_APP_SETTINGS },
    filePath: "",
    percentage: 0,
  }),

  components: {},
  created() {
    ipcRenderer.invoke("IsUseSysTitle").then((res) => {
      this.IsUseSysTitle = res;
    });
    this.loadAppSettings().then(() => {
      if (!this.appSettings.skipStartupUpdateCheck) {
        this.checkForUpdates();
      }
    });
    // 下载进度
    ipcRenderer.on("download-progress", this._onDownloadProgress);
    // 下载报错
    ipcRenderer.on("download-error", this._onDownloadError);
    // 下载暂停提示
    ipcRenderer.on("download-paused", this._onDownloadPaused);
    // 下载成功
    ipcRenderer.on("download-done", this._onDownloadDone);
  },

  mounted() {
    ipcRenderer.on("w-max", (event, state) => {
      this.mix = state;
    });
  },

  methods: {
    loadAppSettings() {
      return ipcRenderer
        .invoke("get-app-settings")
        .then((settings) => {
          if (settings) this.appSettings = settings;
          return this.appSettings;
        })
        .catch(() => this.appSettings);
    },
    checkForUpdates() {
      return ipcRenderer
        .invoke("check-for-updates")
        .then((res) => {
          if (res && res.hasUpdate) {
            this.remoteVersion = res.remoteVersion || "";
            this.updateStatus = "available";
            this.updateNoticeTitle = this.remoteVersion
              ? `发现新版本 v${this.remoteVersion}`
              : "发现新版本";
            this.updateNoticeMessage =
              "更新将在您确认后下载，不会中断当前发布任务。";
          }
          return res;
        })
        .catch(() => ({ hasUpdate: false }));
    },
    dismissUpdateNotice() {
      this.updateStatus = "idle";
    },
    startUpdateDownload() {
      this.percentage = 0;
      this.updateStatus = "downloading";
      this.updateNoticeTitle = "正在后台下载更新";
      this.updateNoticeMessage = "下载不会停止或暂停当前发布任务。";
      return ipcRenderer
        .invoke("download-update")
        .then((res) => {
          if (!res || !res.started) {
            if (res && res.reason === "in-progress") return res;
            this.showUpdateDownloadError();
          }
          return res;
        })
        .catch(() => {
          this.showUpdateDownloadError();
        });
    },
    showUpdateDownloadError() {
      this.updateStatus = "error";
      this.updateNoticeTitle = "更新下载失败";
      this.updateNoticeMessage = "当前任务不受影响，可以稍后重试。";
    },
    _onDownloadProgress(event, arg) {
      this.percentage = Math.max(0, Math.min(100, Number(arg) || 0));
      this.updateStatus = "downloading";
      this.updateNoticeTitle = `正在后台下载更新（${this.percentage}%）`;
      this.updateNoticeMessage = "下载不会停止或暂停当前发布任务。";
    },
    _onDownloadError(event, arg) {
      if (arg) this.showUpdateDownloadError();
    },
    _onDownloadPaused(event, arg) {
      if (arg) {
        this.updateStatus = "downloading";
        this.updateNoticeTitle = "更新下载暂时中断";
        this.updateNoticeMessage = "客户端仍可正常使用，正在等待下载恢复。";
      }
    },
    _onDownloadDone(event, age) {
      this.filePath = age.filePath;
      this.percentage = 100;
      this.updateStatus = "ready";
      this.updateNoticeTitle = "更新已下载";
      this.updateNoticeMessage = "请在发布任务结束后选择“退出并安装”。";
    },
    confirmInstallUpdate() {
      return this.$confirm(
        "安装更新会关闭客户端。系统会再次检查发布任务，运行中的任务不会被中断。",
        "安装更新",
        {
          confirmButtonText: "退出并安装",
          cancelButtonText: "稍后安装",
          type: "warning",
        }
      )
        .then(() => {
          this.installingUpdate = true;
          return ipcRenderer.invoke("launch-installer", this.filePath);
        })
        .then((res) => {
          if (res && res.ok) return;
          this.installingUpdate = false;
          this.updateStatus = "ready";
          if (res && res.reason === "active-tasks") {
            this.updateNoticeMessage =
              "检测到发布任务正在运行，已取消安装；任务结束后可再次安装。";
            this.$message.warning("发布任务正在运行，本次安装已取消");
            return;
          }
          this.updateNoticeMessage = "安装程序启动失败，请稍后重试。";
          this.$message.error("安装程序启动失败");
        })
        .catch((error) => {
          this.installingUpdate = false;
          if (error === "cancel" || error === "close") return;
          this.updateNoticeMessage = "安装程序启动失败，请稍后重试。";
          this.$message.error("安装程序启动失败");
        });
    },
    Mini() {
      ipcRenderer.invoke("windows-mini");
    },
    MixOrReduction() {
      ipcRenderer.invoke("window-max").then((res) => {
        this.mix = res.status;
      });
    },
    Close() {
      ipcRenderer.invoke("windows-mini");
    },
  },
  destroyed() {
    ipcRenderer.removeAllListeners("w-max");
    ipcRenderer.removeListener("download-progress", this._onDownloadProgress);
    ipcRenderer.removeListener("download-error", this._onDownloadError);
    ipcRenderer.removeListener("download-paused", this._onDownloadPaused);
    ipcRenderer.removeListener("download-done", this._onDownloadDone);
  },
};
</script>
<style rel="stylesheet/scss" lang="scss" scoped>
.window-title {
  width: 100%;
  height: 30px;
  line-height: 30px;
  display: flex;
  -webkit-app-region: drag;
  position: fixed;
  top: 0;
  background: linear-gradient(to right, #0c3c78, #fff);
  z-index: 99999;
  .title {
    text-align: center;
  }
  .logo {
    margin-left: 20px;
  }
  .controls-container {
    display: flex;
    flex-grow: 0;
    flex-shrink: 0;
    text-align: center;
    position: relative;
    z-index: 3000;
    -webkit-app-region: no-drag;
    height: 100%;
    width: 138px;
    margin-left: auto;
    .windows-icon-bg {
      display: inline-block;
      -webkit-app-region: no-drag;
      height: 100%;
      width: 33.34%;
      color: rgba(129, 129, 129, 0.6);
      .icon-size {
        width: 12px;
        height: 15px;
      }
    }
    .windows-icon-bg:hover {
      background-color: rgba(182, 182, 182, 0.2);
      color: #333;
    }
    .close-icon:hover {
      background-color: rgba(232, 17, 35, 0.9);
      color: #fff;
    }
  }
}
.update-notice {
  position: fixed;
  top: 42px;
  right: 18px;
  z-index: 100000;
  box-sizing: border-box;
  width: 390px;
  padding: 14px 16px;
  line-height: 1.5;
  color: #303133;
  background: #fff;
  border: 1px solid #ebeef5;
  border-left: 4px solid #409eff;
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  -webkit-app-region: no-drag;
}
.update-notice__title {
  margin-bottom: 4px;
  font-size: 15px;
  font-weight: 600;
}
.update-notice__message {
  margin-bottom: 10px;
  color: #606266;
  font-size: 13px;
}
.update-notice__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
</style>
