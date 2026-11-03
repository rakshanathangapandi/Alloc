import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

const CreateSkillSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).optional(),
});

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// GET /api/skills — list all skills in the org
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { organizationId } = req.auth;
    const skills = await prisma.skill.findMany({
      where: { organizationId },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    res.json(
      skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        category: skill.category ?? null,
      })),
    );
  }),
);

// POST /api/skills — create a skill (admin/manager only)
router.post(
  "/",
  asyncRoute(async (req, res) => {
    if (req.auth.role === "MEMBER") {
      throw new HttpError(403, "Only an admin or manager can create skills");
    }
    const parsed = CreateSkillSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }
    const skill = await prisma.skill.create({
      data: {
        organizationId: req.auth.organizationId,
        name: parsed.data.name,
        category: parsed.data.category ?? null,
      },
    });
    res.status(201).json({ id: skill.id, name: skill.name, category: skill.category ?? null });
  }),
);

export default router;
