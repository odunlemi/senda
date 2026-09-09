import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway((context) => {
  const database = postgres("Postgres", { region: "ams" });
  const databaseVolume = volume("postgres-volume", {
    region: "ams",
    sizeMB: 500,
    allowOnlineResize: true,
  });
  const api = service("senda-api", {
    build: {
      builder: "DOCKERFILE",
      buildEnvironment: "V3",
      dockerfilePath: "/Dockerfile",
    },
    preDeploy: "node dist/src/lib/migrate.js up",
    start: "node dist/src/server.js",
    healthcheck: "/api/health",
    healthcheckTimeout: 100,
    replicas: { ams: 1 },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
      sleepApplication: false,
      runtime: "V2",
    },
    env: {
      DATABASE_URL: database.env.DATABASE_URL,
      BETTER_AUTH_SECRET: preserve(),
      BETTER_AUTH_URL: preserve(),
      NODE_ENV: preserve(),
      OPERATIONAL_ALERTS_MODE: preserve(),
      OPERATIONAL_ALERT_WEBHOOK_URL: preserve(),
      OPERATIONAL_ALERT_WEBHOOK_TOKEN: preserve(),
    },
  });

  const stagingOnlyResources = context.isEnvironment("staging")
    ? [
        service("senda-alert-receiver", {
          build: {
            builder: "RAILPACK",
            buildEnvironment: "V3",
          },
          start: "node server.mjs",
          healthcheck: "/health",
          healthcheckTimeout: 30,
          replicas: { ams: 1 },
          deploy: {
            restartPolicyType: "ON_FAILURE",
            restartPolicyMaxRetries: 3,
            sleepApplication: false,
            runtime: "V2",
          },
          env: {
            RECEIVER_TOKEN: preserve(),
          },
        }),
      ]
    : [];

  return project("earnest-strength", {
    environments: ["staging", "production"],
    resources: [database, databaseVolume, api, ...stagingOnlyResources],
  });
});
