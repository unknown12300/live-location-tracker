// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
// const bcrypt = require('bcrypt'); // <-- REMOVE THIS LINE

const app = express();
const PORT = process.env.PORT || 3000;

// --- Paths: Use PERSISTENT disk on Render ---
const DATA_DIR = process.env.DATA_DIR || '/var/data';
const EMPLOYEES_CSV = path.join(DATA_DIR, 'employees.csv');
const PASSWORD_FILE = path.join(DATA_DIR, 'password.txt');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`📁 Created data directory: ${DATA_DIR}`);
  } catch (err) {
    console.error(`🔴 Failed to create data directory ${DATA_DIR}:`, err);
  }
}

// Create empty CSV if not exists
if (!fs.existsSync(EMPLOYEES_CSV)) {
  try {
    fs.writeFileSync(EMPLOYEES_CSV, 'id,name,email,latitude,longitude,city,lastSeen\n');
    console.log(`📄 Created initial employees.csv: ${EMPLOYEES_CSV}`);
  } catch (err) {
    console.error(`🔴 Failed to create initial employees.csv:`, err);
  }
}

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-VERY-SECURE-random-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100
});
app.use(limiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts. Try again later.'
});

// --- In-memory cache and geocoding functions remain the same ---
// (Keep the cityCache, CACHE_TTL, getCacheKey, getCityFromCoordinates functions as they were)

// --- Read/Write employee functions remain the same ---
// (Keep readEmployees and writeEmployees functions as they were)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

// Login page
app.get('/', (req, res) => {
  if (req.session?.loggedIn) {
    return res.redirect('/manager');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle login (PLAIN TEXT VERSION)
app.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  try {
    if (!fs.existsSync(PASSWORD_FILE)) {
      console.error("🔐 Password file missing!");
      return res.status(500).send("Server not configured - Missing password.txt file");
    }

    // Read and parse the plain text password file
    // Expected format: username:password (e.g., manager:secretpassword)
    const authLine = fs.readFileSync(PASSWORD_FILE, 'utf-8').trim();
    const [fileUsername, filePassword] = authLine.split(':');

    if (!fileUsername || !filePassword) {
      console.error("🔐 Invalid password.txt format. Expected 'username:password'");
      return res.status(500).send("Server config error - Invalid password.txt format");
    }

    // Direct string comparison (PLAIN TEXT - NOT SECURE)
    if (username === fileUsername && password === filePassword) {
      req.session.loggedIn = true;
      console.log(`✅ Manager logged in (PLAIN TEXT): ${username}`);
      return res.redirect('/manager');
    } else {
      console.log(`❌ Failed login attempt (plain text): ${username}`);
      // Redirect with error flag for client-side display
      return res.redirect('/?error=1');
    }

  } catch (err) {
    console.error("🔐 Plain text login error:", err);
    res.status(500).send("Server error during login process");
  }
});

// Logout (Remains the same)
app.get('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      if (err) {
        console.error("Error destroying session:", err);
      }
    });
  }
  res.redirect('/');
});

// Protected manager dashboard (Remains the same - assumes manager.html is moved)
app.get('/manager', (req, res) => {
  if (!req.session?.loggedIn) {
    console.log("Unauthorized access attempt to /manager");
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'views', 'manager.html'));
});

// Block direct access (Remains the same)
app.get('/manager.html', (req, res) => {
  console.log("Blocked direct access to /manager.html");
  res.redirect('/');
});

// --- Employee creation, get employees, update location, stop sharing, employee exists routes remain the same ---
// (Keep all routes from /create-employee down to /employee-exists/:id as they were)

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
  console.log(`📁 Data directory configured: ${DATA_DIR}`);
  console.log(`📄 employees.csv check: ${fs.existsSync(EMPLOYEES_CSV) ? 'OK' : 'MISSING (will be created)'} `);
  console.log(`🔑 password.txt check: ${fs.existsSync(PASSWORD_FILE) ? 'OK' : 'MISSING (create it with format username:password)'} `);
  // Update log message to indicate plain text usage
  console.log("⚠️  WARNING: Using PLAIN TEXT password comparison. This is insecure.");
});
