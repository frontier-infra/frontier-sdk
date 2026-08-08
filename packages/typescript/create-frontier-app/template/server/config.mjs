export function readConfig(env = process.env) {
  const allowedOrigins = (env.FRONTIER_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    port: Number.parseInt(env.PORT || '8787', 10),
    frontier: {
      deploymentId: env.FRONTIER_DEPLOYMENT_ID || 'local-governed-worker',
      operatorId: env.FRONTIER_OPERATOR_ID || 'operator-local',
      workerId: env.FRONTIER_WORKER_ID || 'worker-local',
      verifierId: env.FRONTIER_VERIFIER_ID || 'verifier-local',
      allowedOrigins,
    },
    openai: {
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL || 'gpt-4.1-mini',
      apiKeyConfigured: Boolean(env.OPENAI_API_KEY),
    },
    backingServices: {
      postgresUrl: env.POSTGRES_URL || 'postgres://frontier:frontier@localhost:5432/frontier',
      redisUrl: env.REDIS_URL || 'redis://localhost:6379',
      s3Endpoint: env.S3_ENDPOINT || 'http://localhost:9000',
      s3Bucket: env.S3_BUCKET || 'frontier-local',
    },
  };
}
