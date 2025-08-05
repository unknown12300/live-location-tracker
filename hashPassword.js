// hashPassword.js
const bcrypt = require('bcrypt');

// IMPORTANT: Change this to YOUR actual manager password
const plainTextPassword = 'your_actual_manager_password_here';

bcrypt.hash(plainTextPassword, 10, (err, hash) => {
  if (err) {
    console.error('Error hashing password:', err);
  } else {
    console.log('Hashed password (put this in password.txt):');
    // This output line (e.g., manager:$2b$10$...) goes into your password.txt file
    console.log(`manager:${hash}`);
  }
});
