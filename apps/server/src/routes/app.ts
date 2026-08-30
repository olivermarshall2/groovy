import { access } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { getAuthenticatedUser, requireAuth } from "./auth.js";

const settingsSchema = z.object({
  libraryRoots: z.array(z.string().trim().min(1)).min(1),
  bookRoots: z.array(z.string().trim().min(1)).default([]),
  scanIntervalMinutes: z.number().int().positive().max(1440).default(15),
  queueAlbumTracksOnPlay: z.boolean().default(true),
  promptBeforeReplacingQueueOnPlay: z.boolean().default(true),
  showEntityMetadataOnHeroImage: z.boolean().default(false),
  mobileOptimizedCoversEnabled: z.boolean().default(true),
  mobileOptimizedCoverJobTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("03:00")
});

const buildApiKeyStatus = (server: FastifyInstance, request: FastifyRequest, userId: string) => {
  const protocolHeader = request.headers["x-forwarded-proto"];
  const protocol = typeof protocolHeader === "string" ? protocolHeader.split(",")[0]?.trim() || "http" : "http";
  const host = request.headers.host ?? "127.0.0.1:4318";
  const status = server.appContext.repository.getUserApiKeyStatus(userId);

  return {
    ...status,
    subsonicUsername: server.appContext.config.subsonic.username,
    apiBaseUrl: `${protocol}://${host}/rest`
  };
};

export const registerAppRoutes = async (server: FastifyInstance) => {
  server.get("/preview-login", async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const tokenValue = Array.isArray(query.token) ? query.token[0] : query.token;
    const redirectValue = Array.isArray(query.redirect) ? query.redirect[0] : query.redirect;
    const token = typeof tokenValue === "string" ? tokenValue : "";
    const redirectTarget = typeof redirectValue === "string" && redirectValue.startsWith("/") ? redirectValue : "/";

    if (!token) {
      reply.status(400);
      return {
        message: "token is required"
      };
    }

    return reply
      .type("text/html; charset=utf-8")
      .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preview Login</title>
  </head>
  <body>
    <script>
      window.localStorage.setItem("mp3-platform-session-token", ${JSON.stringify(token)});
      window.location.replace(${JSON.stringify(redirectTarget)});
    </script>
  </body>
</html>`);
  });

  server.get("/api/app/bootstrap", async (request) => {
    const user = getAuthenticatedUser(server, request);
    const settings = server.appContext.repository.getAppSettings();

    return {
      hasUsers: server.appContext.repository.hasUsers(),
      currentUser: user,
      settings,
      needsLibrarySetup: settings.libraryRoots.length === 0,
      scan: server.appContext.scanner.getStatus()
    };
  });

  server.put("/api/app/settings", async (request, reply) => {
    requireAuth(server, request);
    const payload = settingsSchema.parse(request.body);

    for (const root of [...payload.libraryRoots, ...payload.bookRoots]) {
      try {
        await access(root);
      } catch {
        reply.status(400);
        return {
          message: `Configured media root does not exist or is not accessible: ${root}`
        };
      }
    }

    server.appContext.repository.updateAppSettings(payload);
    server.appContext.scanner.resetSchedule();
    server.appContext.mobileCoverJobs.resetSchedule();

    return {
      settings: server.appContext.repository.getAppSettings()
    };
  });

  server.get("/api/app/api-key", async (request) => {
    const user = requireAuth(server, request);
    return buildApiKeyStatus(server, request, user.id);
  });

  server.post("/api/app/api-key", async (request) => {
    const user = requireAuth(server, request);
    const generated = server.appContext.repository.generateUserApiKey(user.id);

    return {
      apiKey: generated.apiKey,
      status: buildApiKeyStatus(server, request, user.id)
    };
  });

  server.delete("/api/app/api-key", async (request, reply) => {
    const user = requireAuth(server, request);
    server.appContext.repository.deleteUserApiKey(user.id);
    reply.status(204);
    return reply.send();
  });
};
