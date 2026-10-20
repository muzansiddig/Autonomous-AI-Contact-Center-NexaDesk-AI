import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { AppConfig } from "./config.js";
import { uuidSchema } from "../../../shared/contracts.js";

export interface AuthContext {
  tenantId: string;
  userId: string;
  role: "agent" | "supervisor" | "tenant_admin";
  displayName: string;
}

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
    auth: AuthContext | null;
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  req.requestId = randomUUID();
  req.auth = null;
  res.setHeader("X-Request-Id", req.requestId);
  next();
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): void {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: res.getHeader("X-Request-Id"),
      retryable,
      ...(details ? { details } : {}),
    },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.header("authorization");
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function createAuthentication(config: AppConfig, pool: Pool) {
  const jwks =
    config.authJwksUrl !== null
      ? createRemoteJWKSet(new URL(config.authJwksUrl))
      : null;

  return async function authenticate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = bearerToken(req);
    if (!token) {
      sendError(res, 401, "UNAUTHENTICATED", "A valid bearer token is required.");
      return;
    }

    try {
      let issuer: string;
      let subject: string;
      let tenantId: string;
      let userId: string;
      let role: AuthContext["role"];
      let displayName: string;

      if (config.devAuthEnabled) {
        if (!config.devAuthToken || token !== config.devAuthToken) {
          sendError(res, 401, "UNAUTHENTICATED", "The development token is invalid.");
          return;
        }
        issuer = "local-dev";
        subject = "local-agent";
        tenantId = config.devTenantId;
        userId = config.devUserId;
        role = "tenant_admin";
        displayName = "Local Development Agent";
      } else {
        if (!jwks || !config.authIssuer || !config.authAudience) {
          sendError(res, 503, "AUTH_NOT_CONFIGURED", "Identity verification is not configured.", true);
          return;
        }
        const verified = await jwtVerify(token, jwks, {
          issuer: config.authIssuer,
          audience: config.authAudience,
        });
        issuer = String(verified.payload.iss);
        subject = String(verified.payload.sub ?? "");
        if (!subject) {
          sendError(res, 401, "UNAUTHENTICATED", "The access token has no subject.");
          return;
        }
        const requestedTenant = req.header("x-tenant-id");
        if (requestedTenant && !uuidSchema.safeParse(requestedTenant).success) {
          sendError(res, 400, "INVALID_TENANT_SELECTION", "X-Tenant-Id must be a valid workspace ID.");
          return;
        }
        const membershipResult = await pool.query<{
          tenant_id: string;
          user_id: string;
          role: AuthContext["role"];
          display_name: string;
        }>(
          `SELECT tm.tenant_id, u.id AS user_id, tm.role, u.display_name
           FROM users u
           JOIN tenant_memberships tm ON tm.user_id = u.id
           JOIN tenants t ON t.id = tm.tenant_id
           WHERE u.identity_issuer = $1
             AND u.identity_subject = $2
             AND u.status = 'active'
             AND tm.status = 'active'
             AND t.status = 'active'
             AND ($3::uuid IS NULL OR tm.tenant_id = $3::uuid)
           ORDER BY tm.created_at
           LIMIT 2`,
          [issuer, subject, requestedTenant ?? null],
        );
        if (membershipResult.rows.length === 0) {
          sendError(res, 403, "TENANT_ACCESS_DENIED", "No active membership was found.");
          return;
        }
        if (!requestedTenant && membershipResult.rows.length > 1) {
          sendError(res, 400, "TENANT_SELECTION_REQUIRED", "Select one of your active workspaces using X-Tenant-Id.");
          return;
        }
        const membership = membershipResult.rows[0];
        tenantId = membership.tenant_id;
        userId = membership.user_id;
        role = membership.role;
        displayName = membership.display_name;
      }

      req.auth = { tenantId, userId, role, displayName };
      next();
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        sendError(res, 401, "TOKEN_EXPIRED", "The access token has expired.");
        return;
      }
      if (error instanceof joseErrors.JWKSTimeout || error instanceof TypeError) {
        sendError(res, 503, "IDENTITY_PROVIDER_UNAVAILABLE", "Identity verification is temporarily unavailable.", true);
        return;
      }
      if (error instanceof joseErrors.JOSEError) {
        sendError(res, 401, "UNAUTHENTICATED", "The access token is invalid.");
        return;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
      ) {
        sendError(res, 503, "AUTH_DEPENDENCY_UNAVAILABLE", "Authentication data is temporarily unavailable.", true);
        return;
      }
      next(error);
    }
  };
}

export function requireRoles(...allowed: AuthContext["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth || !allowed.includes(req.auth.role)) {
      sendError(res, 403, "FORBIDDEN", "You are not allowed to perform this action.");
      return;
    }
    next();
  };
}
