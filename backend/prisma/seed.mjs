import dotenv from "dotenv";
import bcrypt from "bcryptjs";

dotenv.config({ path: new URL("../.env", import.meta.url) });
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DEMO_ORGANIZATION = "SmartAssign Demo — College Project";

const teamDefinitions = {
  "Web Development": {
    members: [
      ["Aarav Sharma", "aarav.web@demo.smartassign.local", 4, { React: 5, "Node.js": 4, TypeScript: 4 }],
      ["Meera Iyer", "meera.web@demo.smartassign.local", 3, { React: 4, "Node.js": 5, TypeScript: 3 }],
      ["Rohan Patel", "rohan.web@demo.smartassign.local", 3, { React: 3, "Node.js": 4, PostgreSQL: 4 }],
    ],
    tasks: [
      ["Build student project dashboard", "Create a responsive dashboard for displaying student projects, statuses, and deadlines.", "HIGH", 20, { React: [4, true], TypeScript: [3, false] }],
      ["Implement REST API authentication", "Add secure registration, login, token validation, and role-based route protection.", "URGENT", 16, { "Node.js": [4, true], TypeScript: [3, true] }],
      ["Optimize course catalog database queries", "Improve PostgreSQL queries and indexes for the course catalog listing experience.", "MEDIUM", 12, { PostgreSQL: [4, true], "Node.js": [3, false] }],
      ["Deploy campus portal to staging", "Configure the web deployment pipeline and validate the staging environment.", "LOW", 8, { "Node.js": [3, true], React: [3, false] }],
    ],
  },
  "AI & Machine Learning": {
    members: [
      ["Diya Nair", "diya.ai@demo.smartassign.local", 4, { Python: 5, "Machine Learning": 5, "LangGraph": 4 }],
      ["Kabir Singh", "kabir.ai@demo.smartassign.local", 3, { Python: 4, "Machine Learning": 4, "Data Analysis": 3 }],
      ["Nisha Rao", "nisha.ai@demo.smartassign.local", 3, { Python: 4, PyTorch: 4, "Machine Learning": 3 }],
    ],
    tasks: [
      ["Train student performance prediction model", "Build and evaluate a model that predicts students needing academic support.", "HIGH", 24, { Python: [4, true], "Machine Learning": [4, true] }],
      ["Create task allocation recommendation agent", "Prototype a LangGraph workflow that ranks eligible team members for assignments.", "URGENT", 20, { "LangGraph": [4, true], Python: [4, true] }],
      ["Analyze attendance patterns", "Use descriptive analysis to identify trends and anomalies in attendance records.", "MEDIUM", 10, { "Data Analysis": [3, true], Python: [3, false] }],
      ["Build image classification notebook", "Fine-tune a small image classifier and document training and evaluation results.", "MEDIUM", 18, { PyTorch: [3, true], Python: [4, true] }],
    ],
  },
  "Data Analytics": {
    members: [
      ["Ishaan Mehta", "ishaan.data@demo.smartassign.local", 4, { SQL: 5, Tableau: 4, "Data Analysis": 5, "Data Visualization": 4 }],
      ["Ananya Gupta", "ananya.data@demo.smartassign.local", 3, { Python: 4, SQL: 4, Tableau: 3 }],
      ["Vikram Joshi", "vikram.data@demo.smartassign.local", 3, { SQL: 4, "Data Visualization": 4, "Data Analysis": 3 }],
    ],
    tasks: [
      ["Create enrollment analytics dashboard", "Design a dashboard covering admissions, enrollment trends, and cohort retention.", "HIGH", 16, { Tableau: [3, true], "Data Analysis": [4, true] }],
      ["Build grade distribution report", "Prepare SQL-based grade distribution metrics for faculty review.", "MEDIUM", 10, { SQL: [4, true], "Data Visualization": [3, false] }],
      ["Clean placement survey dataset", "Profile, clean, and validate a placement survey dataset for final reporting.", "HIGH", 14, { "Data Analysis": [3, true], Python: [3, false] }],
      ["Design cohort retention charts", "Create clear visualizations showing year-over-year student retention patterns.", "LOW", 8, { Tableau: [3, true], "Data Visualization": [3, true] }],
    ],
  },
  "Mobile App Development": {
    members: [
      ["Arjun Das", "arjun.mobile@demo.smartassign.local", 4, { Flutter: 5, Dart: 5, Firebase: 4 }],
      ["Saanvi Reddy", "saanvi.mobile@demo.smartassign.local", 3, { React: 4, "React Native": 4, Firebase: 3 }],
      ["Neel Kapoor", "neel.mobile@demo.smartassign.local", 3, { Kotlin: 4, Android: 4, Firebase: 3 }],
    ],
    tasks: [
      ["Implement campus navigation app", "Build interactive campus maps, building search, and navigation shortcuts.", "HIGH", 22, { Flutter: [4, true], Dart: [4, true] }],
      ["Add push notifications for deadlines", "Configure Firebase messaging and notify students about approaching deadlines.", "URGENT", 14, { Firebase: [3, true], React: [3, false] }],
      ["Create React Native timetable screen", "Develop a mobile timetable with class, room, and instructor details.", "MEDIUM", 16, { "React Native": [4, true], React: [3, false] }],
      ["Build Android attendance scanner", "Create an Android scanner that records attendance securely during lectures.", "HIGH", 18, { Kotlin: [4, true], Android: [4, true] }],
    ],
  },
  "Testing & QA": {
    members: [
      ["Pooja Menon", "pooja.qa@demo.smartassign.local", 4, { "Manual Testing": 5, Selenium: 4, "API Testing": 4 }],
      ["Aditya Verma", "aditya.qa@demo.smartassign.local", 3, { Selenium: 5, "Automated Testing": 4, JavaScript: 3 }],
      ["Tara Krishnan", "tara.qa@demo.smartassign.local", 3, { "API Testing": 5, Postman: 4, "Manual Testing": 3 }],
    ],
    tasks: [
      ["Write end-to-end enrollment tests", "Create browser automation coverage for registration, enrollment, and payment confirmation.", "URGENT", 16, { Selenium: [4, true], "Automated Testing": [3, true] }],
      ["Perform mobile regression testing", "Execute a structured regression cycle across supported Android and iOS devices.", "HIGH", 12, { "Manual Testing": [4, true], "Automated Testing": [3, false] }],
      ["Test recommendation API contracts", "Validate recommendation endpoints, status transitions, pagination, and error responses.", "HIGH", 10, { "API Testing": [4, true], Postman: [3, true] }],
      ["Create accessibility test checklist", "Test keyboard navigation, contrast, labels, and screen-reader compatibility.", "MEDIUM", 8, { "Manual Testing": [3, true], "API Testing": [2, false] }],
    ],
  },
};

function demoPasswordHash() {
  return bcrypt.hashSync("DemoPassword!2026", 12);
}

async function main() {
  let organization = await prisma.organization.findFirst({ where: { name: DEMO_ORGANIZATION } });
  if (!organization) organization = await prisma.organization.create({ data: { name: DEMO_ORGANIZATION } });
  const passwordHash = demoPasswordHash();

  const demoManagerEmail = "manager@demo.smartassign.local";
  let demoManager = await prisma.user.findUnique({ where: { email: demoManagerEmail } });
  if (!demoManager) {
    demoManager = await prisma.user.create({
      data: { name: "Demo Manager", email: demoManagerEmail, passwordHash },
    });
  } else {
    await prisma.user.update({
      where: { id: demoManager.id },
      data: { name: "Demo Manager", passwordHash },
    });
  }
  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: demoManager.id } },
    create: { organizationId: organization.id, userId: demoManager.id, role: "ADMIN" },
    update: { role: "ADMIN" },
  });

  const teamIds = {};
  const memberIds = {};

  for (const [teamName, definition] of Object.entries(teamDefinitions)) {
    let team = await prisma.team.findFirst({
      where: { organizationId: organization.id, name: teamName },
    });

    const firstMember = definition.members[0];
    let manager = await prisma.user.findUnique({ where: { email: firstMember[1] } });
    if (!manager) {
      manager = await prisma.user.create({ data: { name: firstMember[0], email: firstMember[1], passwordHash } });
    }

    await prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: manager.id } },
      create: { organizationId: organization.id, userId: manager.id, role: "MANAGER" },
      update: { role: "MANAGER" },
    });

    if (!team) {
      team = await prisma.team.create({ data: { organizationId: organization.id, name: teamName, managerUserId: manager.id } });
    } else {
      team = await prisma.team.update({
        where: { organizationId_id: { organizationId: organization.id, id: team.id } },
        data: { managerUserId: manager.id },
      });
    }
    teamIds[teamName] = team.id;

    for (let index = 0; index < definition.members.length; index++) {
      const [name, email, roleLevel, skills] = definition.members[index];
      let user = await prisma.user.findUnique({ where: { email } });
      if (!user) user = await prisma.user.create({ data: { name, email, passwordHash } });
      else if (user.name !== name) await prisma.user.update({ where: { id: user.id }, data: { name } });

      await prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
        create: { organizationId: organization.id, userId: user.id, role: index === 0 ? "MANAGER" : "MEMBER" },
        update: { role: index === 0 ? "MANAGER" : "MEMBER" },
      });
      await prisma.teamMember.upsert({
        where: { organizationId_teamId_userId: { organizationId: organization.id, teamId: team.id, userId: user.id } },
        create: { organizationId: organization.id, teamId: team.id, userId: user.id },
        update: {},
      });
      memberIds[`${teamName}:${email}`] = user.id;

      for (let weekday = 1; weekday <= 5; weekday++) {
        await prisma.workSchedule.upsert({
          where: { organizationId_userId_weekday: { organizationId: organization.id, userId: user.id, weekday } },
          create: { organizationId: organization.id, userId: user.id, weekday, availableHours: 8, timezone: "Asia/Kolkata" },
          update: { availableHours: 8, timezone: "Asia/Kolkata" },
        });
      }

      for (const [skillName, proficiency] of Object.entries(skills)) {
        let skill = await prisma.skill.findFirst({ where: { organizationId: organization.id, name: skillName } });
        if (!skill) skill = await prisma.skill.create({ data: { organizationId: organization.id, name: skillName, category: teamName } });
        await prisma.userSkill.upsert({
          where: { organizationId_userId_skillId: { organizationId: organization.id, userId: user.id, skillId: skill.id } },
          create: { organizationId: organization.id, userId: user.id, skillId: skill.id, proficiency, verified: proficiency >= 4 },
          update: { proficiency, verified: proficiency >= 4 },
        });
      }
    }

    for (const [title, description, priority, estimatedHours, requirements] of definition.tasks) {
      let task = await prisma.task.findFirst({
        where: { organizationId: organization.id, teamId: team.id, title },
      });
      const taskData = {
        organizationId: organization.id,
        teamId: team.id,
        createdByUserId: manager.id,
        title,
        description,
        priority,
        estimatedHours,
        deadline: new Date("2026-12-15T18:00:00.000Z"),
        status: "BACKLOG",
      };
      if (!task) task = await prisma.task.create({ data: taskData });
      else task = await prisma.task.update({ where: { organizationId_id: { organizationId: organization.id, id: task.id } }, data: taskData });

      await prisma.taskRequiredSkill.deleteMany({ where: { organizationId: organization.id, taskId: task.id } });
      for (const [skillName, [minimumLevel, mandatory]] of Object.entries(requirements)) {
        let skill = await prisma.skill.findFirst({ where: { organizationId: organization.id, name: skillName } });
        if (!skill) skill = await prisma.skill.create({ data: { organizationId: organization.id, name: skillName, category: teamName } });
        await prisma.taskRequiredSkill.create({ data: { organizationId: organization.id, taskId: task.id, skillId: skill.id, minimumLevel, mandatory } });
      }
    }
  }

  console.log(JSON.stringify({ organization: DEMO_ORGANIZATION, organizationId: organization.id, teams: Object.keys(teamDefinitions).length, members: 15, tasks: 20 }, null, 2));
}

main()
  .catch((error) => { console.error(error.message || error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
