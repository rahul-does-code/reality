// pm2 config: pm2 start deploy/ecosystem.config.cjs  (run from the repo root)
module.exports = {
  apps: [
    {
      name: "reality",
      cwd: __dirname + "/..",
      script: "deploy/server.ts",
      interpreter: "node",
      node_args: "--import tsx",
      instances: 1, // rate limits and the daily edit cap live in memory: keep one process
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        HOST: "127.0.0.1",
      },
    },
  ],
};
