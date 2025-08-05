// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 10000; // Use Render's default port if not set

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
    // Depending on permissions/environment, app might need to handle this gracefully or fail
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
  secret: process.env.SESSION_SECRET || 'your-VERY-SECURE-random-secret-change-in-prod', // CHANGE IN PROD
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

// --- In-memory cache for reverse geocoding ---
const cityCache = {};
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

function getCacheKey(lat, lng) {
  // Round to ~1km precision for better cache hit rate
  return `${Math.round(lat * 10) / 10},${Math.round(lng * 10) / 10}`;
}

async function getCityFromCoordinates(lat, lng) {
  const key = getCacheKey(lat, lng);
  const now = Date.now();

  // Check cache first
  if (cityCache[key] && now - cityCache[key].timestamp < CACHE_TTL) {
    console.log(`🌍 Used cached city for ${key}: ${cityCache[key].city}`);
    return cityCache[key].city;
  }

  try {
    // Ensure lat/lng are numbers before sending
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${parseFloat(lat)}&lon=${parseFloat(lng)}&zoom=10`,
      {
        headers: {
          'User-Agent': 'EmployeeTracker/1.0 (contact@yourcompany.com)' // Required by Nominatim TOS
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
      // Prioritize common city/town names
      city =
        data.address.city ||
        data.address.town ||
        data.address.village ||
        data.address.hamlet ||
        data.address.county ||
        data.address.state ||
        data.address.country ||
        `Near ${data.display_name.split(',')[0]}`; // Fallback to region name
    }

    // Save in cache
    cityCache[key] = { city, timestamp: now };
    console.log(`🌍 Fetched and cached city for ${key}: ${city}`);
    return city;
  } catch (err) {
    console.error("📍 Reverse geocoding failed:", err.message);
    // Cache 'Unknown' temporarily to avoid repeated failing requests
    cityCache[key] = { city: 'Unknown', timestamp: now };
    return 'Unknown';
  }
}

// --- Read/Write employees from CSV ---
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
      .slice(1) // Skip header
      .map(line => {
        const parts = line.split(',');
        if (parts.length < 7) {
          console.warn(`⚠️ Skipping malformed line in CSV: ${line}`);
          return null;
        }

        // Handle quoted fields (basic CSV-safe parsing)
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
      .filter(Boolean); // Remove nulls
  } catch (err) {
    console.error("🔴 Error reading employees.csv:", err);
    return [];
  }
}

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

// --- Routes ---

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

// Login page
app.get('/', (req, res) => {
  if (req.session?.loggedIn) {
    return res.redirect('/manager');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html')); // Serve index.html (login page)
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
      // Redirect with error flag for client-side display (matches index.html expectation)
      return res.redirect('/?error=1');
    }

  } catch (err) {
    console.error("🔐 Plain text login error:", err);
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
// Assumes manager.html has been moved to views/ folder
app.get('/manager', (req, res) => {
  if (!req.session?.loggedIn) {
    console.log("Unauthorized access attempt to /manager");
    return res.redirect('/'); // Redirect unauthenticated users
  }
  res.sendFile(path.join(__dirname, 'views', 'manager.html')); // Serve from views/
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

  // First Come, First Served: Check if ID already exists
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

// Get all employees (for manager dashboard)
app.get('/employees', (req, res) => {
  const employees = readEmployees();
  console.log(`📤 Sent ${employees.length} employees to manager`);
  res.json(employees);
});

// Update location (with stricter First Come, First Serve)
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
    const employees = readEmployees();
    const existingEmployeeIndex = employees.findIndex(emp => emp.id === id);

    if (existingEmployeeIndex === -1) {
       console.log(`ℹ️ Employee ID ${id} not found, cannot update location.`);
       // Optionally reject if employee must exist first, or create a minimal entry
       // For now, let's assume employee must exist. Reject.
       return res.status(404).json({ success: false, message: 'Employee ID not found. Please contact manager.' });
    }

    const existingEmployee = employees[existingEmployeeIndex];

    // --- NEW: Strict First Come, First Serve Check ---
    const TEN_MINUTES = 10 * 60 * 1000; // 10 minutes in milliseconds
    const now = Date.now();

    // Check if lastSeen exists and is recent, and if latitude/longitude were previously set
    if (existingEmployee.lastSeen &&
        existingEmployee.latitude &&
        existingEmployee.longitude) {

        const lastSeenTime = new Date(existingEmployee.lastSeen).getTime();
        // Ensure lastSeenTime is a valid number
        if (!isNaN(lastSeenTime) && (now - lastSeenTime) < TEN_MINUTES) {
            // Likely already actively shared by another user/session
            console.log(`⚠️  ID ${id} appears to be actively shared by another user (last seen ${new Date(lastSeenTime).toISOString()}). Rejecting update.`);
            return res.status(409).json({ // 409 Conflict
                success: false,
                message: 'Location for this ID is already being shared by another user.'
            });
        }
    }
    // --- END NEW CHECK ---

    // If check passes, proceed with geocoding and updating
    console.log(`📍 Getting city for ${id} at ${lat}, ${lng}...`);
    const city = await getCityFromCoordinates(lat, lng);

    // Update existing employee data
    employees[existingEmployeeIndex].latitude = lat.toString();
    employees[existingEmployeeIndex].longitude = lng.toString();
    employees[existingEmployeeIndex].city = city;
    employees[existingEmployeeIndex].lastSeen = new Date().toISOString(); // Update timestamp

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

// Check if ID exists (for employee.html verification)
app.get('/employee-exists/:id', (req, res) => {
  const { id } = req.params;
  // Sanitize input if needed, though path params are generally safer
  const employees = readEmployees();
  const exists = employees.some(emp => emp.id === id);
  res.json({ exists });
});

// Start server - Bind to 0.0.0.0 for Render compatibility
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
  console.log(`📁 Data directory configured: ${DATA_DIR}`);
  console.log(`📄 employees.csv check: ${fs.existsSync(EMPLOYEES_CSV) ? 'OK' : 'MISSING (will be created)'} `);
  console.log(`🔑 password.txt check: ${fs.existsSync(PASSWORD_FILE) ? 'OK' : 'MISSING (create it with format username:password)'} `);
  console.log("⚠️  WARNING: Using PLAIN TEXT password comparison. This is insecure.");
});
