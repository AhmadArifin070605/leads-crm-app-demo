import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database("leads.db");

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    email TEXT,
    phone TEXT,
    status TEXT DEFAULT 'New',
    value REAL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    meeting_date DATETIME NOT NULL,
    notes TEXT,
    is_completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS lead_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'general',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE
  )
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes - Leads
  app.get("/api/leads", (req, res) => {
    try {
      const leads = db.prepare("SELECT * FROM leads ORDER BY updated_at DESC").all();
      res.json(leads);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  app.get("/api/leads/:id/notes", (req, res) => {
    const { id } = req.params;
    try {
      const notes = db.prepare("SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC").all(id);
      res.json(notes);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch lead notes" });
    }
  });

  app.post("/api/leads/:id/notes", (req, res) => {
    const { id } = req.params;
    const { content, type } = req.body;
    try {
      const info = db.prepare(`
        INSERT INTO lead_notes (lead_id, content, type)
        VALUES (?, ?, ?)
      `).run(id, content, type || 'general');

      const newNote = db.prepare("SELECT * FROM lead_notes WHERE id = ?").get(info.lastInsertRowid);
      res.status(201).json(newNote);
    } catch (error) {
      res.status(500).json({ error: "Failed to create lead note" });
    }
  });

  // API Routes - Meetings
  app.get("/api/meetings", (req, res) => {
    try {
      const meetings = db.prepare(`
        SELECT m.*, l.name as lead_name, l.company as lead_company 
        FROM meetings m
        JOIN leads l ON m.lead_id = l.id
        ORDER BY m.meeting_date ASC
      `).all();
      res.json(meetings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch meetings" });
    }
  });

  app.post("/api/meetings", (req, res) => {
    const { lead_id, title, meeting_date, notes } = req.body;
    try {
      const info = db.prepare(`
        INSERT INTO meetings (lead_id, title, meeting_date, notes)
        VALUES (?, ?, ?, ?)
      `).run(lead_id, title, meeting_date, notes || '');

      if (notes) {
        db.prepare(`
          INSERT INTO lead_notes (lead_id, content, type)
          VALUES (?, ?, ?)
        `).run(lead_id, `Meeting Scheduled: ${title}\n\nNotes: ${notes}`, 'meeting');
      }

      const newMeeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(info.lastInsertRowid);
      res.status(201).json(newMeeting);
    } catch (error) {
      res.status(500).json({ error: "Failed to create meeting" });
    }
  });

  app.put("/api/meetings/:id", (req, res) => {
    const { id } = req.params;
    const { title, meeting_date, notes, is_completed } = req.body;
    try {
      const oldMeeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);

      db.prepare(`
        UPDATE meetings 
        SET title = ?, meeting_date = ?, notes = ?, is_completed = ?
        WHERE id = ?
      `).run(title, meeting_date, notes, is_completed ? 1 : 0, id);

      // If notes changed or meeting completed, add to log
      if (notes && notes !== oldMeeting.notes) {
        db.prepare(`
          INSERT INTO lead_notes (lead_id, content, type)
          VALUES (?, ?, ?)
        `).run(oldMeeting.lead_id, `Meeting Update: ${title}\n\nNotes: ${notes}`, 'meeting');
      } else if (is_completed && !oldMeeting.is_completed) {
        db.prepare(`
          INSERT INTO lead_notes (lead_id, content, type)
          VALUES (?, ?, ?)
        `).run(oldMeeting.lead_id, `Meeting Completed: ${title}`, 'meeting');
      }

      const updatedMeeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id);
      res.json(updatedMeeting);
    } catch (error) {
      res.status(500).json({ error: "Failed to update meeting" });
    }
  });

  app.delete("/api/meetings/:id", (req, res) => {
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete meeting" });
    }
  });

  app.post("/api/leads", (req, res) => {
    const { name, company, email, phone, status, value, notes } = req.body;
    try {
      const info = db.prepare(`
        INSERT INTO leads (name, company, email, phone, status, value, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, company, email, phone, status || 'New', value || 0, notes || '');

      const leadId = info.lastInsertRowid;
      if (notes) {
        db.prepare(`
          INSERT INTO lead_notes (lead_id, content, type)
          VALUES (?, ?, ?)
        `).run(leadId, notes, 'general');
      }

      const newLead = db.prepare("SELECT * FROM leads WHERE id = ?").get(leadId);
      res.status(201).json(newLead);
    } catch (error) {
      res.status(500).json({ error: "Failed to create lead" });
    }
  });

  app.put("/api/leads/:id", (req, res) => {
    const { id } = req.params;
    const { name, company, email, phone, status, value, notes } = req.body;
    try {
      const oldLead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);

      db.prepare(`
        UPDATE leads 
        SET name = ?, company = ?, email = ?, phone = ?, status = ?, value = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(name, company, email, phone, status, value, notes, id);

      if (notes && notes !== oldLead.notes) {
        db.prepare(`
          INSERT INTO lead_notes (lead_id, content, type)
          VALUES (?, ?, ?)
        `).run(id, notes, 'general');
      }

      const updatedLead = db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
      res.json(updatedLead);
    } catch (error) {
      res.status(500).json({ error: "Failed to update lead" });
    }
  });

  app.delete("/api/leads/:id", (req, res) => {
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM leads WHERE id = ?").run(id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete lead" });
    }
  });

  const ADMIN_PASSWORD = "admin123";

  app.post("/api/admin/import", (req, res) => {
    const { password, leads } = req.body;

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Invalid admin password" });
    }

    if (!Array.isArray(leads)) {
      return res.status(400).json({ error: "leads must be an array" });
    }

    try {
      const insertStmt = db.prepare(`
        INSERT INTO leads (name, company, email, phone, status, value, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((leadList: any[]) => {
        const results = [];
        for (const lead of leadList) {
          const info = insertStmt.run(
            lead.name,
            lead.company || null,
            lead.email || null,
            lead.phone || null,
            lead.status || "New",
            lead.value || 0,
            lead.notes || ""
          );
          results.push(info.lastInsertRowid);

          console.debug(`[import] Imported lead: ${JSON.stringify(lead)}`);
        }
        return results;
      });

      const importedIds = insertMany(leads);

      console.debug(`[import] Bulk import complete: ${importedIds.length} leads imported`);
      res.status(201).json({
        message: `Successfully imported ${importedIds.length} leads`,
        ids: importedIds,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Import failed", details: error.message });
    }
  });

  app.get("/api/admin/export", (req, res) => {
    const { password } = req.query;

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Invalid admin password" });
    }

    try {
      const leads = db.prepare("SELECT * FROM leads ORDER BY created_at DESC").all();

      const filename = (req.query.filename as string) || "export.csv";
      console.debug(`[export] Exporting to filename: ${filename}`);

      const headers = "id,name,company,email,phone,status,value,notes,created_at\n";
      const rows = leads
        .map(
          (l: any) =>
            `${l.id},"${l.name}","${l.company || ""}","${l.email || ""}","${l.phone || ""}","${l.status}",${l.value},"${l.notes || ""}","${l.created_at}"`
        )
        .join("\n");

      const filePath = path.join(__dirname, filename);

      fs.writeFileSync(filePath, headers + rows);

      console.debug(`[export] Exported ${leads.length} leads: ${JSON.stringify(leads)}`);

      res.download(filePath, filename);
    } catch (error: any) {
      res.status(500).json({ error: "Export failed", details: error.message });
    }
  });

  app.get("/api/admin/stats", (req, res) => {
    try {
      const totalLeads = db.prepare("SELECT COUNT(*) as count FROM leads").get() as any;
      const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM leads GROUP BY status").all();
      const totalValue = db.prepare("SELECT SUM(value) as total FROM leads").get() as any;
      const recentLeads = db.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 10").all();
      const totalMeetings = db.prepare("SELECT COUNT(*) as count FROM meetings").get() as any;

      console.debug(`[stats] Recent leads data: ${JSON.stringify(recentLeads)}`);

      res.json({
        total_leads: totalLeads.count,
        leads_by_status: byStatus,
        total_pipeline_value: totalValue.total || 0,
        recent_leads: recentLeads,
        total_meetings: totalMeetings.count,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch stats", details: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist/index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
