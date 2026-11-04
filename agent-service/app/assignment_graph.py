from __future__ import annotations

import asyncio
import threading
from typing import Any, Protocol, TypedDict

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt


class AssignmentState(TypedDict, total=False):
    organization_id: str
    task_id: str
    task: dict[str, Any]
    candidates: list[dict[str, Any]]
    eligible_candidates: list[dict[str, Any]]
    ranked_candidates: list[dict[str, Any]]
    approval_status: str
    selected_employee_id: str
    approver_user_id: str
    assignment: dict[str, Any]
    warnings: list[str]
    errors: list[str]


class AssignmentServices(Protocol):
    async def analyze_task(self, organization_id: str, task_id: str) -> dict[str, Any]: ...
    async def match_candidates(self, organization_id: str, task: dict[str, Any]) -> list[dict[str, Any]]: ...
    async def check_availability(self, organization_id: str, task: dict[str, Any], candidates: list[dict[str, Any]]) -> list[dict[str, Any]]: ...
    async def commit_assignment(self, organization_id: str, task_id: str, employee_id: str, approver_user_id: str) -> dict[str, Any]: ...


def _bounded_score(candidate: dict[str, Any], key: str) -> float:
    value = float(candidate.get(key, 0))
    return max(0.0, min(100.0, value))


def build_assignment_graph(services: AssignmentServices, checkpointer: BaseCheckpointSaver):
    thread_state = threading.local()

    def run_async(coro):
        loop = getattr(thread_state, "loop", None)
        if loop is None or loop.is_closed():
            loop = asyncio.new_event_loop()
            thread_state.loop = loop
        return loop.run_until_complete(coro)

    def analyze(state: AssignmentState) -> dict[str, Any]:
        task = run_async(services.analyze_task(state["organization_id"], state["task_id"]))
        return {"task": task}

    def match(state: AssignmentState) -> dict[str, Any]:
        candidates = run_async(services.match_candidates(state["organization_id"], state["task"]))
        return {"candidates": candidates}

    def availability(state: AssignmentState) -> dict[str, Any]:
        eligible = run_async(services.check_availability(state["organization_id"], state["task"], state["candidates"]))
        return {"eligible_candidates": eligible}

    def allocate(state: AssignmentState) -> dict[str, Any]:
        ranked = []
        for candidate in state["eligible_candidates"]:
            if candidate.get("eligible") is False:
                continue
            skill = _bounded_score(candidate, "skill_score")
            capacity = _bounded_score(candidate, "capacity_score")
            fairness = _bounded_score(candidate, "fairness_score")
            experience = _bounded_score(candidate, "experience_score")
            score = 0.45 * skill + 0.30 * capacity + 0.15 * fairness + 0.10 * experience
            ranked.append({**candidate, "score": round(score, 2), "reasons": candidate.get("reasons", [])})
        ranked.sort(key=lambda candidate: (-candidate["score"], candidate["candidate_id"]))
        return {"ranked_candidates": ranked}

    def request_approval(state: AssignmentState) -> dict[str, Any]:
        decision = interrupt({
            "type": "assignment_approval",
            "organization_id": state["organization_id"],
            "task_id": state["task_id"],
            "recommendations": state["ranked_candidates"],
        })
        if not isinstance(decision, dict):
            return {"approval_status": "rejected", "errors": ["Invalid approval response"]}
        approved = decision.get("status") == "approved"
        selected_id = decision.get("candidate_id")
        eligible_ids = {candidate["candidate_id"] for candidate in state["ranked_candidates"]}
        if approved and selected_id not in eligible_ids:
            return {"approval_status": "rejected", "errors": ["Approved employee is not in the eligible recommendations"]}
        if approved and not decision.get("approver_user_id"):
            return {"approval_status": "rejected", "errors": ["Authenticated approver identity is required"]}
        return {
            "approval_status": "approved" if approved else "rejected",
            "selected_employee_id": selected_id,
            "approver_user_id": decision.get("approver_user_id"),
        }

    def no_match(_: AssignmentState) -> dict[str, Any]:
        return {"warnings": ["No candidate met the skill and availability constraints"]}

    def route_candidates(state: AssignmentState) -> str:
        has_eligible = any(candidate.get("eligible") is not False for candidate in state["eligible_candidates"])
        return "allocate" if has_eligible else "no_match"

    def route_approval(_: AssignmentState) -> str:
        # Express/Prisma is the authoritative assignment commit mechanism.
        return END

    graph = StateGraph(AssignmentState)
    graph.add_node("analyze", analyze)
    graph.add_node("match", match)
    graph.add_node("availability", availability)
    graph.add_node("allocate", allocate)
    graph.add_node("approval", request_approval)
    graph.add_node("no_match", no_match)
    graph.add_edge(START, "analyze")
    graph.add_edge("analyze", "match")
    graph.add_edge("match", "availability")
    graph.add_conditional_edges("availability", route_candidates, {"allocate": "allocate", "no_match": "no_match"})
    graph.add_edge("allocate", "approval")
    graph.add_conditional_edges("approval", route_approval, {END: END})
    graph.add_edge("no_match", END)
    return graph.compile(checkpointer=checkpointer)
