// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt'); // <-- ADD THIS

const app = express();
const PORT = process.env.PORT || 3000;

// --- Paths: Use PERSISTENT disk on Render ---
// Use environment variable if set (Render), otherwise default to /var/data
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
    // Consider handling this error more gracefully or letting the app fail
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

// Session setup (Use environment variable for secret in production)
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-VERY-SECURE-random-secret-change-in-prod', // <-- CHANGE IN PROD
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

// In-memory cache for reverse geocoding
const cityCache = {};
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

function getCacheKey(lat, lng) {
  return `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}`;
}

async function getCityFromCoordinates(lat, lng) {
  const key = getCacheKey(lat, lng);
  const now = Date.now();

  if (cityCache[key] && now - cityCache[key].timestamp < CACHE_TTL) {
    return cityCache[key].city;
  }

  try {
    // Ensure lat/lng are numbers before sending
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${parseFloat(lat)}&lon=${parseFloat(lng)}&zoom=10`,
      {
        headers: {
          'User-Agent': 'EmployeeTracker/1.0 (contact@yourcompany.com)'
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OSM HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    let city = 'Unknown';

    if (data && data.address) {
      city =
        data.address.city ||
        data.address.town ||
        data.address.village ||
        data.address.hamlet ||
        data.address.county ||
        data.address.state ||
        data.address.country ||
        `Near ${data.display_name.split(',')[0]}`;
    }

    cityCache[key] = { city, timestamp: now };
    return city;
  } catch (err) {
    console.error("📍 Reverse geocoding failed:", err.message);
    cityCache[key] = { city: 'Unknown', timestamp: now };
    return 'Unknown';
  }
}

// Read employees from CSV
function readEmployees() {
  try {
    if (!fs.existsSync(EMPLOYEES_CSV)) {
      console.warn(`📄 employees.csv not found at ${EMPLOYEES_CSV}`);
      return [];
    }
    const data = fs.readFileSync(EMPLOYEES_CSV, 'utf-8');
    if (!data.trim()) {
      console.warn(`📄 employees.csv is empty at ${EMPLOYEES_CSV}`);
      return [];
    }

    return data
      .trim()
      .split('\n')
      .slice(1)
      .map(line => {
        const parts = line.split(',');
        if (parts.length < 7) {
          console.warn(`⚠️ Skipping malformed line in CSV: ${line}`);
          return null;
        }

        const id = parts[0].replace(/^"|"$/g, '').trim();
        const name = parts[1].replace(/^"|"$/g, '').trim() || 'Unknown';
        const email = parts[2].replace(/^"|"$/g, '').trim() || '';
        const latitude = parts[3].replace(/^"|"$/g, '').trim() || '';
        const longitude = parts[4].replace(/^"|"$/g, '').trim() || '';
        const city = parts[5].replace(/^"|"$/g, '').trim() || 'Unknown';
        const lastSeen = parts[6].replace(/^"|"$/g, '').trim() || '';

        if (!id) {
          console.warn(`⚠️ Skipping line with empty ID in CSV: ${line}`);
          return null;
        }

        return { id, name, email, latitude, longitude, city, lastSeen };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("🔴 Error reading employees.csv:", err);
    return [];
  }
}

// Write employees to CSV
function writeEmployees(employees) {
  try {
    const lines = ['id,name,email,latitude,longitude,city,lastSeen'];
    employees.forEach(emp => {
      // Basic escaping for CSV: escape quotes by doubling them
      const line = [
        emp.id,
        `"${emp.name.replace(/"/g, '""')}"`,
        `"${emp.email.replace(/"/g, '""')}"`,
        emp.latitude,
        emp.longitude,
        `"${emp.city.replace(/"/g, '""')}"`,
        emp.lastSeen
      ].join(',');
      lines.push(line);
    });

    fs.writeFileSync(EMPLOYEES_CSV, lines.join('\n') + '\n');
    console.log(`✅ Wrote ${employees.length} employees to CSV (${EMPLOYEES_CSV})`);
    return true;
  } catch (err) {
    console.error("🔴 Error writing to employees.csv:", err);
    return false;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

// Login page
app.get('/', (req, res) => {
  if (req.session?.loggedIn) {
    return res.redirect('/manager');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html')); // Serve index.html
});

// Handle login (WITH BCRYPT)
app.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  try {
    if (!fs.existsSync(PASSWORD_FILE)) {
      console.error("🔐 Password file missing!");
      return res.status(500).send("Server not configured - Missing password file");
    }

    const auth = fs.readFileSync(PASSWORD_FILE, 'utf-8').trim();
    const [user, hash] = auth.split(':'); // Expect username:hash

    if (!user || !hash) {
      console.error("🔐 Invalid password.txt format");
      return res.status(500).send("Server config error - Invalid password file format");
    }

    if (username === user) {
      bcrypt.compare(password, hash, (err, isMatch) => {
        if (err) {
          console.error("🔐 Bcrypt compare error:", err);
          return res.status(500).send("Server error during login");
        }
        if (isMatch) {
          req.session.loggedIn = true;
          console.log(`✅ Manager logged in: ${username}`);
          return res.redirect('/manager');
        } else {
          console.log(`❌ Failed login attempt (wrong password): ${username}`);
          // Redirect with error flag for client-side display
          return res.redirect('/?error=1');
        }
      });
    } else {
       console.log(`❌ Failed login attempt (wrong username): ${username}`);
       // Redirect with error flag for client-side display
       return res.redirect('/?error=1');
    }

  } catch (err) {
    console.error("🔐 Login error:", err);
    res.status(500).send("Server error during login process");
  }
});

// Logout
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

// Protected manager dashboard
// MOVE manager.html OUT OF public/ FOLDER (e.g., into views/)
app.get('/manager', (req, res) => {
  if (!req.session?.loggedIn) {
    console.log("Unauthorized access attempt to /manager");
    return res.redirect('/'); // Redirect unauthenticated users
  }
  // Serve from views/ folder
  res.sendFile(path.join(__dirname, 'views', 'manager.html'));
});

// BLOCK direct access to manager.html
app.get('/manager.html', (req, res) => {
  console.log("Blocked direct access to /manager.html");
  res.redirect('/'); // Redirect to login
});

// Create employee
app.post('/create-employee', (req, res) => {
  const { id, name, email } = req.body;
  const employees = readEmployees();

  if (!id || !name || !email) {
    return res.json({ success: false, message: 'All fields are required' });
  }

  if (employees.some(emp => emp.id === id)) {
    return res.json({ success: false, message: 'ID already exists' });
  }

  const newEmp = {
    id,
    name,
    email,
    latitude: '',
    longitude: '',
    city: 'Unknown',
    lastSeen: ''
  };

  const success = writeEmployees([...employees, newEmp]);

  if (success) {
    console.log(`✅ Created employee: ${id}`);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Failed to save employee' });
  }
});

// Get all employees
app.get('/employees', (req, res) => {
  const employees = readEmployees();
  console.log(`📤 Sent ${employees.length} employees to requester`);
  res.json(employees);
});

// Update location
app.post('/update-location', async (req, res) => {
  const { id, latitude, longitude } = req.body;

  if (!id || latitude == null || longitude == null) {
    console.warn("⚠️ Invalid update-location data received:", req.body);
    return res.status(400).json({ success: false, message: 'Missing data (ID, lat, or lng)' });
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    console.warn(`⚠️ Invalid coordinates received for ID ${id}: lat=${latitude}, lng=${longitude}`);
    return res.status(400).json({ success: false, message: 'Invalid coordinates' });
  }

  try {
    const city = await getCityFromCoordinates(lat, lng);
    const employees = readEmployees();
    const existingIndex = employees.findIndex(emp => emp.id === id);

    if (existingIndex === -1) {
      console.log(`ℹ️ Employee ID ${id} not found, creating temporary entry for location update.`);
      // Optionally reject if employee must exist first, or create a minimal entry
      // For now, let's assume employee must exist. Reject.
      return res.status(404).json({ success: false, message: 'Employee ID not found. Please contact manager.' });
    }

    // Update existing employee data
    employees[existingIndex].latitude = lat.toString();
    employees[existingIndex].longitude = lng.toString();
    employees[existingIndex].city = city;
    employees[existingIndex].lastSeen = new Date().toISOString();

    const success = writeEmployees(employees);

    if (success) {
      console.log(`📍 Updated location for ${id}: ${lat}, ${lng} → ${city}`);
      res.json({ success: true, city });
    } else {
      res.status(500).json({ success: false, message: 'Failed to update location (write error)' });
    }
  } catch (err) {
    console.error("📍 Error in /update-location:", err);
    res.status(500).json({ success: false, message: 'Internal server error during location update' });
  }
});

// Stop sharing
app.post('/stop-sharing', (req, res) => {
  const { id } = req.body;
  if (!id) {
    console.warn("⚠️ Stop-sharing called without ID");
    return res.status(400).json({ success: false, message: 'Employee ID required' });
  }

  const employees = readEmployees();
  const empIndex = employees.findIndex(e => e.id === id);
  if (empIndex === -1) {
    console.log(`ℹ️ Stop-sharing: Employee ${id} not found`);
    return res.json({ success: true }); // Idempotent - if not found, consider success
  }

  employees[empIndex].latitude = '';
  employees[empIndex].longitude = '';
  employees[empIndex].city = 'Unknown';
  employees[empIndex].lastSeen = '';

  const success = writeEmployees(employees);
  if (success) {
    console.log(`🛑 Cleared location for ${id}`);
    res.json({ success: true });
  } else {
    console.error(`🛑 Failed to clear location for ${id}`);
    res.status(500).json({ success: false, message: 'Write failed during stop-sharing' });
  }
});

// Check if ID exists
app.get('/employee-exists/:id', (req, res) => {
  const { id } = req.params;
  // Sanitize input if needed, though path params are generally safer
  const employees = readEmployees();
  const exists = employees.some(emp => emp.id === id);
  res.json({ exists });
});

// Start server
app.listen(PORT, '0.0.0.0', () => { // Bind to 0.0.0.0 for Render
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
  console.log(`📁 Data directory configured: ${DATA_DIR}`);
  console.log(`📄 employees.csv check: ${fs.existsSync(EMPLOYEES_CSV) ? 'OK' : 'MISSING (will be created)'} `);
  console.log(`🔑 password.txt check: ${fs.existsSync(PASSWORD_FILE) ? 'OK' : 'MISSING (create it!)'} `);
});
