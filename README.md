# SAMPLEO

A browser-based audio sampler that chops songs into beat-aligned chunks you can play with your keyboard like an MPC.

## How It Works

1. Drop MP3 files into the `songs/` folder
2. Click **Load Random Song** — the app analyzes BPM and beat positions
3. The song is sliced into 16 random beat-aligned chunks mapped to keyboard keys
4. Play chunks with keys `Q W E R T Y U I` (pads 1-8) and `A S D F G H J K` (pads 9-16)
5. Arrange chunks on the sequencer timeline by dragging pads onto it
6. Download individual chunks or all 16 as WAV files

## Features

- **BPM Detection** — server-side via librosa, with a Web Audio API client-side fallback
- **Beatgrid Controls** — manual BPM override (double-click BPM display), offset slider for phase correction
- **Time-stretching** — set a target BPM to pitch-shift playback via `playbackRate`
- **Metronome** — built-in click track synced to target BPM
- **Quantized Triggering** — snap key presses to beat / half-beat / quarter-beat grid while the metronome runs
- **Sequencer** — drag-and-drop timeline (4/8/16/32 beats), reposition or right-click to remove notes
- **Waveform Preview** — canvas visualization of the selected chunk
- **Per-song Settings** — grid BPM, offset, and target BPM persisted in localStorage

## Setup

```bash
# Install Node dependencies
npm install

# Create Python venv and install librosa (for server-side BPM detection)
py -3.12 -m venv .venv
.venv/Scripts/pip install librosa numpy

# Add MP3 files
mkdir songs
# copy your .mp3 files into songs/

# Start the server
npm start
# → http://localhost:3000
```

BPM results are cached in `bpm_cache/` so analysis only runs once per file.

## Project Structure

```
server.js          Express server — static files + /api/songs + /api/bpm/:filename
detect_bpm.py      librosa-based BPM + first-beat detection (called by server)
public/
  index.html       Single-page UI
  app.js           All client logic (audio, pads, sequencer, waveform)
  style.css        Dark theme styling
songs/             Drop MP3s here (gitignored)
bpm_cache/         Auto-generated BPM analysis cache (gitignored)
```

## Requirements

- Node.js
- Python 3.10+ with librosa (optional — client-side fallback exists)
