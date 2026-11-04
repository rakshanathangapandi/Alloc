import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { prisma } from "../lib/prisma.js";

const router = Router();
const CreateTeamSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { organizationId, userId, role } = req.auth;
    const teams = await prisma.team.findMany({
      where: {
        organizationId,
        ...(role === "MEMBER"
          ? { members: { some: { userId } } }
          : {}),
      },
      include: {
        _count: { select: { members: true, tasks: true } },
        manager: { include: { user: { select: { id: true, name: true } } } },
        members: {
          include: {
            member: {
              include: {
                user: { select: { id: true, name: true, email: true } },
                skills: {
                  include: { skill: { select: { id: true, name: true } } },
                  orderBy: [{ proficiency: "desc" }, { skill: { name: "asc" } }],
                  take: 4,
                },
              },
            },
          },
          orderBy: { joinedAt: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    res.json(
      teams.map((team) => ({
        id: team.id,
        name: team.name,
        member_count: team._count.members,
        task_count: team._count.tasks,
        manager: team.manager ? { id: team.manager.userId, name: team.manager.user.name } : null,
        members: team.members.map((membership) => ({
          id: membership.member.userId,
          name: membership.member.user.name,
          email: membership.member.user.email,
          role: membership.member.role,
          skills: membership.member.skills.map((userSkill) => ({
            name: userSkill.skill.name,
            proficiency: userSkill.proficiency,
          })),
        })),
      })),
    );
  }),
);

router.post(
  "/",
  asyncRoute(async (req, res) => {
    if (req.auth.role === "MEMBER") {
      throw new HttpError(403, "Only an organization admin or manager can create teams");
    }

    const parsed = CreateTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }

    const team = await prisma.team.create({
      data: {
        organizationId: req.auth.organizationId,
        name: parsed.data.name,
        managerUserId: req.auth.role === "MANAGER" ? req.auth.userId : null,
      },
    });

    res.status(201).json({ id: team.id, name: team.name, member_count: 0, task_count: 0 });
  }),
);

export default router;