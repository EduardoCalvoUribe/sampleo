// ── State ───────────────────────────────────────────────────────────
const STATE = {
  audioContext: null,
  originalBuffer: null,

  detectedBPM: 0,          // analyzed BPM (info)
  gridBPM: 0,              // beatgrid BPM override; 0 => use detectedBPM
  targetBPM: 120,          // playback target BPM (user control)

  beatDuration: 0,         // seconds per beat at GRID bpm
  firstBeatTime: 0,        // auto-detected phase start (seconds)
  totalBeats: 0,           // WHOLE beats available from effective first beat to end

  chunks: [],              // 16 objects: {beatIndex, lengthInBeats} beatIndex is integer beats
  selectedChunkIndex: 0,
  activeSources: new Map(), // chunkIndex -> AudioBufferSourceNode (currently playing)

  // global beatgrid offset (ms)
  gridOffsetMs: 0,

  // inline editing UI state
  isEditingBpm: false,

  // ── Metronome ──
  metronome: {
    isPlaying: false,
    startTime: 0,       // anchor time for beat grid
    nextTickTime: 0,    // scheduler cursor
    intervalId: null,
    lookahead: 0.12,    // seconds scheduled ahead
    intervalMs: 25,
    gainNode: null,
    volume: 0.35        // default metronome volume
  },

  // Quantization division for keypress triggers:
  // null = off, 1 = beat, 2 = half-beat, 4 = quarter-beat
  quantizeDiv: null,

  // Pending (queued) quantized trigger while something is playing
  pending: {
    source: null,
    index: null,
    startAt: null,
    uiTimeoutId: null
  }
};

const KEYS_ROW1 = ['Q','W','E','R','T','Y','U','I'];
const KEYS_ROW2 = ['A','S','D','F','G','H','J','K'];
const KEY_MAP = {};
KEYS_ROW1.forEach((k, i) => KEY_MAP[k] = i);
KEYS_ROW2.forEach((k, i) => KEY_MAP[k] = i + 8);

// Length options for the slider (beats)
const LENGTH_OPTIONS = [0.25, 0.5, 1, 2, 4, 8, 16];

// ── DOM refs ────────────────────────────────────────────────────────
const loadBtn          = document.getElementById('load-btn');
const songName         = document.getElementById('song-name');
const bpmDisplay       = document.getElementById('bpm-display');
const loadingEl        = document.getElementById('loading');

const targetBpmInput   = document.getElementById('target-bpm');

// Metronome / quant controls
const metroVolSlider   = document.getElementById('metro-vol');     // NEW
const metroToggleBtn   = document.getElementById('metro-toggle');
const quantBeatBtn     = document.getElementById('quant-beat');
const quantHalfBtn     = document.getElementById('quant-half');
const quantQuarterBtn  = document.getElementById('quant-quarter');

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
  pad.addEventListener('mousedown', () => triggerPad(i, { fromKeyboard: false }));
  padGrid.appendChild(pad);
  padEls.push(pad);
}

// ── Keyboard ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (STATE.isEditingBpm) return;
  if (e.target === targetBpmInput) return;
  if (e.target === offsetSlider) return;

  const idx = KEY_MAP[e.key.toUpperCase()];
  if (idx !== undefined && STATE.originalBuffer) {
    e.preventDefault();
    triggerPad(idx, { fromKeyboard: true });
  }
});

// ── Events ──────────────────────────────────────────────────────────
loadBtn.addEventListener('click', loadRandomSong);

targetBpmInput.addEventListener('change', () => {
  STATE.targetBPM = parseFloat(targetBpmInput.value) || getPlaybackBaseBPM();
});

configureLengthSlider();
lengthSlider.addEventListener('input', () => {
  const c = STATE.chunks[STATE.selectedChunkIndex];
  if (!c) return;

  const opt = LENGTH_OPTIONS[parseInt(lengthSlider.value, 10)] ?? 1;
  c.lengthInBeats = opt;

  lengthValue.textContent = formatBeats(opt);
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

    if (STATE.originalBuffer) selectChunk(STATE.selectedChunkIndex);
  });
}

// inline-edit BPM on double click
setupInlineBpmEditing();

// ── Metronome / Quantization UI wiring ──────────────────────────────
if (metroVolSlider) {
  metroVolSlider.value = String(STATE.metronome.volume);
  metroVolSlider.addEventListener('input', () => {
    const v = parseFloat(metroVolSlider.value);
    STATE.metronome.volume = Number.isFinite(v) ? v : STATE.metronome.volume;
    if (STATE.metronome.gainNode) {
      STATE.metronome.gainNode.gain.value = STATE.metronome.volume;
    }
  });
}

if (metroToggleBtn) {
  metroToggleBtn.addEventListener('click', () => {
    ensureAudioContext();
    if (STATE.audioContext.state === 'suspended') STATE.audioContext.resume();

    if (STATE.metronome.isPlaying) stopMetronome();
    else startMetronome();
    updateMetroUI();
    updateQuantUI();
  });
}

function setQuantizeDiv(divOrNull) {
  STATE.quantizeDiv = divOrNull;
  updateQuantUI();
}

if (quantBeatBtn) quantBeatBtn.addEventListener('click', () => setQuantizeDiv(STATE.quantizeDiv === 1 ? null : 1));
if (quantHalfBtn) quantHalfBtn.addEventListener('click', () => setQuantizeDiv(STATE.quantizeDiv === 2 ? null : 2));
if (quantQuarterBtn) quantQuarterBtn.addEventListener('click', () => setQuantizeDiv(STATE.quantizeDiv === 4 ? null : 4));

updateMetroUI();
updateQuantUI();

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

    // default: grid uses analyzed
    STATE.gridBPM = 0;

    // default: target bpm = analyzed baseline
    STATE.targetBPM = STATE.detectedBPM || 120;
    targetBpmInput.value = STATE.targetBPM;

    updateBeatDurationFromGrid();
    recomputeTotalBeats();

    renderBpmDisplay();

    initChunks();          // unique whole-beat starts
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
  // create metronome gain node once
  if (!STATE.metronome.gainNode) {
    STATE.metronome.gainNode = STATE.audioContext.createGain();
    STATE.metronome.gainNode.gain.value = STATE.metronome.volume;
    STATE.metronome.gainNode.connect(STATE.audioContext.destination);
  }
}

// ── Beatgrid & playback baseline helpers ────────────────────────────
function getGridBPM() {
  return (STATE.gridBPM && STATE.gridBPM > 0) ? STATE.gridBPM : (STATE.detectedBPM || 120);
}

// playback baseline follows grid override if set, else analyzed
function getPlaybackBaseBPM() {
  return (STATE.gridBPM && STATE.gridBPM > 0) ? STATE.gridBPM : (STATE.detectedBPM || 120);
}

function updateBeatDurationFromGrid() {
  const bpm = getGridBPM();
  STATE.beatDuration = 60 / bpm;
}

function getEffectiveFirstBeatTime() {
  return STATE.firstBeatTime + (STATE.gridOffsetMs / 1000);
}

function recomputeTotalBeats() {
  if (!STATE.originalBuffer || !STATE.beatDuration || !Number.isFinite(STATE.beatDuration)) {
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
  const beatsFloat = (dur - start) / STATE.beatDuration;

  // Whole-beat start markers only
  STATE.totalBeats = Math.max(0, Math.floor(beatsFloat));
}

function clampChunksToTotalBeats() {
  const maxStart = Math.max(0, STATE.totalBeats);
  for (const c of STATE.chunks) {
    if (c.beatIndex > maxStart) c.beatIndex = maxStart;
    if (c.beatIndex < 0) c.beatIndex = 0;
  }
}

// ── BPM display rendering ────────────────────────────────────────────
function renderBpmDisplay() {
  if (!bpmDisplay) return;

  const analyzed = STATE.detectedBPM ? `${STATE.detectedBPM} BPM` : `-- BPM`;
  const gridBpm = getGridBPM();

  if (STATE.detectedBPM && STATE.gridBPM && STATE.gridBPM > 0) {
    bpmDisplay.textContent = `${analyzed} (grid: ${gridBpm})`;
  } else if (STATE.detectedBPM) {
    bpmDisplay.textContent = `${analyzed} (analyzed)`;
  } else {
    bpmDisplay.textContent = analyzed;
  }
}

// ── Inline BPM editing (beatgrid BPM override) ──────────────────────
function setupInlineBpmEditing() {
  if (!bpmDisplay) return;

  bpmDisplay.title = 'Double-click to edit beatgrid BPM';

  bpmDisplay.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (!STATE.detectedBPM) return;
    if (STATE.isEditingBpm) return;
    startBpmEdit();
  });
}

function startBpmEdit() {
  STATE.isEditingBpm = true;

  const currentGrid = getGridBPM();

  const input = document.createElement('input');
  input.type = 'number';
  input.min = '30';
  input.max = '300';
  input.step = '0.1';
  input.value = String(currentGrid);

  input.style.width = '110px';
  input.style.fontSize = 'inherit';
  input.style.fontFamily = 'inherit';
  input.style.padding = '2px 6px';

  const prevText = bpmDisplay.textContent;
  bpmDisplay.textContent = '';
  bpmDisplay.appendChild(input);

  input.focus();
  input.select();

  const finish = (apply) => {
    if (!STATE.isEditingBpm) return;
    STATE.isEditingBpm = false;

    if (!apply) {
      bpmDisplay.textContent = prevText;
      return;
    }

    const val = parseFloat(input.value);

    if (!Number.isFinite(val) || val <= 0) {
      // clear override
      STATE.gridBPM = 0;
      STATE.targetBPM = getPlaybackBaseBPM();
      targetBpmInput.value = STATE.targetBPM;
    } else {
      // set override
      STATE.gridBPM = val;
      // snap target bpm to new baseline
      STATE.targetBPM = val;
      targetBpmInput.value = val;
    }

    updateBeatDurationFromGrid();
    recomputeTotalBeats();
    clampChunksToTotalBeats();

    if (STATE.originalBuffer) selectChunk(STATE.selectedChunkIndex);
    renderBpmDisplay();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });

  input.addEventListener('blur', () => finish(true));
}

// ── Metronome implementation ────────────────────────────────────────
function getTargetBeatDuration() {
  const bpm = (STATE.targetBPM && STATE.targetBPM > 0) ? STATE.targetBPM : 120;
  return 60 / bpm;
}

function startMetronome() {
  ensureAudioContext();
  if (STATE.metronome.isPlaying) return;

  const now = STATE.audioContext.currentTime;

  // start slightly in the future
  STATE.metronome.startTime = now + 0.05;
  STATE.metronome.nextTickTime = STATE.metronome.startTime;
  STATE.metronome.isPlaying = true;

  STATE.metronome.intervalId = setInterval(metronomeScheduler, STATE.metronome.intervalMs);
}

function stopMetronome() {
  if (!STATE.metronome.isPlaying) return;

  STATE.metronome.isPlaying = false;
  if (STATE.metronome.intervalId) {
    clearInterval(STATE.metronome.intervalId);
    STATE.metronome.intervalId = null;
  }
}

function metronomeScheduler() {
  if (!STATE.metronome.isPlaying || !STATE.audioContext) return;

  const now = STATE.audioContext.currentTime;
  const ahead = now + STATE.metronome.lookahead;

  while (STATE.metronome.nextTickTime < ahead) {
    scheduleClick(STATE.metronome.nextTickTime);
    STATE.metronome.nextTickTime += getTargetBeatDuration(); // follows TARGET BPM live
  }
}

function scheduleClick(time) {
  const ctx = STATE.audioContext;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'square';
  osc.frequency.value = 1000;

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.35, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);

  osc.connect(gain);
  gain.connect(STATE.metronome.gainNode); // volume slider controls this node

  osc.start(time);
  osc.stop(time + 0.04);
}

function updateMetroUI() {
  if (!metroToggleBtn) return;
  metroToggleBtn.textContent = STATE.metronome.isPlaying ? '⏸' : '▶';
  metroToggleBtn.title = STATE.metronome.isPlaying ? 'Pause metronome' : 'Play metronome';
  metroToggleBtn.style.opacity = STATE.metronome.isPlaying ? '1' : '0.85';
}

function updateQuantUI() {
  const setBtn = (btn, active) => {
    if (!btn) return;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.style.opacity = active ? '1' : '0.75';
    btn.style.transform = active ? 'translateY(1px)' : 'none';
    btn.style.filter = active ? 'brightness(1.15)' : 'none';
  };

  setBtn(quantBeatBtn, STATE.quantizeDiv === 1);
  setBtn(quantHalfBtn, STATE.quantizeDiv === 2);
  setBtn(quantQuarterBtn, STATE.quantizeDiv === 4);

  const enabled = STATE.metronome.isPlaying;
  [quantBeatBtn, quantHalfBtn, quantQuarterBtn].forEach((b) => {
    if (!b) return;
    b.title = enabled ? 'Quantize key presses' : 'Quantize applies only while metronome is playing';
  });
}

// Quantize a time to nearest grid (then nudge to next if it would be in the past)
function getQuantizedTime(now, div) {
  const base = STATE.metronome.startTime;
  const beatDur = getTargetBeatDuration();
  const step = beatDur / div;

  const rel = now - base;
  const n = Math.round(rel / step);
  let t = base + n * step;

  const minLead = 0.006;
  if (t < now + minLead) t += step;

  return t;
}

// ── Chunk management ────────────────────────────────────────────────
function initChunks() {
  recomputeTotalBeats();
  STATE.chunks = [];

  const defaultLen = 1; // default is still 1 beat
  const used = new Set();
  const maxStart = Math.max(0, STATE.totalBeats);

  const MAX_ATTEMPTS = 10000;
  let attempts = 0;

  while (STATE.chunks.length < 16 && attempts < MAX_ATTEMPTS) {
    attempts++;
    const candidate = Math.floor(Math.random() * Math.max(1, maxStart + 1));
    if (used.has(candidate)) continue;
    used.add(candidate);
    STATE.chunks.push({ beatIndex: candidate, lengthInBeats: defaultLen });
  }

  while (STATE.chunks.length < 16) {
    const candidate = Math.floor(Math.random() * Math.max(1, maxStart + 1));
    STATE.chunks.push({ beatIndex: candidate, lengthInBeats: defaultLen });
  }

  setLengthSliderFromBeats(defaultLen);
}

function rerandomize() {
  if (!STATE.originalBuffer) return;
  initChunks();
  selectChunk(STATE.selectedChunkIndex);
}

// ── Beatgrid-sliced buffer (whole-beat starts; fractional lengths OK) ─
function getChunkBuffer(index) {
  const c = STATE.chunks[index];
  const buf = STATE.originalBuffer;
  const sampleRate = buf.sampleRate;

  const beatSamples = STATE.beatDuration * sampleRate;

  const effectiveFirstBeatTime = getEffectiveFirstBeatTime();
  const offsetSamples = effectiveFirstBeatTime * sampleRate;

  const startSampleRaw = offsetSamples + c.beatIndex * beatSamples;
  const lengthSamples = c.lengthInBeats * beatSamples;

  const startSample = Math.max(0, Math.floor(startSampleRaw));
  const endSample = Math.min(buf.length, Math.floor(startSample + lengthSamples));
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

// ── Playback helpers ────────────────────────────────────────────────
function clearPending() {
  if (STATE.pending.uiTimeoutId) {
    clearTimeout(STATE.pending.uiTimeoutId);
    STATE.pending.uiTimeoutId = null;
  }
  if (STATE.pending.source) {
    try { STATE.pending.source.onended = null; } catch (_) {}
    try { STATE.pending.source.stop(); } catch (_) {}
    try { STATE.pending.source.disconnect(); } catch (_) {}
  }
  STATE.pending.source = null;
  STATE.pending.index = null;
  STATE.pending.startAt = null;
}

function stopAllPlayingAt(time) {
  for (const [idx, src] of STATE.activeSources) {
    try { src.stop(time); } catch (_) {}
  }
}

function schedulePlayAt(index, startAt) {
  const chunkBuf = getChunkBuffer(index);
  if (!chunkBuf) return null;

  const source = STATE.audioContext.createBufferSource();
  source.buffer = chunkBuf;
  source.playbackRate.value = STATE.targetBPM / getPlaybackBaseBPM();
  source.connect(STATE.audioContext.destination);

  source.onended = () => {
    padEls[index].classList.remove('active');
    if (STATE.activeSources.get(index) === source) {
      STATE.activeSources.delete(index);
    }
  };

  source.start(startAt);
  return source;
}

// ── Playback ────────────────────────────────────────────────────────
function triggerPad(index, { fromKeyboard }) {
  selectChunk(index);

  const quantActive = fromKeyboard && STATE.metronome.isPlaying && STATE.quantizeDiv;

  // If quantization is NOT active: original monophonic behavior (stop immediately)
  if (!quantActive) {
    clearPending();

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
    source.playbackRate.value = STATE.targetBPM / getPlaybackBaseBPM();
    source.connect(STATE.audioContext.destination);

    STATE.activeSources.set(index, source);
    padEls[index].classList.add('active');

    source.onended = () => {
      padEls[index].classList.remove('active');
      STATE.activeSources.delete(index);
    };

    source.start(0);
    return;
  }

  // Quantization IS active (keypress only):
  // - do NOT stop current immediately
  // - schedule stop + start at the quantized time
  ensureAudioContext();
  const now = STATE.audioContext.currentTime;
  const startAt = getQuantizedTime(now, STATE.quantizeDiv);

  // Replace any previously queued sample (latest key wins)
  clearPending();

  // Schedule current playing sources to stop exactly at the gridline
  stopAllPlayingAt(startAt);

  // Schedule new sample at the same gridline
  const queuedSource = schedulePlayAt(index, startAt);
  if (!queuedSource) return;

  STATE.pending.source = queuedSource;
  STATE.pending.index = index;
  STATE.pending.startAt = startAt;

  // UI handoff at gridline: swap "active" indicator to the queued pad
  const ms = Math.max(0, (startAt - now) * 1000);
  STATE.pending.uiTimeoutId = setTimeout(() => {
    // Clear old active visuals & map (they should have stopped at startAt)
    for (const [idx] of STATE.activeSources) {
      padEls[idx].classList.remove('active');
    }
    STATE.activeSources.clear();

    // Promote queued to active
    STATE.activeSources.set(index, queuedSource);
    padEls[index].classList.add('active');

    // queued is now "active", clear pending record (but keep playback)
    STATE.pending.source = null;
    STATE.pending.index = null;
    STATE.pending.startAt = null;
    STATE.pending.uiTimeoutId = null;
  }, ms);
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
  chunkStart.textContent = `Start: ${c.beatIndex} beats (Grid: ${gridBpm} BPM, Offset: ${STATE.gridOffsetMs}ms)`;

  setLengthSliderFromBeats(c.lengthInBeats);
  lengthValue.textContent = formatBeats(c.lengthInBeats);

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
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const bufferSize = 44 + dataSize;

  const buf = new ArrayBuffer(bufferSize);
  const view = new DataView(buf);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));

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

// ── UI helpers for quantized length slider ──────────────────────────
function configureLengthSlider() {
  lengthSlider.min = 0;
  lengthSlider.max = LENGTH_OPTIONS.length - 1;
  lengthSlider.step = 1;

  setLengthSliderFromBeats(1);
  lengthValue.textContent = formatBeats(1);
}

function setLengthSliderFromBeats(beats) {
  let idx = LENGTH_OPTIONS.indexOf(beats);

  if (idx === -1) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < LENGTH_OPTIONS.length; i++) {
      const d = Math.abs(LENGTH_OPTIONS[i] - beats);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    idx = best;
  }

  lengthSlider.value = idx;
}

function formatBeats(beats) {
  if (beats === 0.25) return '1/4';
  if (beats === 0.5) return '1/2';
  return String(beats);
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

  const abs = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) abs[i] = Math.abs(data[i]);

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

  let bestBPM = 120;
  let bestCount = 0;
  for (const [bpm, count] of Object.entries(intervalCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestBPM = parseInt(bpm, 10);
    }
  }

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