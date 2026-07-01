var express = require('express');
var indexRouter = require('./routes/index');
const path = require('path');
const { DEFAULT_APP_SETTINGS } = require('../../shared/appSettings');
const { getAppSettings } = require('../services/appSettings');
var app = express();

function getUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return "";
  }
}

function getAllowedOrigins() {
  const origins = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  const defaultOrigin = getUrlOrigin(DEFAULT_APP_SETTINGS.webSocketServerUrl);
  if (defaultOrigin) {
    origins.add(defaultOrigin);
  }

  try {
    const settingsOrigin = getUrlOrigin(getAppSettings().webSocketServerUrl);
    if (settingsOrigin) {
      origins.add(settingsOrigin);
    }
  } catch (error) {
    console.warn('[HTTP CORS] 读取 appSettings 失败，使用默认跨域白名单', error);
  }

  return origins;
}

// 设置跨域访问，生产站 HTTPS 访问本机 loopback 时需要通过 PNA 预检。
app.all('*',function(req,res,next) {
  const requestOrigin = req.headers.origin;
  const requestHeaders = req.headers['access-control-request-headers'];
  if (requestOrigin && getAllowedOrigins().has(requestOrigin)) {
    res.header("Access-Control-Allow-Origin", requestOrigin);
    res.header("Vary","Origin");
    res.header("Access-Control-Allow-Credentials","true");
  } else if (!requestOrigin) {
    res.header("Access-Control-Allow-Origin","*");
  }
  res.header('Access-Control-Allow-Methods','PUT,GET,POST,DELETE,OPTIONS');
  res.header("Access-Control-Allow-Headers", requestHeaders || "Content-Type, X-Requested-With, Authorization");
  res.header("Access-Control-Allow-Private-Network","true");
  res.header("Access-Control-Max-Age","600");
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/', indexRouter);
app.use(express.static(path.resolve(__dirname,'./public') , {dotfiles: 'allow'})); 
app.use(function(req, res, next) {
  res.json({ error: 404 })
});
app.use(function(err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.json({ error: err })
});

export default app
