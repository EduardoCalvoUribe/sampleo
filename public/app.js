// ── State ───────────────────────────────────────────────────────────
const STATE = {
  audioContext: null,
  originalBuffer: null,

  detectedBPM: 0,          // analyzed BPM (for info + playbackRate baseline)
  gridBPM: 0,              // NEW: bpm used for beatgrid (overridable). 0 => fallback to detected
  targetBPM: 120,          // playback target BPM (time-stretch)

  beatDuration: 0,         // seconds per beat at GRID bpm
  firstBeatTime: 0,        // seconds offset to first beat (phase) (auto-detected)
  totalBeats: 0,

  chunks: [],              // 16 objects: {beatIndex, lengthInBeats}
  selectedChunkIndex: 0,
  activeSources: new Map(), // chunkIndex -> AudioBufferSourceNode

  // global beatgrid offset (ms)
  gridOffsetMs: 0
};

const KEYS_ROW1 = ['Q','W','E','R','T','Y','U','I'];
const KEYS_ROW2 = ['A','S','D','F','G','H','J','K'];
const KEY_MAP = {};                       // key letter -> chunk index
KEYS_ROW1.forEach((k, i) => KEY_MAP[k] = i);
KEYS_ROW2.forEach((k, i) => KEY_MAP[k] = i + 8);

// ── DOM refs ────────────────────────────────────────────────────────
const loadBtn          = document.getElementById('load-btn');
const songName         = document.getElementById('song-name');
const bpmDisplay       = document.getElementById('bpm-display');
const loadingEl        = document.getElementById('loading');

const targetBpmInput   = document.getElementById('target-bpm');

// NEW: beatgrid BPM override input
const gridBpmInput     = document.getElementById('grid-bpm');

const padGrid          = document.getElementById('pad-grid');
const chunkDetail      = document.getElementById('chunk-detail');
const chunkLabel       = document.getElementById('chunk-label');
const chunkKey         = document.getElementById('chunk-key');
const chunkStart       = document.getElementById('chunk-start');
const lengthSlider     = document.getElementById('length-slider');
const lengthValue      = document.getElementById('length-value');
const waveformCanvas   = document.getElementById('waveform');
const downloadChunkBtn = document.getElementById('download-chunk-btn');
const downloadAllBtn   = document.getElementById('download-all-btn');
const rerandomizeBtn   = document.getElementById('rerandomize-btn');

// beatgrid offset UI
const offsetSlider     = document.getElementById('offset-slider');
const offsetValue      = document.getElementById('offset-value');

// ── Build pad grid ──────────────────────────────────────────────────
const padEls = [];
const allKeys = [...KEYS_ROW1, ...KEYS_ROW2];
for (let i = 0; i < 16; i++) {
  const pad = document.createElement('div');
  pad.className = 'pad';
  pad.innerHTML = `<span class="pad-key">${allKeys[i]}</span><span class="pad-num">${i + 1}</span>`;
  pad.addEventListener('mousedown', () => triggerPad(i));
  padGrid.appendChild(pad);
  padEls.push(pad);
}

// ── Keyboard ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.target === targetBpmInput) return;
  if (e.target === gridBpmInput) return;
  if (e.target === offsetSlider) return;

  const idx = KEY_MAP[e.key.toUpperCase()];
  if (idx !== undefined && STATE.originalBuffer) {
    e.preventDefault();
    triggerPad(idx);
  }
});

// ── Events ──────────────────────────────────────────────────────────
loadBtn.addEventListener('click', loadRandomSong);

targetBpmInput.addEventListener('change', () => {
  STATE.targetBPM = parseFloat(targetBpmInput.value) || STATE.detectedBPM || 120;
});

// NEW: grid bpm override
if (gridBpmInput) {
  gridBpmInput.addEventListener('change', () => {
    const val = parseFloat(gridBpmInput.value);
    // If invalid/empty -> fallback to detected BPM
    STATE.gridBPM = Number.isFinite(val) && val > 0 ? val : 0;

    updateBeatDurationFromGrid();
    recomputeTotalBeats();
    clampChunksToTotalBeats();

    if (STATE.originalBuffer) {
      selectChunk(STATE.selectedChunkIndex);
    }
  });
}

lengthSlider.addEventListener('input', () => {
  const c = STATE.chunks[STATE.selectedChunkIndex];
  if (!c) return;
  c.lengthInBeats = parseInt(lengthSlider.value);
  lengthValue.textContent = c.lengthInBeats;
  drawWaveform();
});

downloadChunkBtn.addEventListener('click', () => downloadChunk(STATE.selectedChunkIndex));
downloadAllBtn.addEventListener('click', downloadAllChunks);
rerandomizeBtn.addEventListener('click', rerandomize);

// beatgrid offset slider (ms)
if (offsetSlider) {
  STATE.gridOffsetMs = parseInt(offsetSlider.value, 10) || 0;
  if (offsetValue) offsetValue.textContent = `${STATE.gridOffsetMs} ms`;

  offsetSlider.addEventListener('input', () => {
    STATE.gridOffsetMs = parseInt(offsetSlider.value, 10) || 0;
    if (offsetValue) offsetValue.textContent = `${STATE.gridOffsetMs} ms`;

    recomputeTotalBeats();
    clampChunksToTotalBeats();

    if (STATE.originalBuffer) {
      selectChunk(STATE.selectedChunkIndex);
    }
  });
}

// ── Song loading ────────────────────────────────────────────────────
async function loadRandomSong() {
  ensureAudioContext();
  loadingEl.classList.remove('hidden');
  loadBtn.disabled = true;

  try {
    const res = await fetch('/api/songs');
    const songs = await res.json();
    if (!songs.length) {
      songName.textContent = 'No MP3s in /songs folder';
      return;
    }

    const file = songs[Math.floor(Math.random() * songs.length)];
    songName.textContent = file;

    const audioRes = await fetch('/songs/' + encodeURIComponent(file));
    const arrayBuf = await audioRes.arrayBuffer();
    STATE.originalBuffer = await STATE.audioContext.decodeAudioData(arrayBuf);

    const bpmResult = await fetchBPM(file, STATE.originalBuffer);
    STATE.detectedBPM = bpmResult.bpm;
    STATE.firstBeatTime = bpmResult.firstBeatTime;

    // Show analyzed BPM, but keep grid bpm separate
    bpmDisplay.textContent = `${STATE.detectedBPM} BPM (analyzed)`;

    // Defaults:
    STATE.targetBPM = STATE.detectedBPM;
    targetBpmInput.value = STATE.detectedBPM;

    // Default grid BPM to analyzed BPM (user can override)
    STATE.gridBPM = STATE.detectedBPM;
    if (gridBpmInput) gridBpmInput.value = STATE.gridBPM;

    updateBeatDurationFromGrid();
    recomputeTotalBeats();

    initChunks();
    selectChunk(0);
  } catch (err) {
    songName.textContent = 'Error: ' + err.message;
    console.error(err);
  } finally {
    loadingEl.classList.add('hidden');
    loadBtn.disabled = false;
  }
}

function ensureAudioContext() {
  if (!STATE.audioContext) {
    STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
}

// ── Beatgrid helpers ────────────────────────────────────────────────
function getGridBPM() {
  // If user cleared/invalid, fallback to detected
  return (STATE.gridBPM && STATE.gridBPM > 0) ? STATE.gridBPM : (STATE.detectedBPM || 120);
}

function updateBeatDurationFromGrid() {
  const bpm = getGridBPM();
  STATE.beatDuration = 60 / bpm;
}

// effective first beat after applying ms offset
function getEffectiveFirstBeatTime() {
  // positive offset => move grid forward in time (later)
  // negative offset => move grid backward in time (earlier)
  return STATE.firstBeatTime + (STATE.gridOffsetMs / 1000);
}

function recomputeTotalBeats() {
  if (!STATE.originalBuffer) {
    STATE.totalBeats = 0;
    return;
  }
  if (!STATE.beatDuration || !Number.isFinite(STATE.beatDuration)) {
    STATE.totalBeats = 0;
    return;
  }

  const effFirst = getEffectiveFirstBeatTime();
  const dur = STATE.originalBuffer.duration;

  if (effFirst >= dur) {
    STATE.totalBeats = 0;
    return;
  }

  const start = Math.max(0, effFirst);
  STATE.totalBeats = Math.floor((dur - start) / STATE.beatDuration);
}

function clampChunksToTotalBeats() {
  const maxStart = Math.max(0, STATE.totalBeats - 1);
  for (const c of STATE.chunks) {
    if (c.beatIndex > maxStart) c.beatIndex = maxStart;
    if (c.beatIndex < 0) c.beatIndex = 0;
  }
}

// ── Server-side BPM (with client-side fallback) ─────────────────────
async function fetchBPM(filename, audioBuffer) {
  try {
    bpmDisplay.textContent = 'Analyzing BPM...';
    const res = await fetch('/api/bpm/' + encodeURIComponent(filename));
    if (!res.ok) throw new Error('Server returned ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return { bpm: data.bpm, firstBeatTime: data.firstBeatTime };
  } catch (err) {
    console.warn('Server BPM detection failed, using client-side fallback:', err.message);
    return detectBPM(audioBuffer);
  }
}

// ── BPM detection (client-side fallback) ────────────────────────────
async function detectBPM(buffer) {
  const sampleRate = buffer.sampleRate;
  const len = buffer.length;

  // Create offline context, render through low-pass filter
  const offline = new OfflineAudioContext(1, len, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = buffer;

  const filter = offline.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 150;

  source.connect(filter);
  filter.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  const data = rendered.getChannelData(0);

  // Absolute values
  const abs = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) abs[i] = Math.abs(data[i]);

  // Find peaks at a good threshold
  let peaks = null;
  for (let thresh = 0.9; thresh >= 0.3; thresh -= 0.05) {
    const max = arrayMax(abs);
    const cutoff = max * thresh;
    const found = findPeaks(abs, cutoff, sampleRate);
    if (found.length >= 30 && found.length <= 200) {
      peaks = found;
      break;
    }
  }
  if (!peaks || peaks.length < 2) return { bpm: 120, firstBeatTime: 0 };

  // Count intervals between nearby peaks
  const intervalCounts = {};
  for (let i = 0; i < peaks.length; i++) {
    const limit = Math.min(peaks.length, i + 10);
    for (let j = i + 1; j < limit; j++) {
      const interval = peaks[j] - peaks[i];
      const bpm = 60 / (interval / sampleRate);
      const rounded = normalizeBPM(Math.round(bpm));
      if (rounded >= 60 && rounded <= 200) {
        intervalCounts[rounded] = (intervalCounts[rounded] || 0) + 1;
      }
    }
  }

  // Find most common BPM
  let bestBPM = 120;
  let bestCount = 0;
  for (const [bpm, count] of Object.entries(intervalCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestBPM = parseInt(bpm, 10);
    }
  }

  // Find first beat offset (phase alignment)
  const beatSamples = Math.floor((60 / bestBPM) * sampleRate);
  let bestOffset = peaks[0];
  let bestScore = -1;

  const candidateCount = Math.min(peaks.length, 10);
  for (let c = 0; c < candidateCount; c++) {
    const offset = peaks[c] % beatSamples;
    let score = 0;
    for (let i = 0; i < peaks.length; i++) {
      const distFromGrid = (peaks[i] - offset) % beatSamples;
      const tolerance = beatSamples * 0.15;
      if (distFromGrid < tolerance || distFromGrid > beatSamples - tolerance) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  return { bpm: bestBPM, firstBeatTime: bestOffset / sampleRate };
}

function findPeaks(data, threshold, sampleRate) {
  const minDist = Math.floor(sampleRate * 0.1);
  const peaks = [];
  let lastPeak = -minDist;
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= threshold && i - lastPeak >= minDist) {
      peaks.push(i);
      lastPeak = i;
    }
  }
  return peaks;
}

function normalizeBPM(bpm) {
  while (bpm < 85) bpm *= 2;
  while (bpm > 175) bpm /= 2;
  return Math.round(bpm);
}

function arrayMax(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > m) m = arr[i];
  }
  return m;
}

// ── Chunk management ────────────────────────────────────────────────
function initChunks() {
  recomputeTotalBeats();
  STATE.chunks = [];
  for (let i = 0; i < 16; i++) {
    STATE.chunks.push({
      beatIndex: Math.floor(Math.random() * Math.max(1, STATE.totalBeats - 4)),
      lengthInBeats: 1
    });
  }
}

function rerandomize() {
  if (!STATE.originalBuffer) return;
  initChunks();
  selectChunk(STATE.selectedChunkIndex);
}

// ── Beatgrid-sliced buffer (uses GRID bpm + detected firstBeatTime) ──
function getChunkBuffer(index) {
  const c = STATE.chunks[index];
  const buf = STATE.originalBuffer;
  const sampleRate = buf.sampleRate;

  // beat length uses GRID bpm
  const beatSamples = Math.floor(STATE.beatDuration * sampleRate);

  // start phase uses detected firstBeatTime + ms offset
  const effectiveFirstBeatTime = getEffectiveFirstBeatTime();
  const offsetSamples = Math.floor(effectiveFirstBeatTime * sampleRate);

  const startSampleRaw = offsetSamples + c.beatIndex * beatSamples;
  const lengthSamples = c.lengthInBeats * beatSamples;

  // clamp to avoid negative indexing
  const startSample = Math.max(0, startSampleRaw);
  const endSample = Math.min(startSample + lengthSamples, buf.length);
  const actualLen = endSample - startSample;

  if (actualLen <= 0) return null;

  const channels = buf.numberOfChannels;
  const out = STATE.audioContext.createBuffer(channels, actualLen, sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < actualLen; i++) {
      dst[i] = src[startSample + i];
    }
  }
  return out;
}

// ── Playback ────────────────────────────────────────────────────────
function triggerPad(index) {
  selectChunk(index);

  // Stop all currently playing sources (monophonic)
  for (const [idx, src] of STATE.activeSources) {
    src.onended = null;
    try { src.stop(); } catch (_) {}
    padEls[idx].classList.remove('active');
  }
  STATE.activeSources.clear();

  const chunkBuf = getChunkBuffer(index);
  if (!chunkBuf) return;

  const source = STATE.audioContext.createBufferSource();
  source.buffer = chunkBuf;

  // NOTE: playbackRate still uses analyzed BPM as the "true tempo" reference.
  // Beatgrid BPM only affects slicing/beat math.
  source.playbackRate.value = STATE.targetBPM / (STATE.detectedBPM || 120);

  source.connect(STATE.audioContext.destination);

  STATE.activeSources.set(index, source);
  padEls[index].classList.add('active');

  source.onended = () => {
    padEls[index].classList.remove('active');
    STATE.activeSources.delete(index);
  };

  source.start(0);
}

// ── Selection & detail panel ────────────────────────────────────────
function selectChunk(index) {
  STATE.selectedChunkIndex = index;
  padEls.forEach((p, i) => p.classList.toggle('selected', i === index));

  if (!STATE.chunks.length) return;

  chunkDetail.classList.remove('hidden');
  const c = STATE.chunks[index];
  chunkLabel.textContent = 'Chunk ' + (index + 1);
  chunkKey.textContent = 'Key: ' + allKeys[index];

  const gridBpm = getGridBPM();
  chunkStart.textContent = `Beat: ${c.beatIndex} (Grid: ${gridBpm} BPM, Offset: ${STATE.gridOffsetMs}ms)`;

  lengthSlider.value = c.lengthInBeats;
  lengthValue.textContent = c.lengthInBeats;
  drawWaveform();
}

// ── Waveform drawing ────────────────────────────────────────────────
function drawWaveform() {
  const ctx = waveformCanvas.getContext('2d');
  const w = waveformCanvas.width;
  const h = waveformCanvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, w, h);

  const chunkBuf = getChunkBuffer(STATE.selectedChunkIndex);
  if (!chunkBuf) return;

  const data = chunkBuf.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  const mid = h / 2;

  ctx.strokeStyle = '#e0a030';
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let col = 0; col < w; col++) {
    const start = col * step;
    const end = Math.min(start + step, data.length);
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      if (data[i] < min) min = data[i];
      if (data[i] > max) max = data[i];
    }
    const yMin = mid + min * mid;
    const yMax = mid + max * mid;
    ctx.moveTo(col, yMin);
    ctx.lineTo(col, yMax);
  }
  ctx.stroke();
}

// ── WAV encoding ────────────────────────────────────────────────────
function encodeWAV(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;

  const buf = new ArrayBuffer(bufferSize);
  const view = new DataView(buf);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return buf;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ── Downloads ───────────────────────────────────────────────────────
function downloadChunk(index) {
  const chunkBuf = getChunkBuffer(index);
  if (!chunkBuf) return;

  const wav = encodeWAV(chunkBuf);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `sampel_chunk_${index + 1}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadAllChunks() {
  for (let i = 0; i < 16; i++) {
    setTimeout(() => downloadChunk(i), i * 100);
  }
}