"""
Concrete implementation of the AssignmentServices protocol defined in
assignment_graph.py.  All methods delegate to the DB helpers in db.py.
"""
from __future__ import annotations

from typing import Any

from .db import (
    commit_assignment_db,
    fetch_availability,
    fetch_candidates,
    fetch_task,
)


class PrismaAssignmentServices:
    """
    Implements AssignmentServices using direct asyncpg queries against the
    shared PostgreSQL database (same DB as the Node/Prisma backend).
    """

    async def analyze_task(
        self, organization_id: str, task_id: str
    ) -> dict[str, Any]:
        task = await fetch_task(organization_id, task_id)
        if task is None:
            raise ValueError(f"Task {task_id} not found in org {organization_id}")
        return task

    async def match_candidates(
        self, organization_id: str, task: dict[str, Any]
    ) -> list[dict[str, Any]]:
        return await fetch_candidates(organization_id, task)

    async def check_availability(
        self,
        organization_id: str,
        task: dict[str, Any],
        candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return await fetch_availability(organization_id, task, candidates)

    async def commit_assignment(
        self,
        organization_id: str,
        task_id: str,
        employee_id: str,
        approver_user_id: str,
    ) -> dict[str, Any]:
        return await commit_assignment_db(
            organization_id, task_id, employee_id, approver_user_id
        )
