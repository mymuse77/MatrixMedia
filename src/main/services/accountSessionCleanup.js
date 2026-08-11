import { session } from 'electron';
import {
  blockAccountLoginPartition,
  unblockAccountLoginPartition,
} from './accountLoginWindow';
import { destroyAccountLoginWindowByPartition } from './accountLoginWindowManager';
import { clearAccountProxySession } from './proxyConfig';

/**
 * 清理一个账号在 Electron 中的全部持久登录状态。
 * 重复执行是安全的：不存在的窗口、Cookie 或缓存会被视为已清理。
 */
export async function purgeAccountSession(account, dependencies = {}) {
  const partition = String(account?.partition || '').trim();
  if (!partition) throw new Error('缺少账号会话 partition');

  const sessionFromPartition = dependencies.sessionFromPartition || session.fromPartition.bind(session);
  const blockPartition = dependencies.blockPartition || blockAccountLoginPartition;
  const unblockPartition = dependencies.unblockPartition || unblockAccountLoginPartition;
  const destroyLoginWindow = dependencies.destroyLoginWindow || destroyAccountLoginWindowByPartition;
  const clearProxySession = dependencies.clearProxySession || clearAccountProxySession;
  let cleanupSucceeded = false;

  blockPartition(partition, account?.id);
  try {
    destroyLoginWindow(partition);
    const targetSession = sessionFromPartition(partition);

    await targetSession.closeAllConnections();
    await clearProxySession({ electronSession: targetSession, partition });
    await targetSession.clearStorageData();
    await targetSession.clearCache();
    await targetSession.clearAuthCache();
    await targetSession.closeAllConnections();

    cleanupSucceeded = true;
    return {
      id: String(account?.id || '').trim(),
      phone: String(account?.phone || '').trim(),
      platform: String(account?.platform || '').trim(),
      partition,
      success: true,
    };
  } finally {
    if (!cleanupSucceeded) {
      unblockPartition(partition, account?.id);
    }
  }
}
