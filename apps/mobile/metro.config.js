const { getDefaultConfig } = require('expo/metro-config');
const http = require('http');
const https = require('https');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Proxy /api/* requests to the Next.js server so session cookies work same-origin
const API_TARGET = process.env.API_PROXY_TARGET || 'http://localhost:3000';

config.server = {
  enhanceMiddleware: (metroMiddleware) => {
    return (req, res, next) => {
      if (!req.url?.startsWith('/api/')) {
        return metroMiddleware(req, res, next);
      }
      const target = new URL(API_TARGET);
      const isHttps = target.protocol === 'https:';
      const transport = isHttps ? https : http;
      const options = {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      };
      const proxyReq = transport.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });
      proxyReq.on('error', (err) => {
        console.error('[api-proxy]', err.message);
        if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
      });
      req.pipe(proxyReq, { end: true });
    };
  },
};

module.exports = config;
