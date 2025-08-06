// server.js - Employee Location Tracker (Render-Ready)
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const app = express();
const PORT = process.env.PORT || 3000;

// --- Use persistent disk on Render ---
const DATA_DIR = process.env.DATA_DIR || '/var/data';
const EMPLOYEES_CSV = path.join(DATA_DIR, 'employees.csv');
const PASSWORD_FILE = path.join(DATA_DIR, 'password.txt');

// 🔴 DO NOT try to create /var/data — it's pre-mounted by Render
// If it's /var/data, assume it exists. Only create local dir if dev.
if (DATA_DIR === '/var/data') {
  console.log('📁 Using persistent disk at /var/data (Render)');
} else {
  // Local development: create ./data if needed
  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log(`📁 Created local data directory: ${DATA_DIR}`);
    } catch (err) {
      console.error('🔴 Failed to create local data directory:', err);
      process.exit(1);
    }
  }
}

// Create employees.csv if it doesn't exist
if (!fs.existsSync(EMPLOYEES_CSV)) {
  try {
    fs.writeFileSync(EMPLOYEES_CSV, 'id,name,email,latitude,longitude,city,lastSeen\n');
    console.log('📄 Created employees.csv');
  } catch (err) {
    console.error('🔴 Failed to create employees.csv:', err);
  }
}

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Trust proxy (for HTTPS detection on Render)
app.set('trust proxy', 1);

// Session setup
const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secure-random-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: isProduction,        // Only send over HTTPS in production
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
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

    if (data?.address) {
      city =
        data.address.city ||
        data.address.town ||
        data.address.village ||
        data.address.hamlet ||
        data.address.county ||
        data.address.state ||
        data.address.country ||
        `Near ${data.display_name?.split(',')[0] || 'Unknown Location'}`;
    }

    cityCache[key] = { city, timestamp: now };
    return city;
  } catch (err) {
    console.error("📍 Reverse geocoding failed:", err.message);
    cityCache[key] = { city: 'Unknown', timestamp: now };
    return 'Unknown';
  }
}

// Read employees from CSV (robust line ending support)
function readEmployees() {
  try {
    if (!fs.existsSync(EMPLOYEES_CSV)) return [];
    const data = fs.readFileSync(EMPLOYEES_CSV, 'utf-8');
    if (!data.trim()) return [];

    return data
      .trim()
      .split(/\r?\n/) // ✅ Handles \n, \r\n, \r
      .slice(1)
      .map(line => {
        if (!line.trim()) return null;
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
        `"${(emp.name || '').replace(/"/g, '""')}"`,
        `"${(emp.email || '').replace(/"/g, '""')}"`,
        emp.latitude || '',
        emp.longitude || '',
        `"${(emp.city || 'Unknown').replace(/"/g, '""')}"`,
        emp.lastSeen || ''
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
  if (req.session?.loggedIn) return res.redirect('/manager');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Handle login
app.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).send('Username and password required');
  }

  try {
    if (!fs.existsSync(PASSWORD_FILE)) {
      console.error("🔴 password.txt missing! Create via Render Secret File.");
      return res.status(500).send("Server not configured");
    }

    const auth = fs.readFileSync(PASSWORD_FILE, 'utf-8').trim();
    const [user, pass] = auth.split(':').map(s => s.trim());

    if (!user || !pass) {
      console.error("🔴 Invalid password.txt format. Expected: user:pass");
      return res.status(500).send("Server config error");
    }

    if (username === user && password === pass) {
      req.session.loggedIn = true;
      console.log(`✅ Manager login successful`);
      return res.redirect('/manager');
    }

    console.log(`❌ Failed login attempt: ${username}`);
    return res.send('<p>❌ Invalid credentials. <a href="/">Try again</a></p>');
  } catch (err) {
    console.error("🔴 Login error:", err);
    return res.status(500).send("Server error");
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error("Session destroy error:", err);
  });
  res.redirect('/');
});

// Protected manager dashboard
app.get('/manager', (req, res) => {
  if (!req.session?.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

// --- REMOVED: Create employee route ---
// app.post('/create-employee', (req, res) => { ... });
// This route is no longer needed since employees are pre-loaded from CSV.

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

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ success: false, message: 'Invalid coordinates' });
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ success: false, message: 'Coordinates out of range' });
  }

  // Check if the ID exists in the pre-loaded list
  const employees = readEmployees();
  const existingEmployee = employees.find(emp => emp.id === id);

  // If the ID is not found in the CSV, reject the update
  if (!existingEmployee) {
    console.log(`❌ Update failed: ID ${id} not found in employees.csv`);
    return res.status(404).json({ success: false, message: 'Employee ID not found. Please contact manager.' });
  }

  const city = await getCityFromCoordinates(lat, lng);

  // Update the existing employee's data
  const name = existingEmployee.name;
  const email = existingEmployee.email;

  const updated = {
    id,
    name,
    email,
    latitude: lat.toString(),
    longitude: lng.toString(),
    city,
    lastSeen: new Date().toISOString()
  };

  // Filter out the old record and add the updated one
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
  const sanitizedId = id.trim();
  const exists = readEmployees().some(emp => emp.id === sanitizedId);
  res.json({ exists });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`📄 employees.csv: ${fs.existsSync(EMPLOYEES_CSV) ? 'OK' : 'MISSING!'}`);
  console.log(`🔑 password.txt: ${fs.existsSync(PASSWORD_FILE) ? 'OK' : 'MISSING!'}`);
  if (isProduction) {
    console.warn('\n💡 Access your app via HTTPS:');
    console.warn('👉 https://yourapp.onrender.com');
    console.warn('🚨 Geolocation requires HTTPS!');
    console.warn('🔐 Ensure SESSION_SECRET is set!\n');
  }
});
