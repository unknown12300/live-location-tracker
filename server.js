// ✅ Simplified and Cleaned server.js for Employee Location Tracker
const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EMPLOYEES_CSV = path.join(DATA_DIR, 'employees.csv');
const PASSWORD_FILE = path.join(DATA_DIR, 'password.txt');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EMPLOYEES_CSV)) fs.writeFileSync(EMPLOYEES_CSV, 'id,name,email,latitude,longitude,city,lastSeen\n');

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' }
}));

app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

function readEmployees() {
  if (!fs.existsSync(EMPLOYEES_CSV)) return [];
  const data = fs.readFileSync(EMPLOYEES_CSV, 'utf-8');
  return data.trim().split('\n').slice(1).map(line => {
    const [id, name, email, lat, lng, city, lastSeen] = line.split(',');
    return { id, name, email, latitude: lat, longitude: lng, city, lastSeen };
  });
}

function writeEmployees(employees) {
  const lines = ['id,name,email,latitude,longitude,city,lastSeen'];
  employees.forEach(e => lines.push([e.id, e.name, e.email, e.latitude, e.longitude, e.city, e.lastSeen].join(',')));
  fs.writeFileSync(EMPLOYEES_CSV, lines.join('\n') + '\n');
}

// Routes
app.get('/', (req, res) => req.session.loggedIn ? res.redirect('/manager') : res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const [user, pass] = fs.readFileSync(PASSWORD_FILE, 'utf-8').trim().split(':');
  if (username === user && password === pass) {
    req.session.loggedIn = true;
    return res.redirect('/manager');
  }
  res.send('<p>Invalid login. <a href="/">Try again</a></p>');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/manager', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

app.get('/employees', (req, res) => res.json(readEmployees()));

app.post('/update-location', (req, res) => {
  const { id, latitude, longitude } = req.body;
  const employees = readEmployees();
  const index = employees.findIndex(e => e.id === id);
  if (index !== -1) {
    employees[index].latitude = latitude;
    employees[index].longitude = longitude;
    employees[index].lastSeen = new Date().toISOString();
    writeEmployees(employees);
    return res.json({ success: true });
  }
  res.status(404).json({ success: false, message: 'Employee not found' });
});

app.post('/stop-sharing', (req, res) => {
  const { id } = req.body;
  const employees = readEmployees();
  const index = employees.findIndex(e => e.id === id);
  if (index !== -1) {
    employees[index].latitude = '';
    employees[index].longitude = '';
    employees[index].lastSeen = '';
    writeEmployees(employees);
  }
  res.json({ success: true });
});

app.get('/employee-exists/:id', (req, res) => {
  const exists = readEmployees().some(e => e.id === req.params.id);
  res.json({ exists });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at port ${PORT}`);
});
