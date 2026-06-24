<template>
  <div class="navbar-header-fixed">
    <div class="top-right">
      <el-menu
        class="flex1"
        :default-active="activeIndex"
        mode="horizontal"
        @select="selectFn"
      >
        <el-menu-item index="/">项目详情</el-menu-item>
        <el-menu-item index="/video-manager">视频管理</el-menu-item>
        <el-menu-item :index="mediaMenuItemIndex">媒体平台管理</el-menu-item>
      </el-menu>
      <div class="account-actions">
        <el-button
          type="info"
          size="small"
          plain
          @click="showWebManagedMessage"
        >
          账号由 Web 端管理
        </el-button>
      </div>
    </div>
  </div>
</template>

<script>
import { useAppStore } from '@/store/app'

const MEDIA_MENU_NO_ACCOUNT = '__media_no_account__'

export default {
  name: 'Navbar',
  data() {
    return {
      activeIndex: '/',
      getAccoutIndex: '',
    }
  },
  computed: {
    isAccountManager() {
      return this.$route.path.indexOf('/accountManager') !== -1
    },
    mediaMenuItemIndex() {
      return this.getAccoutIndex || MEDIA_MENU_NO_ACCOUNT
    }
  },
  created() {
    this.refreshAccountMenuIndex()
    this.activeIndex = this.$route.path
    this.applyIsRouteFromPath(this.$route.path)
  },
  watch: {
    '$route.path'(path) {
      this.applyIsRouteFromPath(path)
      this.syncActiveIndexToCurrentRoute()
    }
  },
  methods: {
    refreshAccountMenuIndex() {
      const hit = this.$router
        .getRoutes()
        .find(
          r =>
            typeof r.path === 'string' && r.path.startsWith('/accountManager')
        )
      if (hit) {
        this.getAccoutIndex = hit.path
      } else {
        this.getAccoutIndex = ''
      }
    },
    applyIsRouteFromPath(pathStr) {
      const parts = (pathStr || '').split('/').filter(Boolean)
      if (parts.length === 0) {
        useAppStore().setData('isRoute', '/')
        return
      }
      if (parts[0] === 'accountManager') {
        useAppStore().setData('isRoute', 'accountManager')
        return
      }
      useAppStore().setData('isRoute', '/')
    },
    syncActiveIndexToCurrentRoute() {
      const p = this.$route.path
      if (p === '/') {
        this.activeIndex = '/'
      } else if (p.startsWith('/accountManager') && this.getAccoutIndex) {
        this.activeIndex = this.getAccoutIndex
      } else {
        this.activeIndex = p
      }
    },
    selectFn(index) {
      if (index === MEDIA_MENU_NO_ACCOUNT) {
        this.showWebManagedMessage()
        this.syncActiveIndexToCurrentRoute()
        return
      }
      this.activeIndex = index
      if (index !== this.$route.path) {
        this.$router.push(index).catch(() => {})
      }
      this.applyIsRouteFromPath(index)
    },
    showWebManagedMessage() {
      this.$message.warning('媒体账号请在 Web 端新增并管理，客户端仅负责登录与发布')
    }
  }
}
</script>

<style rel="stylesheet/scss" lang="scss" scoped>
.navbar-header-fixed {
  transition: width 0.28s;
  width: 100%;
  display: flex;
  align-items: center;
  z-index: 1002;
  height: 62px;

  .hamburger-container {
    line-height: 58px;
    height: 50px;
    float: left;
    padding: 0 10px;
  }

  .logo {
    width: 199px;
    height: 62px;
  }

  .top-right {
    display: flex;
    width: 100%;
    height: 100%;
    background-color: #ffffff;
    justify-content: space-between;
    padding-right: 19px;

    .hb-bd {
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .avatar {
      width: 30px;
      height: 30px;
      margin-right: 10px;

      ::v-deep img {
        width: 100%;
        height: 100%;
        border-radius: 50%;
      }
    }

    .top-select {
      display: flex;
      align-items: center;

      .go-index {
        color: #333333;
        font-weight: 400;
        margin-right: 20px;
        padding-right: 20px;
        border-right: 1px solid #cccccc;
      }

      .select-right ::v-deep .el-dropdown > span {
        font-size: 6px;
      }

      .select-right {
        .el-dropdown-link {
          color: #333333;
          font-weight: 400;
        }

        ::v-deep .el-dropdown-selfdefine {
          display: flex;
          align-items: center;
        }
      }
    }

    .account-actions {
      display: flex;
      align-items: center;
    }
  }
}

.dragTitle {
  -webkit-app-region: drag;
}
</style>
