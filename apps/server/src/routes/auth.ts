import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const registerSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().trim().email(),
  password: z.string().min(8)
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1)
});

export const getTokenFromRequest = (request: FastifyRequest) => {
  const header = request.headers.authorization;

  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }

  const query = request.query as Record<string, string | string[] | undefined>;
  const token = query.token;

  if (Array.isArray(token)) {
    return token[0] ?? null;
  }

  return token ?? null;
};

export const getAuthenticatedUser = (server: FastifyInstance, request: FastifyRequest) => {
  const token = getTokenFromRequest(request);

  if (!token) {
    return null;
  }

  return server.appContext.repository.getUserBySessionToken(token);
};

export const requireAuth = (server: FastifyInstance, request: FastifyRequest) => {
  const user = getAuthenticatedUser(server, request);

  if (!user) {
    const error = new Error("Unauthorized");
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }

  return user;
};

export const registerAuthRoutes = async (server: FastifyInstance) => {
  server.post("/api/auth/register-first", async (request, reply) => {
    const payload = registerSchema.parse(request.body);

    if (server.appContext.repository.hasUsers()) {
      reply.status(409);
      return {
        message: "Initial user already exists"
      };
    }

    const session = server.appContext.repository.createInitialUser(payload);
    return session;
  });

  server.post("/api/auth/login", async (request, reply) => {
    const payload = loginSchema.parse(request.body);
    const session = server.appContext.repository.loginUser(payload.email, payload.password);

    if (!session) {
      reply.status(401);
      return {
        message: "Invalid email or password"
      };
    }

    return session;
  });

  server.get("/api/auth/me", async (request, reply) => {
    const user = getAuthenticatedUser(server, request);

    if (!user) {
      reply.status(401);
      return {
        message: "Unauthorized"
      };
    }

    return {
      user
    };
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const token = getTokenFromRequest(request);

    if (token) {
      server.appContext.repository.deleteSessionToken(token);
    }

    reply.status(204);
    return reply.send();
  });
};
