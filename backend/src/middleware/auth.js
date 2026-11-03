import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http-error.js";

const ClaimsSchema = z.object({
  sub: z.string().uuid(),
  organization_id: z.string().uuid(),
});

export async function requireAuth(req, _res, next) {
  try {
    const authorization = req.get("authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      throw new HttpError(401, "Authentication required");
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("JWT_SECRET is not configured");
    }

    let claims;
    try {
      claims = ClaimsSchema.parse(
        jwt.verify(token, secret, {
          algorithms: ["HS256"],
          audience: "smartassign",
          issuer: "smartassign-api",
        }),
      );
    } catch {
      throw new HttpError(401, "Invalid or expired access token");
    }

    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: claims.organization_id,
          userId: claims.sub,
        },
      },
      select: { organizationId: true, userId: true, role: true },
    });

    if (!membership) {
      throw new HttpError(403, "Organization membership required");
    }

    req.auth = {
      organizationId: membership.organizationId,
      userId: membership.userId,
      role: membership.role,
    };
    next();
  } catch (error) {
    next(error);
  }
}