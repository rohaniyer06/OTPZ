// build.js
const fs = require('fs-extra');
const path = require('path');

// Ensure dist directory exists
const distDir = path.join(__dirname, 'dist');
fs.ensureDirSync(distDir);

// Files and directories to copy
const filesToCopy = [
  'manifest.json',
  'background/',
  'content/',
  'popup/',
  'services/'
];

// Copy each file/directory
filesToCopy.forEach(item => {
  const src = path.join(__dirname, item);
  const dest = path.join(distDir, item);
  
  if (fs.lstatSync(src).isDirectory()) {
    fs.copySync(src, dest, { overwrite: true });
  } else {
    fs.copyFileSync(src, dest);
  }
});

console.log('Build complete! Output in /dist');
