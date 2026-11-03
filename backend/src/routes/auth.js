import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { prisma } from "../lib/prisma.js";

const router = Router();
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts; try again later" },
});

const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(12).max(128),
  organization_name: z.string().trim().min(1).max(200),
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(128),
  organization_id: z.string().uuid().optional(),
});

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function signAccessToken(userId, organizationId) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters");
  }

  return jwt.sign(
    { organization_id: organizationId },
    secret,
    {
      algorithm: "HS256",
      audience: "smartassign",
      expiresIn: "1h",
      issuer: "smartassign-api",
      subject: userId,
    },
  );
}

function authResponse(user, organization) {
  return {
    access_token: signAccessToken(user.id, organization.id),
    token_type: "Bearer",
    expires_in: 3600,
    user: { id: user.id, name: user.name, email: user.email },
    organization: { id: organization.id, name: organization.name },
  };
}

router.post(
  "/register",
  authRateLimit,
  asyncRoute(async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }

    const { name, email, password, organization_name: organizationName } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: { name, email, passwordHash },
        select: { id: true, name: true, email: true },
      });
      const organization = await transaction.organization.create({
        data: { name: organizationName },
      });
      await transaction.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: "ADMIN",
        },
      });
      return { user, organization };
    });

    res.status(201).json(authResponse(result.user, result.organization));
  }),
);

router.post(
  "/login",
  authRateLimit,
  asyncRoute(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }

    const { email, password, organization_id: organizationId } = parsed.data;
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        memberships: {
          select: {
            organizationId: true,
            organization: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new HttpError(401, "Invalid email or password");
    }

    const membership = organizationId
      ? user.memberships.find((item) => item.organizationId === organizationId)
      : user.memberships.length === 1
        ? user.memberships[0]
        : undefined;

    if (user.memberships.length === 0) {
      throw new HttpError(403, "An organization membership is required");
    }
    if (!membership && !organizationId && user.memberships.length > 1) {
      throw new HttpError(409, "Choose an organization to continue", {
        organizations: user.memberships.map((item) => item.organization),
      });
    }
    if (!membership) {
      throw new HttpError(403, "Organization membership required");
    }

    res.json(authResponse(user, membership.organization));
  }),
);

export default router;