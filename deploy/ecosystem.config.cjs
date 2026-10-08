// PM2 process definition for the CogniEOS CRM backend.
// Start with:  pm2 start deploy/ecosystem.config.cjs
// The app reads its config from backend/.env (PORT, MONGO_URI, secrets, ...).
module.exports = {
  apps: [
    {
      name: 'cognicrm-api',
      cwd: '/var/www/cognicrm/backend',
      script: 'index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      out_file: '/var/log/cognicrm/api-out.log',
      error_file: '/var/log/cognicrm/api-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
