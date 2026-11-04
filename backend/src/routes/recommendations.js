import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../lib/http-error.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Fetch the agent service base URL from env, default to localhost
function agentServiceUrl() {
  return (process.env.AGENT_SERVICE_URL ?? "http://localhost:8000").replace(/\/$/, "");
}

// Map DB AgentRunStatus to the OpenAPI status enum (lowercase)
function mapRunStatus(status) {
  return status.toLowerCase();
}

function requireTaskManagerAccess(auth, task) {
  if (auth.role === "MEMBER") {
    throw new HttpError(403, "Only an admin or manager can manage recommendations");
  }
  if (auth.role === "MANAGER" && task.team?.managerUserId !== auth.userId) {
    throw new HttpError(403, "Managers can only manage tasks for teams they manage");
  }
}

function toRecommendationResponse(rec) {
  return {
    id: rec.id,
    candidate_id: rec.candidateId,
    candidate_name: rec.candidate?.user?.name ?? null,
    score: Number(rec.score),
    eligible: rec.explanation?.eligible !== false,
    reasons: Array.isArray(rec.explanation?.reasons) ? rec.explanation.reasons : [],
  };
}

// ── POST /api/tasks/:task_id/recommend ──────────────────────────────────────
// Starts an assignment recommendation workflow for a task.
router.post(
  "/tasks/:task_id/recommend",
  asyncRoute(async (req, res) => {
    const { organizationId, role } = req.auth;
    const { task_id: taskId } = req.params;

    if (!z.string().uuid().safeParse(taskId).success) {
      throw new HttpError(422, "task_id must be a UUID");
    }
    if (role === "MEMBER") {
      throw new HttpError(403, "Only an admin or manager can start a recommendation run");
    }

    const task = await prisma.task.findUnique({
      where: { organizationId_id: { organizationId, id: taskId } },
    });
    if (!task) throw new HttpError(404, "Task not found");

    // Check for an already-active run on this task
    const activeRun = await prisma.agentRun.findFirst({
      where: {
        organizationId,
        taskId,
        status: { in: ["QUEUED", "RUNNING", "AWAITING_APPROVAL"] },
      },
    });
    if (activeRun) {
      throw new HttpError(
        409,
        "An active recommendation run already exists for this task",
        { run_id: activeRun.id },
      );
    }

    // Call the agent service to start the workflow
    let workflowId;
    try {
      const response = await fetch(`${agentServiceUrl()}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, task_id: taskId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? `Agent service returned ${response.status}`);
      }
      const body = await response.json();
      workflowId = body.thread_id;
    } catch (callError) {
      // If agent service is unavailable, record the run as FAILED immediately
      const run = await prisma.agentRun.create({
        data: {
          organizationId,
          taskId,
          workflowId: `stub-${crypto.randomUUID()}`,
          status: "FAILED",
          error: `Agent service unavailable: ${callError.message}`,
          completedAt: new Date(),
        },
      });
      return res.status(202).json({ run_id: run.id, status: "failed" });
    }

    const run = await prisma.agentRun.create({
      data: { organizationId, taskId, workflowId, status: "QUEUED" },
    });

    res.status(202).json({ run_id: run.id, status: "queued" });
  }),
);

// ── GET /api/agent-runs/:run_id ──────────────────────────────────────────────
// Poll workflow status and get recommendations.
router.get(
  "/agent-runs/:run_id",
  asyncRoute(async (req, res) => {
    const { organizationId } = req.auth;
    const { run_id: runId } = req.params;

    if (!z.string().uuid().safeParse(runId).success) {
      throw new HttpError(422, "run_id must be a UUID");
    }

    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.organizationId !== organizationId) {
      throw new HttpError(404, "Agent run not found");
    }

    // If still active, poll the agent service for the latest status
    if (["QUEUED", "RUNNING", "AWAITING_APPROVAL"].includes(run.status)) {
      try {
        const response = await fetch(
          `${agentServiceUrl()}/runs/${run.workflowId}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (response.ok) {
          const body = await response.json();
          const newStatus = mapAgentStatus(body.status);
          if (newStatus !== run.status) {
            await prisma.agentRun.update({
              where: { id: runId },
              data: {
                status: newStatus,
                error: body.error ?? null,
                completedAt: ["COMPLETED", "FAILED", "CANCELLED", "NO_MATCH"].includes(newStatus)
                  ? new Date()
                  : null,
              },
            });
          }
          // If recommendations arrived, persist them
          if (body.recommendations?.length) {
            await persistRecommendations(organizationId, run.taskId, runId, body.recommendations);
          }
        }
      } catch {
        // Silently ignore polling errors; return last known state
      }
    }

    // Re-read the run after potential update
    const freshRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });

    const recommendations = await prisma.assignmentRecommendation.findMany({
      where: { organizationId, taskId: freshRun.taskId, agentRunId: freshRun.id },
      include: {
        candidate: { include: { user: { select: { id: true, name: true } } } },
      },
      orderBy: { score: "desc" },
    });

    res.json({
      id: freshRun.id,
      status: mapRunStatus(freshRun.status),
      recommendations: recommendations.map(toRecommendationResponse),
      error: freshRun.error ?? null,
    });
  }),
);

// ── GET /api/agent-runs ──────────────────────────────────────────────────────
// Restore recommendation workflow state after a page refresh.
router.get(
  "/agent-runs",
  asyncRoute(async (req, res) => {
    const { organizationId } = req.auth;
    const runs = await prisma.agentRun.findMany({
      where: { organizationId },
      include: {
        recommendations: {
          include: { candidate: { include: { user: { select: { id: true, name: true } } } } },
          orderBy: { score: "desc" },
        },
      },
      orderBy: { startedAt: "desc" },
      take: 100,
    });

    res.json(runs.map((run) => ({
      id: run.id,
      task_id: run.taskId,
      status: mapRunStatus(run.status),
      recommendations: run.recommendations.map(toRecommendationResponse),
      error: run.error ?? null,
    })));
  }),
);

// ── GET /api/tasks/:task_id/recommendations ──────────────────────────────────
// List ranked recommendations for a task.
router.get(
  "/tasks/:task_id/recommendations",
  asyncRoute(async (req, res) => {
    const { organizationId } = req.auth;
    const { task_id: taskId } = req.params;

    if (!z.string().uuid().safeParse(taskId).success) {
      throw new HttpError(422, "task_id must be a UUID");
    }

    const task = await prisma.task.findUnique({
      where: { organizationId_id: { organizationId, id: taskId } },
    });
    if (!task) throw new HttpError(404, "Task not found");

    const latestRun = await prisma.agentRun.findFirst({
      where: { organizationId, taskId },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    const recommendations = await prisma.assignmentRecommendation.findMany({
      where: {
        organizationId,
        taskId,
        ...(latestRun ? { agentRunId: latestRun.id } : {}),
      },
      include: {
        candidate: { include: { user: { select: { id: true, name: true } } } },
      },
      orderBy: { score: "desc" },
    });

    res.json(recommendations.map(toRecommendationResponse));
  }),
);

// ── POST /api/recommendations/:recommendation_id/approve ─────────────────────
// Approve a recommendation; commits the assignment atomically.
router.post(
  "/recommendations/:recommendation_id/approve",
  asyncRoute(async (req, res) => {
    const { organizationId, userId, role } = req.auth;
    const { recommendation_id: recId } = req.params;

    if (role === "MEMBER") {
      throw new HttpError(403, "Only an admin or manager can approve recommendations");
    }
    if (!z.string().uuid().safeParse(recId).success) {
      throw new HttpError(422, "recommendation_id must be a UUID");
    }

    const CommentSchema = z.object({ comment: z.string().max(2000).optional() });
    const parsed = CommentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }

    const rec = await prisma.assignmentRecommendation.findFirst({
      where: { organizationId, id: recId },
      include: {
        task: { include: { team: true } },
        approval: true,
        candidate: true,
        agentRun: true,
      },
    });
    if (!rec) throw new HttpError(404, "Recommendation not found");
    requireTaskManagerAccess(req.auth, rec.task)

    // Idempotency — already approved
    if (rec.approval?.status === "APPROVED") {
      const assignment = await prisma.assignment.findFirst({
        where: { organizationId, taskId: rec.taskId, userId: rec.candidateId, status: "ACTIVE" },
      });
      if (assignment) {
        await resumeAgentRun(rec.agentRunId, rec.agentRun?.workflowId, {
          status: "approved",
          candidate_id: rec.candidateId,
          approver_user_id: userId,
          comment: parsed.data.comment ?? null,
        });
        return res.json({ assignment_id: assignment.id, status: "assigned" });
      }
    }

    if (rec.approval?.status === "REJECTED") {
      throw new HttpError(409, "This recommendation has already been rejected");
    }

    // Re-check task still assignable
    if (["COMPLETED", "CANCELLED"].includes(rec.task.status)) {
      throw new HttpError(409, "Task is no longer open for assignment");
    }

    // Re-check candidate still belongs to org
    const candidate = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: rec.candidateId },
      },
    });
    if (!candidate) {
      throw new HttpError(409, "Candidate is no longer a member of this organization");
    }

    // Capacity re-check: count active assignments
    const activeAssignments = await prisma.assignment.count({
      where: { organizationId, userId: rec.candidateId, status: "ACTIVE" },
    });
    if (activeAssignments >= 10) {
      throw new HttpError(
        409,
        "Recommendation is stale or capacity is no longer available",
      );
    }

    // Commit atomically: assignment + approval + task status + audit
    const result = await prisma.$transaction(async (tx) => {
      const existingAssignment = await tx.assignment.findFirst({
      where: {
        organizationId,
        taskId: rec.taskId,
        userId: rec.candidateId,
        status: "ACTIVE",
      },
      });
      const assignment = existingAssignment ?? await tx.assignment.create({
      data: {
        organizationId,
        taskId: rec.taskId,
        userId: rec.candidateId,
        allocatedHours: rec.task.estimatedHours ?? 0,
        status: "ACTIVE",
      },
      });

      // Upsert the approval record
      await tx.approvalRequest.upsert({
        where: { organizationId_recommendationId: { organizationId, recommendationId: recId } },
        create: {
          organizationId,
          recommendationId: recId,
          approverId: userId,
          status: "APPROVED",
          decidedAt: new Date(),
        },
        update: {
          approverId: userId,
          status: "APPROVED",
          decidedAt: new Date(),
        },
      });

      await tx.task.update({
        where: { organizationId_id: { organizationId, id: rec.taskId } },
        data: { status: "IN_PROGRESS" },
      });

      await tx.taskActivity.create({
        data: {
          organizationId,
          taskId: rec.taskId,
          actorId: userId,
          action: "assignment_approved",
          details: {
            recommendation_id: recId,
            candidate_id: rec.candidateId,
            score: Number(rec.score),
            comment: parsed.data.comment ?? null,
          },
        },
      });

      return assignment;
    });

    await resumeAgentRun(rec.agentRunId, rec.agentRun?.workflowId, {
      status: "approved",
      candidate_id: rec.candidateId,
      approver_user_id: userId,
      comment: parsed.data.comment ?? null,
    });

    res.json({ assignment_id: result.id, status: "assigned" });
  }),
);

// ── POST /api/recommendations/:recommendation_id/reject ──────────────────────
router.post(
  "/recommendations/:recommendation_id/reject",
  asyncRoute(async (req, res) => {
    const { organizationId, userId, role } = req.auth;
    const { recommendation_id: recId } = req.params;

    if (role === "MEMBER") {
      throw new HttpError(403, "Only an admin or manager can reject recommendations");
    }
    if (!z.string().uuid().safeParse(recId).success) {
      throw new HttpError(422, "recommendation_id must be a UUID");
    }

    const ReasonSchema = z.object({ reason: z.string().max(2000).optional() });
    const parsed = ReasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(422, "Request validation failed", parsed.error.flatten());
    }

    const rec = await prisma.assignmentRecommendation.findFirst({
      where: { organizationId, id: recId },
      include: { approval: true, agentRun: true, task: { include: { team: true } } },
    });
    if (!rec) throw new HttpError(404, "Recommendation not found");
    requireTaskManagerAccess(req.auth, rec.task)
    if (rec.approval?.status === "APPROVED") {
      throw new HttpError(409, "This recommendation has already been approved");
    }
    if (rec.approval?.status === "REJECTED") {
      return res.status(204).send();
    }

    await prisma.$transaction(async (tx) => {
      await tx.approvalRequest.upsert({
        where: { organizationId_recommendationId: { organizationId, recommendationId: recId } },
        create: {
          organizationId,
          recommendationId: recId,
          approverId: userId,
          status: "REJECTED",
          decidedAt: new Date(),
        },
        update: { approverId: userId, status: "REJECTED", decidedAt: new Date() },
      });

      await tx.taskActivity.create({
        data: {
          organizationId,
          taskId: rec.taskId,
          actorId: userId,
          action: "assignment_rejected",
          details: {
            recommendation_id: recId,
            candidate_id: rec.candidateId,
            reason: parsed.data.reason ?? null,
          },
        },
      });

    });

    await resumeAgentRun(rec.agentRunId, rec.agentRun?.workflowId, {
      status: "rejected",
      reason: parsed.data.reason ?? null,
    });

    res.status(204).send();
  }),
);

// ── helpers ──────────────────────────────────────────────────────────────────

async function resumeAgentRun(agentRunId, workflowId, decision) {
  if (!agentRunId || !workflowId) return;
  try {
    const response = await fetch(`${agentServiceUrl()}/runs/${workflowId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(decision),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      // The agent run will be observed as completed by polling; do not mark it
      // completed until the resume result is reflected in agent state.
      await prisma.agentRun.update({
        where: { id: agentRunId },
        data: { status: "RUNNING", completedAt: null },
      });
    }
  } catch {
    // The database transaction is authoritative; polling can retry observability.
  }
}

function mapAgentStatus(status) {
  const map = {
    queued: "QUEUED",
    running: "RUNNING",
    awaiting_approval: "AWAITING_APPROVAL",
    completed: "COMPLETED",
    failed: "FAILED",
    cancelled: "CANCELLED",
    no_match: "NO_MATCH",
  };
  return map[status] ?? "RUNNING";
}

/**
 * Persist ranked recommendations from the agent service into the DB,
 * skipping ones that already exist for this task/candidate pair.
 */
async function persistRecommendations(organizationId, taskId, agentRunId, recommendations) {
  for (const rec of recommendations) {
    if (!rec.candidate_id) continue;
    const existing = await prisma.assignmentRecommendation.findFirst({
      where: { organizationId, taskId, agentRunId, candidateId: rec.candidate_id },
    });
    if (!existing) {
      await prisma.assignmentRecommendation.create({
        data: {
          organizationId,
          taskId,
          agentRunId,
          candidateId: rec.candidate_id,
          score: rec.score ?? 0,
          explanation: {
            reasons: rec.reasons ?? [],
            eligible: rec.eligible !== false,
          },
        },
      }).catch(() => {});
    } else {
      await prisma.assignmentRecommendation.update({
        where: { id: existing.id },
        data: {
          score: rec.score ?? 0,
          explanation: {
            reasons: rec.reasons ?? [],
            eligible: rec.eligible !== false,
          },
        },
      });
    }
  }
}

export default router;
