const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/songs', express.static(path.join(__dirname, 'songs')));

app.get('/api/songs', (req, res) => {
  const songsDir = path.join(__dirname, 'songs');
  fs.readdir(songsDir, (err, files) => {
    if (err) {
      return res.json([]);
    }
    const mp3s = files.filter(f => f.toLowerCase().endsWith('.mp3'));
    res.json(mp3s);
  });
});

// ── BPM detection endpoint ──────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, 'bpm_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

app.get('/api/bpm/:filename', (req, res) => {
  const filename = req.params.filename;

  // Path traversal protection: reject anything with slashes, backslashes, or ..
  if (/[/\\]/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const songPath = path.join(__dirname, 'songs', filename);
  if (!fs.existsSync(songPath)) {
    return res.status(404).json({ error: 'Song not found' });
  }

  // Check cache
  const cacheFile = path.join(CACHE_DIR, filename + '.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      return res.json(cached);
    } catch (_) {
      // Corrupted cache, re-analyze
    }
  }

  const scriptPath = path.join(__dirname, 'detect_bpm.py');
  const pythonPath = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  execFile(pythonPath, [scriptPath, songPath], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('BPM detection error:', err.message);
      if (stderr) console.error('stderr:', stderr);
      return res.status(500).json({ error: 'BPM detection failed' });
    }

    try {
      const result = JSON.parse(stdout);
      if (result.error) {
        return res.status(500).json(result);
      }
      // Write cache
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      res.json(result);
    } catch (parseErr) {
      console.error('Failed to parse BPM output:', stdout);
      res.status(500).json({ error: 'Invalid BPM detection output' });
    }
  });
});

app.listen(PORT, () => {
  console.log(`SAMPEL running at http://localhost:${PORT}`);
});
