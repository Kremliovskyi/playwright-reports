module.exports = {
  apps: [
    {
      name: "playwright-reports",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "development",
        PORT: 9333,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 9333,
      },
    },
  ],
};
