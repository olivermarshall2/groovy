import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { registerAppRoutes } from "./routes/app.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerOpenSubsonicRoutes } from "./routes/opensubsonic.js";
import { registerSystemRoutes } from "./routes/system.js";
import { createAppContext } from "./services/context.js";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const webDistDirectory = path.resolve(currentDirectory, "../../web/dist");

export const buildServer = async () => {
  const server = Fastify({
    logger: true
  });

  await server.register(cors, {
    origin: true
  });

  await server.register(swagger, {
    openapi: {
      info: {
        title: "MP3 Platform API",
        version: "0.1.0",
        description: "Local media server API for browsing and streaming indexed audio files."
      }
    }
  });

  await server.register(swaggerUi, {
    routePrefix: "/docs"
  });

  const context = createAppContext();
  server.decorate("appContext", context);

  server.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 400) {
      return;
    }

    request.log.warn({
      statusCode: reply.statusCode,
      method: request.method,
      url: request.url,
      params: request.params,
      query: request.query
    }, "Request completed with error status");
  });

  server.addHook("onError", async (request, reply, error) => {
    request.log.error({
      statusCode: reply.statusCode,
      method: request.method,
      url: request.url,
      params: request.params,
      query: request.query,
      message: error.message,
      stack: error.stack
    }, "Request failed");
  });

  await registerSystemRoutes(server);
  await registerAuthRoutes(server);
  await registerAppRoutes(server);
  await registerLibraryRoutes(server);
  await registerOpenSubsonicRoutes(server);

  await server.register(fastifyStatic, {
    root: webDistDirectory,
    prefix: "/"
  });

  server.setNotFoundHandler((request, reply) => {
    if (
      request.raw.method === "GET" &&
      !request.url.startsWith("/api/") &&
      !request.url.startsWith("/rest/") &&
      !request.url.startsWith("/docs")
    ) {
      return reply.sendFile("index.html");
    }

    return reply.status(404).send({
      message: "Not found"
    });
  });

  server.addHook("onReady", async () => {
    await context.scanner.start();
    await context.mobileCoverJobs.start();
  });

  server.addHook("onClose", async () => {
    await context.scanner.stop();
    await context.mobileCoverJobs.stop();
    context.repository.close();
  });

  return server;
};

declare module "fastify" {
  interface FastifyInstance {
    appContext: ReturnType<typeof createAppContext>;
  }
}
