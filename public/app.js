// ── State ───────────────────────────────────────────────────────────
const STATE = {
  audioContext: null,
  originalBuffer: null,
  detectedBPM: 0,
  targetBPM: 120,
  beatDuration: 0,       // seconds per beat at detected BPM
  firstBeatTime: 0,      // seconds offset to first beat (phase)
  totalBeats: 0,
  chunks: [],            // 16 objects: {beatIndex, lengthInBeats}
  selectedChunkIndex: 0,
  activeSources: new Map() // chunkIndex -> AudioBufferSourceNode
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
  const idx = KEY_MAP[e.key.toUpperCase()];
  if (idx !== undefined && STATE.originalBuffer) {
    e.preventDefault();
    triggerPad(idx);
  }
});

// ── Events ──────────────────────────────────────────────────────────
loadBtn.addEventListener('click', loadRandomSong);
targetBpmInput.addEventListener('change', () => {
  STATE.targetBPM = parseFloat(targetBpmInput.value) || STATE.detectedBPM;
});
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
    bpmDisplay.textContent = STATE.detectedBPM + ' BPM';
    STATE.targetBPM = STATE.detectedBPM;
    targetBpmInput.value = STATE.detectedBPM;

    STATE.beatDuration = 60 / STATE.detectedBPM;
    STATE.totalBeats = Math.floor(
      (STATE.originalBuffer.duration - STATE.firstBeatTime) / STATE.beatDuration
    );

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
  const duration = buffer.duration;
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
      bestBPM = parseInt(bpm);
    }
  }

  // Find the first beat offset (phase alignment)
  // Test which phase offset best aligns with the detected peaks
  const beatSamples = Math.floor((60 / bestBPM) * sampleRate);
  let bestOffset = peaks[0]; // default: first peak
  let bestScore = -1;

  // Test each early peak as a candidate first-beat position
  const candidateCount = Math.min(peaks.length, 10);
  for (let c = 0; c < candidateCount; c++) {
    const offset = peaks[c] % beatSamples; // phase within one beat period
    let score = 0;
    // Score: how many peaks fall close to a beat grid line with this offset
    for (let i = 0; i < peaks.length; i++) {
      const distFromGrid = (peaks[i] - offset) % beatSamples;
      // Allow 15% tolerance of a beat period
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

  const firstBeatTime = bestOffset / sampleRate;
  return { bpm: bestBPM, firstBeatTime };
}

function findPeaks(data, threshold, sampleRate) {
  const minDist = Math.floor(sampleRate * 0.1); // 100ms minimum between peaks
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

function getChunkBuffer(index) {
  const c = STATE.chunks[index];
  const buf = STATE.originalBuffer;
  const sampleRate = buf.sampleRate;
  const beatSamples = Math.floor(STATE.beatDuration * sampleRate);
  const offsetSamples = Math.floor(STATE.firstBeatTime * sampleRate);
  const startSample = offsetSamples + c.beatIndex * beatSamples;
  const lengthSamples = c.lengthInBeats * beatSamples;
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
  source.playbackRate.value = STATE.targetBPM / STATE.detectedBPM;
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
  chunkStart.textContent = 'Beat: ' + c.beatIndex;
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
  view.setUint32(16, 16, true);            // chunk size
  view.setUint16(20, 1, true);             // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);            // bits per sample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channel data
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
