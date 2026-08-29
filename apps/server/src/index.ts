import { buildServer } from "./server.js";

const start = async () => {
  const server = await buildServer();
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? 4318);

  try {
    await server.listen({ host, port });
    server.log.info(`server listening on http://${host}:${port}`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
};

void start();
