"""
SmartAssign Agent Service — FastAPI entry point.

Endpoints
─────────
POST /runs
    Start a new assignment recommendation workflow.
    Body: { organization_id, task_id }
    Returns: { thread_id, status: "queued" }

GET /runs/{thread_id}
    Poll the current workflow state and any ranked recommendations.
    Returns: { thread_id, status, recommendations, error }

POST /runs/{thread_id}/resume
    Resume a workflow that is AWAITING_APPROVAL with a manager decision.
    Body: { status: "approved"|"rejected", candidate_id?, approver_user_id?, comment? }
    Returns: { thread_id, status }
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .config import settings
from .db import close_pool, get_pool
from .services import PrismaAssignmentServices


# ── Lifespan: pool + checkpointer ─────────────────────────────────────────────

_checkpointer = None
_services: PrismaAssignmentServices | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _checkpointer, _services

    # Warm up the asyncpg pool
    await get_pool()

    # Build Postgres checkpointer (langgraph-checkpoint-postgres)
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    # Convert asyncpg DSN → psycopg DSN (psycopg uses the same format)
    dsn = settings.database_url.replace("postgres://", "postgresql://", 1)
    _checkpointer = AsyncPostgresSaver.from_conn_string(dsn)
    await _checkpointer.setup()

    _services = PrismaAssignmentServices()

    yield

    await close_pool()


app = FastAPI(title="SmartAssign Agent Service", lifespan=lifespan)


# ── In-memory run registry (thread_id → asyncio.Task + state cache) ───────────
# For a production deployment swap this for a Redis-backed or DB-backed registry.

_run_tasks: dict[str, asyncio.Task] = {}
_run_state: dict[str, dict] = {}   # last known state snapshot keyed by thread_id


# ── Schemas ───────────────────────────────────────────────────────────────────

class StartRunRequest(BaseModel):
    organization_id: str
    task_id: str


class ResumeRequest(BaseModel):
    status: str = Field(..., pattern="^(approved|rejected)$")
    candidate_id: str | None = None
    approver_user_id: str | None = None
    comment: str | None = None
    reason: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_graph():
    """Build the compiled LangGraph for this request; reuses the global checkpointer."""
    from .assignment_graph import build_assignment_graph
    return build_assignment_graph(_services, _checkpointer)


def _recommendations_from_state(state: dict) -> list[dict]:
    ranked = state.get("ranked_candidates") or []
    return [
        {
            "candidate_id": c.get("candidate_id"),
            "candidate_name": c.get("name"),
            "score": c.get("score", 0),
            "eligible": c.get("eligible", True),
            "reasons": c.get("reasons", []),
        }
        for c in ranked
    ]


def _status_from_state(state: dict, task_done: bool, task_error: BaseException | None) -> str:
    if task_error:
        return "failed"
    if not task_done:
        # Check if graph is sitting at the interrupt node
        ranked = state.get("ranked_candidates")
        approval = state.get("approval_status")
        if ranked and approval is None:
            return "awaiting_approval"
        return "running"
    if state.get("errors"):
        return "failed"
    if state.get("warnings"):
        return "no_match"
    if state.get("assignment"):
        return "completed"
    approval = state.get("approval_status")
    if approval == "rejected":
        return "completed"
    return "completed"


async def _run_workflow(thread_id: str, organization_id: str, task_id: str) -> None:
    """Execute the LangGraph workflow and keep _run_state updated."""
    graph = _build_graph()
    config = {"configurable": {"thread_id": thread_id}}
    initial_state = {"organization_id": organization_id, "task_id": task_id}

    try:
        _run_state[thread_id] = {"_running": True}
        async for chunk in graph.astream(initial_state, config=config):
            # Merge the latest node output into our cached state
            for node_output in chunk.values():
                _run_state[thread_id].update(node_output)

            # If the graph interrupted for approval, stop streaming and wait
            if _run_state[thread_id].get("ranked_candidates") and \
               _run_state[thread_id].get("approval_status") is None:
                break

        _run_state[thread_id]["_running"] = False
        _run_state[thread_id]["_done"] = True
    except Exception as exc:
        _run_state[thread_id]["_running"] = False
        _run_state[thread_id]["_done"] = True
        _run_state[thread_id]["_error"] = str(exc)
        _run_state[thread_id].setdefault("errors", []).append(str(exc))


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/runs", status_code=202)
async def start_run(body: StartRunRequest) -> dict:
    thread_id = str(uuid.uuid4())
    _run_state[thread_id] = {"_running": False, "_done": False}

    task = asyncio.create_task(
        _run_workflow(thread_id, body.organization_id, body.task_id)
    )
    _run_tasks[thread_id] = task

    return {"thread_id": thread_id, "status": "queued"}


@app.get("/runs/{thread_id}")
async def get_run(thread_id: str) -> dict:
    state = _run_state.get(thread_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Run not found")

    task = _run_tasks.get(thread_id)
    task_done = task is None or task.done()
    task_error = task.exception() if (task_done and task and not task.cancelled()) else None

    status = _status_from_state(state, task_done, task_error)

    return {
        "thread_id": thread_id,
        "status": status,
        "recommendations": _recommendations_from_state(state),
        "error": state.get("_error") or (str(task_error) if task_error else None),
    }


@app.post("/runs/{thread_id}/resume")
async def resume_run(thread_id: str, body: ResumeRequest) -> dict:
    state = _run_state.get(thread_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Run not found")

    task = _run_tasks.get(thread_id)
    task_done = task is None or task.done()

    # Only allow resume when waiting at the interrupt
    current_status = _status_from_state(state, task_done, None)
    if current_status != "awaiting_approval":
        raise HTTPException(
            status_code=409,
            detail=f"Run is not awaiting approval (current status: {current_status})",
        )

    graph = _build_graph()
    config = {"configurable": {"thread_id": thread_id}}

    decision = {
        "status": body.status,
        "candidate_id": body.candidate_id,
        "approver_user_id": body.approver_user_id,
    }

    async def _continue():
        try:
            async for chunk in graph.astream(
                {"type": "resume", "value": decision}, config=config
            ):
                for node_output in chunk.values():
                    _run_state[thread_id].update(node_output)
            _run_state[thread_id]["_done"] = True
            _run_state[thread_id]["_running"] = False
        except Exception as exc:
            _run_state[thread_id]["_done"] = True
            _run_state[thread_id]["_running"] = False
            _run_state[thread_id]["_error"] = str(exc)

    resume_task = asyncio.create_task(_continue())
    _run_tasks[thread_id] = resume_task

    return {"thread_id": thread_id, "status": "running"}


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
