module.exports = {
  apps: [
    {
      name: 'bot-controller',
      script: 'pm2-controller.js',
      cwd: __dirname,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/controller-error.log',
      out_file: './logs/controller-out.log',
      log_file: './logs/controller-combined.log',
      time: true
    },
    {
      name: 'minecraft-afk-bot',
      script: 'index.js',
      cwd: __dirname,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      log_file: './logs/bot-combined.log',
      time: true,
      autorestart: false
    }
  ]
};