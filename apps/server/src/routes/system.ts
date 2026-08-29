import type { FastifyInstance } from "fastify";

export const registerSystemRoutes = async (server: FastifyInstance) => {
  server.post("/admin/shutdown", {
    schema: {
      summary: "Shut the local server down",
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" }
          },
          required: ["status"]
        },
        403: {
          type: "object",
          properties: {
            message: { type: "string" }
          },
          required: ["message"]
        }
      }
    }
  }, async (request, reply) => {
    const host = request.headers.host ?? "";
    const remoteAddress = request.ip ?? "";
    const isLocalRequest =
      host.includes("127.0.0.1") ||
      host.includes("localhost") ||
      remoteAddress === "127.0.0.1" ||
      remoteAddress === "::1" ||
      remoteAddress.startsWith("::ffff:127.0.0.1");

    if (!isLocalRequest) {
      return reply.status(403).send({
        message: "Forbidden"
      });
    }

    reply.send({
      status: "shutting down"
    });

    setImmediate(async () => {
      try {
        await server.close();
      } catch (error) {
        server.log.error(error, "Failed to shut server down cleanly");
      } finally {
        process.exit(0);
      }
    });
  });

  server.get("/health", {
    schema: {
      summary: "Health check",
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            version: { type: "string" }
          },
          required: ["status", "version"]
        }
      }
    }
  }, async () => {
    return {
      status: "ok",
      version: "0.1.0"
    };
  });

  server.get("/config", {
    schema: {
      summary: "Read current server configuration"
    }
  }, async () => {
    return {
      databasePath: server.appContext.config.databasePath,
      subsonic: {
        username: server.appContext.config.subsonic.username
      }
    };
  });
};
