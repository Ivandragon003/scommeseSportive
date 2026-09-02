const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function configureDevelopmentProxy(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'https://scommese-sportive-backend.hostless.app',
      changeOrigin: true,
      secure: true,
    }),
  );
};
