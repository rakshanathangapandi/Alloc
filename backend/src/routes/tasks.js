import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { HttpError } from "../lib/http-error.js";

const router = Router();

const CreateTaskSchema = z.object({
  team_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  deadline: z.string().datetime({ offset: true }).nullable().optional(),
  estimated_hours: z.number().positive().nullable().optional(),
  required_skills: z
    .array(
      z.object({
        skill_id: z.string().uuid(),
        minimum_level: z.number().int().min(1).max(5),
        mandatory: z.boolean().default(true),
      }),
    )
    .default([]),
});

const TaskStatusSchema = z.enum([
  "BACKLOG",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
]);

function toTaskResponse(task) {
  return {
    id: task.id,
    team_id: task.teamId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    deadline: task.deadline?.toISOString() ?? null,
    estimated_hours:
      task.estimatedHours === null ? null : Number(task.estimatedHours),
    required_skills: task.requiredSkills?.map((requirement) => ({
      skill_id: requirement.skillId,
      minimum_level: requirement.minimumLevel,
      mandatory: requirement.mandatory,
    })),
  };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

router.post(
  "/",
  asyncRoute(async (req, res) => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }

    const { organizationId, userId, role } = req.auth;
    const {
      team_id: teamId,
      required_skills: requiredSkills,
      deadline,
      estimated_hours: estimatedHours,
      ...taskFields
    } = parsed.data;

    if (new Set(requiredSkills.map((skill) => skill.skill_id)).size !== requiredSkills.length) {
      throw new HttpError(422, "A required skill may only be listed once");
    }

    const team = await prisma.team.findUnique({
      where: { organizationId_id: { organizationId, id: teamId } },
      select: { id: true, managerUserId: true },
    });
    if (!team) {
      throw new HttpError(404, "Team not found");
    }
    if (role === "MEMBER") {
      throw new HttpError(403, "Only an organization admin or manager can create tasks");
    }

    if (requiredSkills.length > 0) {
      const skillCount = await prisma.skill.count({
        where: {
          organizationId,
          id: { in: requiredSkills.map((skill) => skill.skill_id) },
        },
      });
      if (skillCount !== requiredSkills.length) {
        throw new HttpError(422, "Every required skill must belong to this organization");
      }
    }

    const task = await prisma.$transaction(async (transaction) => {
      const created = await transaction.task.create({
        data: {
          ...taskFields,
          organizationId,
          teamId,
          createdByUserId: userId,
          deadline: deadline ? new Date(deadline) : null,
          estimatedHours: estimatedHours ?? null,
        },
      });

      if (requiredSkills.length > 0) {
        await transaction.taskRequiredSkill.createMany({
          data: requiredSkills.map((skill) => ({
            organizationId,
            taskId: created.id,
            skillId: skill.skill_id,
            minimumLevel: skill.minimum_level,
            mandatory: skill.mandatory,
          })),
        });
      }

      return transaction.task.findUniqueOrThrow({
        where: {
          organizationId_id: { organizationId, id: created.id },
        },
        include: { requiredSkills: true },
      });
    });

    res.status(201).json(toTaskResponse(task));
  }),
);

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { organizationId, userId, role } = req.auth;
    const teamId = req.query.team_id;
    const statusResult = req.query.status
      ? TaskStatusSchema.safeParse(req.query.status)
      : undefined;

    if (teamId !== undefined && !z.string().uuid().safeParse(teamId).success) {
      throw new HttpError(422, "team_id must be a UUID");
    }
    if (statusResult && !statusResult.success) {
      throw new HttpError(422, "Invalid task status");
    }

    const where = {
      organizationId,
      ...(teamId ? { teamId } : {}),
      ...(statusResult?.success ? { status: statusResult.data } : {}),
      ...(role !== "MEMBER"
        ? {}
        : {
            team: {
              OR: [{ managerUserId: userId }, { members: { some: { userId } } }],
            },
          }),
    };

    const tasks = await prisma.task.findMany({
      where,
      include: { requiredSkills: true },
      orderBy: [{ deadline: "asc" }, { createdAt: "desc" }],
    });
    res.json(tasks.map(toTaskResponse));
  }),
);

export default router;