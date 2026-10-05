import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'https://crm.test',
      JWT_SECRET: 'test-jwt-secret',
      ENCRYPTION_KEY: 'test-encryption-key',
      URL_SIGNING_SECRET: 'test-signing-secret',
      ANTHROPIC_API_KEY: '',
      DEEPGRAM_API_KEY: '',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
    },
  },
});
