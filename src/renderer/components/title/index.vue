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
  </div>
</template>

<script>
import { ipcRenderer } from "electron";
export default {
  data: () => ({
    mix: false,
    IsUseSysTitle: false,
    isNotMac: process.platform !== "darwin",
    IsWeb: process.env.IS_WEB,
  }),

  components: {},
  created() {
    ipcRenderer.invoke("IsUseSysTitle").then((res) => {
      this.IsUseSysTitle = res;
    });
    ipcRenderer.invoke("check-for-updates").catch(() => {});
  },

  mounted() {
    ipcRenderer.on("w-max", (event, state) => {
      this.mix = state;
    });
  },

  methods: {
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
</style>
