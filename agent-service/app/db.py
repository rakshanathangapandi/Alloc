"""
Async database helpers for the agent service.

Uses asyncpg directly — the agent service doesn't have Prisma, so it reads
the SmartAssign schema via raw SQL.  All queries are organisation-scoped.
"""
from __future__ import annotations

import asyncio
import asyncpg
from typing import Optional

from .config import settings

_pool: Optional[asyncpg.Pool] = None
_pool_loop: Optional[asyncio.AbstractEventLoop] = None


async def get_pool() -> asyncpg.Pool:
    global _pool, _pool_loop
    loop = asyncio.get_running_loop()
    if _pool is None or _pool_loop is not loop:
        # asyncpg pools are bound to the loop that created their connections.
        # Recreate the pool when LangGraph moves between worker event loops.
        dsn = settings.database_url.replace("postgres://", "postgresql://", 1)
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=10)
        _pool_loop = loop
    return _pool


async def close_pool() -> None:
    global _pool, _pool_loop
    if _pool:
        await _pool.close()
        _pool = None
        _pool_loop = None


# ── task ─────────────────────────────────────────────────────────────────────

async def fetch_task(organization_id: str, task_id: str) -> Optional[dict]:
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT
            t.id,
            t.organization_id,
            t.team_id,
            t.title,
            t.description,
            t.priority,
            t.status,
            t.deadline,
            t.estimated_hours
        FROM tasks t
        WHERE t.organization_id = $1 AND t.id = $2
        """,
        organization_id,
        task_id,
    )
    if row is None:
        return None
    task = dict(row)

    # Attach required skills
    skills = await pool.fetch(
        """
        SELECT
            trs.skill_id,
            trs.minimum_level,
            trs.mandatory,
            s.name  AS skill_name
        FROM task_required_skills trs
        JOIN skills s ON s.organization_id = trs.organization_id AND s.id = trs.skill_id
        WHERE trs.organization_id = $1 AND trs.task_id = $2
        """,
        organization_id,
        task_id,
    )
    task["required_skills"] = [dict(s) for s in skills]
    return task


# ── candidates ───────────────────────────────────────────────────────────────

async def fetch_candidates(organization_id: str, task: dict) -> list[dict]:
    """
    Return org members who have at least one of the task's required skills,
    or all active members if the task has no skill requirements.
    """
    pool = await get_pool()
    required_skills: list[dict] = task.get("required_skills", [])
    team_id = task.get("team_id")
    if not team_id:
        return []

    if not required_skills:
        rows = await pool.fetch(
            """
            SELECT
                om.user_id      AS candidate_id,
                u.name,
                om.role
            FROM organization_members om
            JOIN users u ON u.id = om.user_id
            JOIN team_members tm
              ON tm.organization_id = om.organization_id
             AND tm.user_id = om.user_id
             AND tm.team_id = $2
            WHERE om.organization_id = $1
            """,
            organization_id,
            team_id,
        )
        return [_bare_candidate(r) for r in rows]

    skill_ids = [s["skill_id"] for s in required_skills]

    rows = await pool.fetch(
        """
        SELECT DISTINCT
            om.user_id          AS candidate_id,
            u.name,
            om.role
        FROM organization_members om
        JOIN users u         ON u.id = om.user_id
        JOIN user_skills us  ON us.organization_id = om.organization_id
                             AND us.user_id = om.user_id
        JOIN team_members tm
          ON tm.organization_id = om.organization_id
         AND tm.user_id = om.user_id
         AND tm.team_id = $3
        WHERE om.organization_id = $1
          AND us.skill_id = ANY($2::uuid[])
        """,
        organization_id,
        skill_ids,
        team_id,
    )

    # For each candidate, fetch their full skill profile
    candidates = []
    for row in rows:
        candidate_id = str(row["candidate_id"])
        skill_rows = await pool.fetch(
            """
            SELECT skill_id, proficiency
            FROM user_skills
            WHERE organization_id = $1 AND user_id = $2
            """,
            organization_id,
            candidate_id,
        )
        skill_map = {str(s["skill_id"]): s["proficiency"] for s in skill_rows}

        # Compute skill_score: ratio of required skills met at minimum level
        met = 0
        for req in required_skills:
            prof = skill_map.get(str(req["skill_id"]), 0)
            if prof >= req["minimum_level"]:
                met += 1
        skill_score = (met / len(required_skills)) * 100 if required_skills else 100.0

        candidates.append(
            {
                "candidate_id": candidate_id,
                "name": row["name"],
                "role": row["role"],
                "skill_score": round(skill_score, 2),
                "skill_map": skill_map,
            }
        )

    return candidates


def _bare_candidate(row) -> dict:
    return {
        "candidate_id": str(row["candidate_id"]),
        "name": row["name"],
        "role": row["role"],
        "skill_score": 50.0,  # no skill requirements — neutral score
        "skill_map": {},
    }


# ── availability ─────────────────────────────────────────────────────────────

async def fetch_availability(
    organization_id: str,
    task: dict,
    candidates: list[dict],
) -> list[dict]:
    """
    For each candidate, compute:
      - capacity_score  : available weekly hours vs task estimated_hours
      - fairness_score  : inverse of active assignment count (0–100)
      - experience_score: average proficiency across skills (0–100)
      - eligible        : mandatory skill requirements met AND deadline capacity OK

    Returns the enriched candidate list; ineligible candidates are included
    with eligible=False so the graph can surface them for transparency.
    """
    pool = await get_pool()
    required_skills: list[dict] = task.get("required_skills", [])
    estimated_hours = float(task.get("estimated_hours") or 8)  # default 8 h if unset
    deadline = task.get("deadline")

    enriched = []
    for candidate in candidates:
        candidate_id = candidate["candidate_id"]

        # ── active assignment count (fairness + capacity proxy) ──────────────
        active_count = await pool.fetchval(
            """
            SELECT COUNT(*)
            FROM assignments
            WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'
            """,
            organization_id,
            candidate_id,
        )
        active_count = int(active_count or 0)

        # ── weekly available hours ───────────────────────────────────────────
        weekly_hours = await pool.fetchval(
            """
            SELECT COALESCE(SUM(available_hours), 0)
            FROM work_schedules
            WHERE organization_id = $1 AND user_id = $2
            """,
            organization_id,
            candidate_id,
        )
        weekly_hours = float(weekly_hours or 40)  # default full-time if no schedule

        # Deduct hours already allocated in active assignments
        allocated = await pool.fetchval(
            """
            SELECT COALESCE(SUM(allocated_hours), 0)
            FROM assignments
            WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'
            """,
            organization_id,
            candidate_id,
        )
        allocated = float(allocated or 0)

        # Check leave overlap if deadline is set
        on_leave = False
        if deadline:
            leave_overlap = await pool.fetchval(
                """
                SELECT COUNT(*)
                FROM leave_requests
                WHERE organization_id = $1
                  AND user_id = $2
                  AND status = 'APPROVED'
                  AND start_at <= $3
                  AND end_at   >= NOW()
                """,
                organization_id,
                candidate_id,
                deadline,
            )
            on_leave = int(leave_overlap or 0) > 0

        free_hours = max(0.0, weekly_hours - allocated)

        # capacity_score: 100 if free_hours >= estimated_hours, scales down
        if estimated_hours > 0:
            capacity_score = min(100.0, (free_hours / estimated_hours) * 100)
        else:
            capacity_score = 100.0 if free_hours > 0 else 0.0

        # fairness_score: fewer active tasks → higher fairness (max 10 tasks)
        fairness_score = max(0.0, (1 - active_count / 10) * 100)

        # experience_score: average proficiency across the candidate's skills
        skill_map: dict = candidate.get("skill_map", {})
        if skill_map:
            experience_score = min(100.0, (sum(skill_map.values()) / len(skill_map)) * 20)
        else:
            experience_score = 0.0

        # ── eligibility ──────────────────────────────────────────────────────
        eligible = True
        reasons: list[str] = []

        if on_leave:
            eligible = False
            reasons.append("On approved leave during task deadline")

        for req in required_skills:
            if req.get("mandatory", True):
                prof = candidate.get("skill_map", {}).get(str(req["skill_id"]), 0)
                if prof < req["minimum_level"]:
                    eligible = False
                    reasons.append(
                        f"Missing mandatory skill (required level {req['minimum_level']}, has {prof})"
                    )

        if capacity_score < 10:
            eligible = False
            reasons.append("Insufficient capacity for estimated task hours")

        if eligible:
            reasons.append(
                f"Meets all requirements — {round(free_hours, 1)}h available this week"
            )

        enriched.append(
            {
                **candidate,
                "capacity_score": round(capacity_score, 2),
                "fairness_score": round(fairness_score, 2),
                "experience_score": round(experience_score, 2),
                "eligible": eligible,
                "reasons": reasons,
            }
        )

    return enriched


# ── commit assignment ─────────────────────────────────────────────────────────

async def commit_assignment_db(
    organization_id: str,
    task_id: str,
    employee_id: str,
    approver_user_id: str,
) -> dict:
    """
    Write the assignment, approval, and audit activity in one transaction.
    Re-checks org membership and capacity before committing.
    """
    pool = await get_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Re-check membership
            member = await conn.fetchrow(
                """
                SELECT user_id FROM organization_members
                WHERE organization_id = $1 AND user_id = $2
                """,
                organization_id,
                employee_id,
            )
            if not member:
                raise ValueError("Candidate is no longer a member of this organization")

            # Re-check capacity
            active_count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM assignments
                WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'
                """,
                organization_id,
                employee_id,
            )
            if int(active_count or 0) >= 10:
                raise ValueError("Candidate no longer has capacity for a new assignment")

            # Fetch task estimated_hours
            task_row = await conn.fetchrow(
                "SELECT estimated_hours FROM tasks WHERE organization_id = $1 AND id = $2",
                organization_id,
                task_id,
            )
            estimated_hours = float(task_row["estimated_hours"] or 0) if task_row else 0.0

            import uuid as _uuid

            assignment_id = str(_uuid.uuid4())
            await conn.execute(
                """
                INSERT INTO assignments
                  (id, organization_id, task_id, user_id, allocated_hours, status, assigned_at)
                VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW())
                """,
                assignment_id,
                organization_id,
                task_id,
                employee_id,
                estimated_hours,
            )

            await conn.execute(
                """
                UPDATE tasks SET status = 'IN_PROGRESS', updated_at = NOW()
                WHERE organization_id = $1 AND id = $2
                """,
                organization_id,
                task_id,
            )

            activity_id = str(_uuid.uuid4())
            await conn.execute(
                """
                INSERT INTO task_activity
                  (id, organization_id, task_id, actor_id, action, details, created_at)
                VALUES ($1, $2, $3, $4, 'agent_assignment_committed', $5::jsonb, NOW())
                """,
                activity_id,
                organization_id,
                task_id,
                approver_user_id,
                f'{{"employee_id": "{employee_id}", "approver_id": "{approver_user_id}"}}',
            )

            return {
                "assignment_id": assignment_id,
                "task_id": task_id,
                "employee_id": employee_id,
                "approver_user_id": approver_user_id,
                "status": "assigned",
            }
