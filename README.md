# SmartAssign Architecture Starter

This repository contains the first engineering deliverable from the SmartAssign blueprint:

- `prisma/schema.prisma`: PostgreSQL data model with organization-scoped relationships.
- `openapi.yaml`: initial task allocation and approval API contract.
- `agent-service/app/assignment_graph.py`: LangGraph workflow for analysis, deterministic eligibility/ranking, manager approval, and assignment commit.
- `backend/`: Express API for authentication, teams, and tasks with organization-scoped access controls.
- `frontend/`: React/Vite manager workspace for teams and task tracking.

## Architecture boundaries

PostgreSQL is the source of truth. API handlers must derive the organization and user from the authenticated session, apply role checks, and scope every query. Never accept an organization ID or approver identity as authoritative merely because it appears in a request body.

The graph delegates task analysis, skill matching, availability checks, and the final commit to `AssignmentServices`. Implement those methods using controlled backend APIs or repositories. `commit_assignment` must re-check organization membership and capacity and write the assignment, approval, and audit activity in one database transaction; this protects against stale recommendations and concurrent approvals.

The approval node uses LangGraph's interrupt/resume mechanism. Compile it with a durable checkpointer in production and use a stable `thread_id` for each agent run. The API should return `202 Accepted` when starting a run, persist its run ID, and resume the graph only after authenticating and authorizing the manager.

Ranking expects each candidate to include normalized `skill_score`, `capacity_score`, `fairness_score`, and `experience_score` values from 0 to 100. Mandatory skill and deadline-capacity constraints belong in the matching and availability services; only eligible candidates proceed to ranking. The scoring weights are initial heuristics from the product blueprint.

## Initial checks

Validate the Prisma model with:

```sh
	npm run db:validate --prefix backend
```

Install the agent workflow dependency with:

```sh
python -m pip install -r agent-service/requirements.txt
```

The API contract and graph are an initial integration boundary, not a complete deployed application. Registration/login, team/task routes, and the manager frontend are implemented; recommendation-run routes, service implementations, and durable checkpointer configuration remain.

## Backend

Copy `backend/.env.example` to `backend/.env` and set a private JWT secret. From the repository root, run `npm install --prefix backend`, `npm run db:generate --prefix backend`, `npm run db:push --prefix backend`, then `npm run dev --prefix backend`. The API implements `POST /api/auth/register`, `POST /api/auth/login`, `GET/POST /api/teams`, and `GET/POST /api/tasks`. Registration creates the first organization admin; login returns an organization-scoped HS256 token. Membership and role are checked against PostgreSQL on each protected request.

## Frontend

From the repository root, run `npm install --prefix frontend` then `npm run dev --prefix frontend`. Vite serves the UI on port 5173 and proxies `/api` requests to the backend on port 3000. Start the backend and apply the Prisma schema before registering an organization.