module.exports = {
  apps: [
    {
      name: 'polymarket-weather-bet',
      script: 'src/index.js',
      interpreter: 'node',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: { NODE_ENV: 'production' },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
