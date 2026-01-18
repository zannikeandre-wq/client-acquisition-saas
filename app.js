// app.js
const express = require("express");
const bodyParser = require("body-parser");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const bcrypt = require("bcrypt");
const { Configuration, OpenAIApi } = require("openai");

const app = express();

// Use PORT from environment (Render sets it automatically)
const PORT = process.env.PORT || 3000;

// Load OpenAI key from environment variables securely
const OPENAI_KEY = process.env.OPENAI_KEY;

if (!OPENAI_KEY) {
  console.error("ERROR: OPENAI_KEY is not set in environment variables.");
  process.exit(1);
}

const openaiConfig = new Configuration({
  apiKey: OPENAI_KEY,
});
const openai = new OpenAIApi(openaiConfig);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  session({
    secret: "supersecretkey",
    resave: false,
    saveUninitialized: true,
  })
);

// =============== DATABASE ===============
const db = new sqlite3.Database("./saas.db", (err) => {
  if (err) {
    console.error("Failed to open database:", err.message);
    process.exit(1);
  } else {
    console.log("Connected to SQLite database");
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      role TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      skill TEXT,
      base_price INTEGER,
      active INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      whatsapp TEXT,
      service TEXT,
      details TEXT,
      ai_summary TEXT,
      quoted_price INTEGER,
      provider_id INTEGER,
      status TEXT,
      paid INTEGER DEFAULT 0
    )
  `);
});

// =============== AUTH ===============
function auth(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).send("Login required");
    if (role && req.session.user.role !== role)
      return res.status(403).send("Access denied");
    next();
  };
}

// =============== AI ANALYSIS ===============
async function analyze(details) {
  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a project estimator." },
        { role: "user", content: details },
      ],
    });
    return completion.data.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI error:", error.response?.data || error.message);
    return "AI analysis unavailable at this time.";
  }
}

// =============== PROVIDER MATCH ===============
function getProvider(service, cb) {
  db.get(
    SELECT * FROM providers WHERE skill = ? AND active = 1 LIMIT 1,
    [service],
    (err, provider) => {
      if (err) {
        console.error("DB error getting provider:", err.message);
        cb(null);
      } else {
        cb(provider);
      }
    }
  );
}

// =============== ROUTES ===============
app.get("/", (req, res) => {
  res.send(`
    <h1>All-In-One Online</h1>
    <p>Request a service, we handle the rest.</p>
    <a href="/request">Request Service</a>
  `);
});

app.get("/request", (req, res) => {
  res.send(`
    <h2>Request Service</h2>
    <form method="POST" action="/submit">
      <input name="name" placeholder="Name" required/><br/>
      <input name="email" placeholder="Email" required/><br/>
      <input name="whatsapp" placeholder="WhatsApp"/><br/>
      <select name="service">
        <option value="website">Website</option>
        <option value="design">Design</option>
      </select><br/>
      <textarea name="details" placeholder="Describe your project"></textarea><br/>
      <button>Submit</button>
    </form>
  `);
});

app.post("/submit", async (req, res) => {
  const { name, email, whatsapp, service, details } = req.body;
  if (!name || !email || !service) {
    return res.status(400).send("Name, email, and service are required.");
  }

  const aiSummary = await analyze(details || "");

  getProvider(service, (provider) => {
    if (!provider)
      return res.send(
        "Sorry, no providers available for this service at the moment."
      );

    const price = Math.round(provider.base_price * 1.5);

    db.run(
      `INSERT INTO leads 
        (name,email,whatsapp,service,details,ai_summary,quoted_price,provider_id,status)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      [name, email, whatsapp, service, details, aiSummary, price, provider.id, "Quoted"],
      function (err) {
        if (err) {
          console.error("DB insert lead error:", err.message);
          return res.status(500).send("Error saving your request.");
        }

        res.send(`
          <h2>Proposal</h2>
          <p>${aiSummary}</p>
          <h3>Price: R${price}</h3>
          <a href="/pay?lead_id=${this.lastID}">Pay Now</a>
        `);
      }
    );
  });
});

app.get("/pay", (req, res) => {
  const leadId = req.query.lead_id;
  if (!leadId) return res.status(400).send("Lead ID missing.");

  // TODO: Implement payment gateway here (PayPal / PayFast integration)
  // For now, just simulate success:

  db.run(
    UPDATE leads SET paid = 1, status = 'Paid' WHERE id = ?,
    [leadId],
    (err) => {
      if (err) {
        console.error("DB payment update error:", err.message);
        return res.status(500).send("Payment update failed.");
      }
      res.send(`
        <h2>Payment successful!</h2>
        <p>Thank you for your payment.</p>
        <a href="/">Back to Home</a>
      `);
    }
  );
});

// Admin dashboard (protected)
app.get("/admin", auth("admin"), (req, res) => {
  db.all(SELECT * FROM leads, (err, rows) => {
    if (err) {
      return res.status(500).send("Failed to load leads.");
    }
    let out = "<h1>Admin Dashboard</h1>";
    rows.forEach((l) => {
      out += `
        <div>
          ${l.name} | ${l.service} | R${l.quoted_price} | ${l.status}
        </div>
      `;
    });
    res.send(out);
  });
});

// Provider dashboard (protected)
app.get("/provider", auth("provider"), (req, res) => {
  db.all(
    SELECT * FROM leads WHERE provider_id = ?,
    [req.session.user.id],
    (err, rows) => {
      if (err) return res.status(500).send("Failed to load jobs.");
      let html = "<h1>Your Jobs</h1>";
      rows.forEach((r) => {
        html += <div>${r.details} | ${r.status}</div>;
      });
      res.send(html);
    }
  );
});

// Start server
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});