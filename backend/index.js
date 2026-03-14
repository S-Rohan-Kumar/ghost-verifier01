// ═══════════════════════════════════════════════════════════════
//  Ghost Business Verifier — Backend Entry Point
//  index.js
// ═══════════════════════════════════════════════════════════════
import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

// ── Route Imports ────────────────────────────────────────────────
import sessionRoutes  from "./routes/sessions.js";
import uploadRoutes   from "./routes/upload.js";
import businessRoutes from "./routes/businesses.js";
import analyticsRoutes from "./routes/analytics.js";
import auditRoutes    from "./routes/audit.js";

// ── App Setup ────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Socket.io ────────────────────────────────────────────────────
export const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);
  socket.on("disconnect", () =>
    console.log(`[Socket.io] Client disconnected: ${socket.id}`)
  );
});

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ── Request logger (shows every hit in Render logs) ──────────────
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

// ── Routes ───────────────────────────────────────────────────────
app.use("/api/sessions",   sessionRoutes);
app.use("/api/upload",     uploadRoutes);
app.use("/api/businesses", businessRoutes);
app.use("/api/analytics",  analyticsRoutes);
app.use("/api/audit",      auditRoutes);

// ── Health Check ─────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    service: "Ghost Business Verifier API",
    status : "running",
    version: "2.0.0",
    time   : new Date().toISOString(),
  });
});

// ── Global Error Handler ─────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("[Error]", err.stack);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

const start = async () => {
  let retries = 0;
  while (retries < 5) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("[MongoDB] Connected successfully");
      break;
    } catch (err) {
      retries++;
      console.error(`[MongoDB] Connection failed (attempt ${retries}/5):`, err.message);
      if (retries >= 5) {
        console.error("[MongoDB] Could not connect after 5 attempts — exiting");
        process.exit(1);  // let Render restart the service cleanly
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Import enforcer ONCE after DB is confirmed connected
  await import("./jobs/auditEnforcer.js");

  server.listen(PORT, () => {
    console.log(`\n🚀 Ghost Verifier Backend running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/`);
    console.log(`   API:    http://localhost:${PORT}/api/sessions\n`);
  });
};

start();