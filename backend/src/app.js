import express from "express";
import authRouter from "./routes/auth.js";
import { requireAuth } from "./middleware/auth.js";
import tasksRouter from "./routes/tasks.js";
import teamsRouter from "./routes/teams.js";
import skillsRouter from "./routes/skills.js";
import membersRouter from "./routes/members.js";
import recommendationsRouter from "./routes/recommendations.js";
import { HttpError } from "./lib/http-error.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api", requireAuth);
app.use("/api/tasks", tasksRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/teams", membersRouter); // /api/teams/:team_id/members
app.use("/api", recommendationsRouter); // task recommend, agent-runs, approve/reject

app.use((_req, _res, next) => {
  next(new HttpError(404, "Route not found"));
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ error: "Malformed JSON request body" });
  }

  const status =
    error instanceof HttpError
      ? error.status
      : error?.code === "P2002"
        ? 409
        : 500;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({
    error:
      status >= 500
        ? "Internal server error"
        : error instanceof HttpError
          ? error.message
          : "A resource with that unique value already exists",
    ...(error.details ? { details: error.details } : {}),
  });
});