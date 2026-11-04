import os
import unittest

os.environ.setdefault("DATABASE_URL", "******127.0.0.1:5432/unused")

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from app.assignment_graph import build_assignment_graph


class FakeServices:
    def __init__(self, candidates=None):
        self.commit_calls = 0
        self.candidates = candidates or [
            {"candidate_id": "b", "name": "Betsy", "skill_score": 80, "eligible": True},
            {"candidate_id": "a", "name": "Alex", "skill_score": 80, "eligible": True},
        ]

    async def analyze_task(self, organization_id, task_id):
        return {"organization_id": organization_id, "id": task_id, "team_id": "team-1", "required_skills": []}

    async def match_candidates(self, organization_id, task):
        return self.candidates

    async def check_availability(self, organization_id, task, candidates):
        return [{**candidate, "capacity_score": 90 if candidate["candidate_id"] == "a" else 70,
                 "fairness_score": 80, "experience_score": 70, "eligible": candidate.get("eligible", True),
                 "reasons": ["Meets requirements"]} for candidate in candidates]

    async def commit_assignment(self, organization_id, task_id, employee_id, approver_user_id):
        self.commit_calls += 1
        return {"assignment_id": "agent-must-not-write"}


class WorkflowTests(unittest.TestCase):
    def test_ranking_is_deterministic_and_weighted(self):
        services = FakeServices()
        graph = build_assignment_graph(services, MemorySaver())
        config = {"configurable": {"thread_id": "ranking-test"}}
        snapshot = graph.invoke({"organization_id": "org", "task_id": "task"}, config=config)
        ranked = snapshot.get("ranked_candidates", [])
        self.assertEqual([item["candidate_id"] for item in ranked], ["a", "b"])

    def test_approval_interrupt_and_resume(self):
        services = FakeServices()
        graph = build_assignment_graph(services, MemorySaver())
        config = {"configurable": {"thread_id": "approve-test"}}
        interrupted = graph.invoke({"organization_id": "org", "task_id": "task"}, config=config)
        snapshot = graph.get_state(config)
        self.assertTrue(snapshot.tasks and any(getattr(task, "interrupts", ()) for task in snapshot.tasks))
        resumed = graph.invoke(Command(resume={"status": "approved", "candidate_id": "a", "approver_user_id": "manager"}), config=config)
        self.assertEqual(resumed.get("approval_status"), "approved")
        self.assertEqual(resumed.get("selected_employee_id"), "a")
        self.assertEqual(services.commit_calls, 0)

    def test_rejection_resumes_without_assignment_commit(self):
        services = FakeServices()
        graph = build_assignment_graph(services, MemorySaver())
        config = {"configurable": {"thread_id": "reject-test"}}
        graph.invoke({"organization_id": "org", "task_id": "task"}, config=config)
        result = graph.invoke(Command(resume={"status": "rejected"}), config=config)
        self.assertEqual(result.get("approval_status"), "rejected")
        self.assertEqual(services.commit_calls, 0)

    def test_no_match_is_terminal_and_not_awaiting_approval(self):
        services = FakeServices(candidates=[{"candidate_id": "x", "name": "X", "skill_score": 20, "eligible": False}])
        graph = build_assignment_graph(services, MemorySaver())
        config = {"configurable": {"thread_id": "no-match-test"}}
        result = graph.invoke({"organization_id": "org", "task_id": "task"}, config=config)
        snapshot = graph.get_state(config)
        self.assertFalse(any(getattr(task, "interrupts", ()) for task in snapshot.tasks))
        self.assertIn("warnings", result)
        self.assertEqual(services.commit_calls, 0)


if __name__ == "__main__":
    unittest.main()
