import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { prisma } from "../lib/prisma.js";

const router = Router({ mergeParams: true });

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

const AddMemberSchema = z.object({
  user_id: z.string().uuid(),
});

// GET /api/teams/:team_id/members
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { organizationId, userId, role } = req.auth;
    const { team_id: teamId } = req.params;

    if (!z.string().uuid().safeParse(teamId).success) {
      throw new HttpError(422, "team_id must be a UUID");
    }

    const team = await prisma.team.findUnique({
      where: { organizationId_id: { organizationId, id: teamId } },
    });
    if (!team) throw new HttpError(404, "Team not found");

    // Members can only view teams they belong to
    if (role === "MEMBER") {
      const self = await prisma.teamMember.findUnique({
        where: { organizationId_teamId_userId: { organizationId, teamId, userId } },
      });
      if (!self) throw new HttpError(403, "You are not a member of this team");
    }

    const members = await prisma.teamMember.findMany({
      where: { organizationId, teamId },
      include: {
        member: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
      orderBy: { joinedAt: "asc" },
    });

    res.json(
      members.map((m) => ({
        user_id: m.userId,
        name: m.member.user.name,
        email: m.member.user.email,
        role: m.member.role,
        joined_at: m.joinedAt.toISOString(),
      })),
    );
  }),
);

// POST /api/teams/:team_id/members — add a member (admin/manager only)
router.post(
  "/",
  asyncRoute(async (req, res) => {
    if (req.auth.role === "MEMBER") {
      throw new HttpError(403, "Only an admin or manager can add team members");
    }

    const { organizationId } = req.auth;
    const { team_id: teamId } = req.params;

    if (!z.string().uuid().safeParse(teamId).success) {
      throw new HttpError(422, "team_id must be a UUID");
    }

    const parsed = AddMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }

    const team = await prisma.team.findUnique({
      where: { organizationId_id: { organizationId, id: teamId } },
    });
    if (!team) throw new HttpError(404, "Team not found");

    const orgMember = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: parsed.data.user_id },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (!orgMember) {
      throw new HttpError(422, "User is not a member of this organization");
    }

    const existing = await prisma.teamMember.findUnique({
      where: {
        organizationId_teamId_userId: {
          organizationId,
          teamId,
          userId: parsed.data.user_id,
        },
      },
    });
    if (existing) throw new HttpError(409, "User is already a member of this team");

    const teamMember = await prisma.teamMember.create({
      data: { organizationId, teamId, userId: parsed.data.user_id },
    });

    res.status(201).json({
      user_id: orgMember.userId,
      name: orgMember.user.name,
      email: orgMember.user.email,
      role: orgMember.role,
      joined_at: teamMember.joinedAt.toISOString(),
    });
  }),
);

// DELETE /api/teams/:team_id/members/:user_id — remove a member
router.delete(
  "/:user_id",
  asyncRoute(async (req, res) => {
    if (req.auth.role === "MEMBER") {
      throw new HttpError(403, "Only an admin or manager can remove team members");
    }

    const { organizationId } = req.auth;
    const { team_id: teamId, user_id: userId } = req.params;

    if (
      !z.string().uuid().safeParse(teamId).success ||
      !z.string().uuid().safeParse(userId).success
    ) {
      throw new HttpError(422, "IDs must be UUIDs");
    }

    const existing = await prisma.teamMember.findUnique({
      where: { organizationId_teamId_userId: { organizationId, teamId, userId } },
    });
    if (!existing) throw new HttpError(404, "Team member not found");

    await prisma.teamMember.delete({
      where: { organizationId_teamId_userId: { organizationId, teamId, userId } },
    });

    res.status(204).send();
  }),
);

export default router;
