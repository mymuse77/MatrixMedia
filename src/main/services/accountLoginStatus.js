import { session } from 'electron';

const xhsLoginCookieNames = [
  'access-token-creator.xiaohongshu.com',
  'customer-sso-sid',
  'galaxy_creator_session_id',
  'x-user-id-creator.xiaohongshu.com',
];

export function getAccountPartition(phone, platform) {
  return `persist:${String(phone || '').split('-')[0]}${platform}`;
}

function cookieExpiresAtMs(cookie) {
  if (cookie.expirationDate == null || Number.isNaN(cookie.expirationDate)) {
    return null;
  }
  return Math.floor(cookie.expirationDate * 1000);
}

function isCookieValid(cookie, nowMs) {
  if (!cookie || !cookie.value) return false;
  const expiresAtMs = cookieExpiresAtMs(cookie);
  return expiresAtMs == null || expiresAtMs > nowMs;
}

function findValidCookie(cookies, name, nowMs, predicate = () => true) {
  return cookies.find(cookie =>
    cookie.name === name &&
    isCookieValid(cookie, nowMs) &&
    predicate(cookie)
  );
}

function resolveLoginCookie(cookies, platform, nowMs) {
  if (platform === '抖音') {
    return findValidCookie(cookies, 'passport_assist_user', nowMs);
  }

  if (platform === '百家号') {
    return findValidCookie(cookies, 'BDUSS', nowMs);
  }

  if (platform === '头条') {
    return findValidCookie(cookies, 'odin_tt', nowMs, cookie => cookie.value.length > 65);
  }

  if (platform === '视频号') {
    return findValidCookie(cookies, 'sessionid', nowMs);
  }

  if (platform === '哔哩哔哩') {
    return findValidCookie(cookies, 'SESSDATA', nowMs);
  }

  if (platform === '快手') {
    return findValidCookie(cookies, 'userId', nowMs);
  }

  if (platform === '掘金') {
    return findValidCookie(cookies, 'passport_csrf_token', nowMs, cookie => cookie.value.length > 10);
  }

  if (platform === '小红书') {
    const cookieMap = new Map();
    xhsLoginCookieNames.forEach(name => {
      const cookie = findValidCookie(cookies, name, nowMs);
      if (cookie) cookieMap.set(name, cookie);
    });
    if (xhsLoginCookieNames.every(name => cookieMap.has(name))) {
      return Array.from(cookieMap.values()).sort((a, b) => {
        const aExp = cookieExpiresAtMs(a) || Number.MAX_SAFE_INTEGER;
        const bExp = cookieExpiresAtMs(b) || Number.MAX_SAFE_INTEGER;
        return aExp - bExp;
      })[0];
    }
  }

  return null;
}

export async function getAccountLoginStatus({ phone, platform, url, partition }) {
  const targetPartition = partition || getAccountPartition(phone, platform);
  const cookies = await session.fromPartition(targetPartition).cookies.get(url ? { url } : {});
  const nowMs = Date.now();
  const loginCookie = resolveLoginCookie(cookies, platform, nowMs);
  const expiresAtMs = loginCookie ? cookieExpiresAtMs(loginCookie) : null;
  const supported = ['抖音', '百家号', '头条', '视频号', '哔哩哔哩', '快手', '掘金', '小红书'].includes(platform);

  if (loginCookie) {
    return {
      isLoggedIn: true,
      loginStatus: 'valid',
      loginStatusText: '登录正常',
      loginExpiresAtMs: expiresAtMs,
      checkedAt: nowMs,
      partition: targetPartition,
    };
  }

  return {
    isLoggedIn: false,
    loginStatus: supported ? 'expired' : 'unknown',
    loginStatusText: supported ? '登录失效' : '未检测',
    loginExpiresAtMs: null,
    checkedAt: nowMs,
    partition: targetPartition,
  };
}
