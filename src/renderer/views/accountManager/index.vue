<template>
  <div class="account-manager-page">
    <div class="header-panel">
      <div class="account-title">
        <div class="platform-name">{{ title }} 账号登录</div>
        <div class="platform-meta">
          <el-tag type="info" size="small" class="phone-tag">{{ partition.split('-')[0] }}</el-tag>
          <span>{{ partition }}</span>
        </div>
      </div>
      <div class="header-actions">
        <el-button type="primary" icon="el-icon-position" :loading="opening" @click="openLoginWindow">
          打开登录窗口
        </el-button>
        <el-button type="danger" plain icon="el-icon-delete" @click="deleteData">删除账号</el-button>
      </div>
    </div>

    <el-card class="tip-card" shadow="never">
      <div slot="header" class="tip-title">登录说明</div>
      <p>
        本平台已切换到 <b>独立 BrowserWindow</b> 进行登录，绕开 <code>&lt;webview&gt;</code>
        被小红书 / 抖音等站点指纹识别（<code>websectiga</code>、<code>sec_poison_id</code>）
        导致的"反复跳登录"问题。
      </p>
      <p>使用方法：</p>
      <ol>
        <li>点击右上「打开登录窗口」 → 弹出 {{ title }} 创作者中心首页；</li>
        <li>在弹出窗口里完成扫码 / 账号登录；</li>
        <li>登录后可以直接关闭弹窗，登录态会落到 partition <code>{{ partition }}</code>；</li>
        <li>后续视频管理那边发布会复用同一份 cookie / localStorage。</li>
      </ol>
      <p class="muted">
        登录页 URL：<code>{{ ptConfig[title] && ptConfig[title].index }}</code>
      </p>
    </el-card>
  </div>
</template>

<script>
import ptConfig from "@/utils/configUrl";
import dataRequest from "@/utils/dataRequest";
import openLoginWindow from "@/utils/openLoginWindow";
import { usePermissionStore } from "@/store/permission";
import { useAppStore } from "@/store/app";

export default {
  data() {
    return {
      ptConfig,
      partition: "persist:",
      title: "",
      urldata: {},
      opening: false,
    };
  },

  mounted() {
    this.partition += this.$route.meta.phone.split('-')[0] + this.$route.meta.title;
    this.urldata = this.$route.meta;
    this.title = this.$route.meta.title;
    console.log(this.$route.meta);
    // 进入路由直接弹登录窗，不让用户再点一下。
    // 300ms 延迟让 Vue 路由切换动画走完，避免一切完就立刻被新窗口抢焦点造成卡顿感。
    this._autoOpenTimer = setTimeout(() => {
      this.openLoginWindow();
    }, 300);
  },
  beforeRouteUpdate(to, _from, next) {
    // 路由内部参数切换（同组件不同账号）时，重新自动弹登录窗。
    if (this._autoOpenTimer) clearTimeout(this._autoOpenTimer);
    this.partition = "persist:" + to.meta.phone.split('-')[0] + to.meta.title;
    this.urldata = to.meta;
    this.title = to.meta.title;
    this._autoOpenTimer = setTimeout(() => {
      this.openLoginWindow();
    }, 300);
    next();
  },
  beforeDestroy() {
    if (this._autoOpenTimer) clearTimeout(this._autoOpenTimer);
  },
  methods: {
    async openLoginWindow() {
      if (!this.ptConfig[this.title]) {
        this.$message.error("未找到平台配置：" + this.title);
        return;
      }
      this.opening = true;
      try {
        const result = await openLoginWindow({
          partition: this.partition,
          url: this.ptConfig[this.title].index,
          pt: this.title,
        });
        if (!result || result.ok === false) {
          this.$message.error((result && result.message) || "打开登录窗口失败");
        } else if (result.reused) {
          this.$message.info("已切换到已打开的登录窗口");
        }
      } catch (e) {
        this.$message.error("打开登录窗口失败：" + (e && e.message ? e.message : e));
      } finally {
        this.opening = false;
      }
    },
    deleteData() {
      this.$confirm("此操作将永久删除该数据, 是否继续?", "提示", {
        confirmButtonText: "确定",
        cancelButtonText: "取消",
        type: "warning",
      }).then(() => {
        dataRequest({
          type: "delete",
          fileName: "account",
          item: this.urldata,
        }).then(() => {
          this.$message({
            type: "success",
            message: "删除成功!",
          });
          
          usePermissionStore().GenerateRoutes().then(() => {
            setTimeout(() => {
              const accountRoutes = this.$router.getRoutes().filter(route =>
                typeof route.path === 'string' && route.path.startsWith('/accountManager')
              );
              if (accountRoutes.length > 0) {
                const targetPath = accountRoutes[0].path;
                if (this.$route.path !== targetPath) {
                  this.$router.push(targetPath);
                }
                useAppStore().setData('isRoute', 'accountManager');
              } else {
                this.$router.push('/');
                useAppStore().setData('isRoute', '/');
              }
            }, 200);
          });
        });
      });
    },
  },
};
</script>

<style scoped>
.account-manager-page {
  min-height: calc(100vh - 100px);
  padding: 24px;
  box-sizing: border-box;
  background: #f7f8fa;
}
.account-manager-page .header-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
  padding: 18px 20px;
  background: #fff;
  border: 1px solid #e8edf5;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(31, 45, 61, 0.05);
}
.account-manager-page .account-title {
  min-width: 0;
}
.account-manager-page .platform-name {
  font-size: 18px;
  font-weight: 600;
  color: #1f2d3d;
}
.account-manager-page .platform-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: #667085;
  font-size: 13px;
}
.account-manager-page .header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.account-manager-page .tip-card {
  max-width: 760px;
  line-height: 1.8;
  border: 1px solid #e8edf5;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(31, 45, 61, 0.05);
}
.account-manager-page .tip-title {
  font-weight: 600;
  font-size: 15px;
}
.account-manager-page code {
  background: #f4f4f5;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
}
.account-manager-page .muted {
  color: #909399;
  font-size: 12px;
}
.account-manager-page ol {
  padding-left: 20px;
  margin: 8px 0;
}
</style>
