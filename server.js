// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Paths: Use 'data' folder in project root ---
const DATA_DIR = path.join(__dirname, 'data');
const EMPLOYEES_CSV = path.join(DATA_DIR, 'employees.csv');
const PASSWORD_FILE = path.join(DATA_DIR, 'password.txt');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create empty CSV if not exists
if (!fs.existsSync(EMPLOYEES_CSV)) {
  fs.writeFileSync(EMPLOYEES_CSV, 'id,name,email,latitude,longitude,city,lastSeen\n');
}

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secure-random-secret-change-in-prod',
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
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10`,
      {
        headers: {
          'User-Agent': 'EmployeeTracker/1.0 (contact@yourcompany.com)'
        }
      }
    );

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

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
    if (!fs.existsSync(EMPLOYEES_CSV)) return [];
    const data = fs.readFileSync(EMPLOYEES_CSV, 'utf-8');
    if (!data.trim()) return [];

    return data
      .trim()
      .split('\n')
      .slice(1)
      .map(line => {
        const parts = line.split(',');
        if (parts.length < 7) return null;

        const id = parts[0].replace(/^"|"$/g, '').trim();
        const name = parts[1].replace(/^"|"$/g, '').trim() || 'Unknown';
        const email = parts[2].replace(/^"|"$/g, '').trim() || '';
        const latitude = parts[3].replace(/^"|"$/g, '').trim() || '';
        const longitude = parts[4].replace(/^"|"$/g, '').trim() || '';
        const city = parts[5].replace(/^"|"$/g, '').trim() || 'Unknown';
        const lastSeen = parts[6].replace(/^"|"$/g, '').trim() || '';

        if (!id) return null;

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
    console.log(`✅ Wrote ${employees.length} employees to CSV`);
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
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Handle login
app.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  try {
    if (!fs.existsSync(PASSWORD_FILE)) {
      console.error("Password file missing!");
      return res.status(500).send("Server not configured");
    }

    const auth = fs.readFileSync(PASSWORD_FILE, 'utf-8').trim();
    const [user, pass] = auth.split(':');

    if (!user || !pass) {
      console.error("Invalid password.txt format");
      return res.status(500).send("Server config error");
    }

    if (username === user && password === pass) {
      req.session.loggedIn = true;
      console.log(`✅ Manager logged in`);
      return res.redirect('/manager');
    }

    console.log(`❌ Failed login attempt: ${username}`);
    res.send('<p>❌ Invalid credentials. <a href="/">Try again</a></p>');
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Server error");
  }
});

// Logout
app.get('/logout', (req, res) => {
  if (req.session) {
    req.session.destroy();
  }
  res.redirect('/');
});

// Protected manager dashboard
app.get('/manager', (req, res) => {
  if (!req.session?.loggedIn) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'manager.html'));
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
  console.log(`📤 Sent ${employees.length} employees to manager`);
  res.json(employees);
});

// Update location
app.post('/update-location', async (req, res) => {
  const { id, latitude, longitude } = req.body;

  if (!id || latitude == null || longitude == null) {
    return res.status(400).json({ success: false, message: 'Missing data' });
  }

  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ success: false, message: 'Invalid coordinates' });
  }

  const city = await getCityFromCoordinates(lat, lng);
  const employees = readEmployees();
  const existing = employees.find(emp => emp.id === id);

  const name = existing ? existing.name : "Unknown";
  const email = existing ? existing.email : "unknown@company.com";

  const updated = {
    id,
    name,
    email,
    latitude: lat.toString(),
    longitude: lng.toString(),
    city,
    lastSeen: new Date().toISOString()
  };

  const filtered = employees.filter(emp => emp.id !== id);
  const all = [...filtered, updated];
  const success = writeEmployees(all);

  if (success) {
    console.log(`📍 Updated location for ${id}: ${lat}, ${lng} → ${city}`);
    res.json({ success: true, city });
  } else {
    res.status(500).json({ success: false, message: 'Failed to update location' });
  }
});

// Stop sharing
app.post('/stop-sharing', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: 'ID required' });

  const employees = readEmployees();
  const emp = employees.find(e => e.id === id);
  if (!emp) return res.json({ success: true });

  emp.latitude = '';
  emp.longitude = '';
  emp.city = 'Unknown';
  emp.lastSeen = '';

  const success = writeEmployees(employees);
  if (success) {
    console.log(`🛑 Cleared location for ${id}`);
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, message: 'Write failed' });
  }
});

// Check if ID exists
app.get('/employee-exists/:id', (req, res) => {
  const { id } = req.params;
  const exists = readEmployees().some(emp => emp.id === id);
  res.json({ exists });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`📄 employees.csv: ${fs.existsSync(EMPLOYEES_CSV) ? 'OK' : 'MISSING!'}`);
  console.log(`🔑 password.txt: ${fs.existsSync(PASSWORD_FILE) ? 'OK' : 'MISSING!'}`);
});
