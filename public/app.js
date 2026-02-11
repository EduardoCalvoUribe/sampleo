// ── State ───────────────────────────────────────────────────────────
const STATE = {
  audioContext: null,
  originalBuffer: null,

  currentSong: null,       // filename

  detectedBPM: 0,          // analyzed BPM (info)
  firstBeatTime: 0,        // auto-detected phase start (seconds)

  gridBPM: 0,              // beatgrid BPM override; 0 => use detectedBPM
  targetBPM: 120,          // playback target BPM (user control)

  beatDuration: 0,         // seconds per beat at GRID bpm
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
    volume: 0.35
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
  },

  // ── Sequencer ──
  sequencer: {
    notes: [],          // [{padIndex, beat}] — beat is 0-based position on timeline
    gridBeats: 8,       // 4, 8, 16, or 32
    isPlaying: false,
    startTime: 0,       // audioContext.currentTime anchor
    nextBeatTime: 0,    // scheduler lookahead cursor
    currentBeat: 0,     // integer beat for scheduling
    intervalId: null,
    animFrameId: null,
    dragSource: null,    // padIndex being dragged onto timeline
    dragNote: null       // existing note being repositioned
  }
};

const STORAGE_PREFIX = 'SAMPLEO_songSettings::';

function getSongKey(filename) {
  return STORAGE_PREFIX + filename;
}

function loadSongSettings(filename) {
  try {
    const raw = localStorage.getItem(getSongKey(filename));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveSongSettings(patch) {
  if (!STATE.currentSong) return;
  const key = getSongKey(STATE.currentSong);
  const existing = loadSongSettings(STATE.currentSong) || {};
  const next = { ...existing, ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch (_) {}
}

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
const metroVolSlider   = document.getElementById('metro-vol');
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

// Sequencer UI
const seqPlayBtn       = document.getElementById('seq-play');
const seqBeatsSelect   = document.getElementById('seq-beats');
const seqClearBtn      = document.getElementById('seq-clear');
const seqTimeline      = document.getElementById('seq-timeline');

// ── Build pad grid ──────────────────────────────────────────────────
const padEls = [];
const allKeys = [...KEYS_ROW1, ...KEYS_ROW2];
for (let i = 0; i < 16; i++) {
  const pad = document.createElement('div');
  pad.className = 'pad';
  pad.innerHTML = `<span class="pad-key">${allKeys[i]}</span><span class="pad-num">${i + 1}</span>`;
  pad.addEventListener('pointerdown', (e) => padPointerDown(i, e));
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
  saveSongSettings({ targetBPM: STATE.targetBPM });
});

// Quantized length slider
configureLengthSlider();
lengthSlider.addEventListener('input', () => {
  const c = STATE.chunks[STATE.selectedChunkIndex];
  if (!c) return;

  const opt = LENGTH_OPTIONS[parseInt(lengthSlider.value, 10)] ?? 1;
  c.lengthInBeats = opt;

  lengthValue.textContent = formatBeats(opt);
  drawWaveform();
  renderTimeline();
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

    saveSongSettings({ offsetMs: STATE.gridOffsetMs });

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
    STATE.currentSong = file;
    songName.textContent = file;

    // restore per-song settings first (grid BPM override + offset + target BPM)
    const cached = loadSongSettings(file);
    if (cached) {
      if (typeof cached.gridBPM === 'number') STATE.gridBPM = cached.gridBPM;
      if (typeof cached.offsetMs === 'number') STATE.gridOffsetMs = cached.offsetMs;
      if (typeof cached.targetBPM === 'number') STATE.targetBPM = cached.targetBPM;

      // update UI immediately
      if (offsetSlider) offsetSlider.value = String(STATE.gridOffsetMs);
      if (offsetValue) offsetValue.textContent = `${STATE.gridOffsetMs} ms`;
      targetBpmInput.value = STATE.targetBPM;
    } else {
      STATE.gridBPM = 0;
      STATE.gridOffsetMs = 0;
      if (offsetSlider) offsetSlider.value = '0';
      if (offsetValue) offsetValue.textContent = `0 ms`;
    }

    // load audio
    const audioRes = await fetch('/songs/' + encodeURIComponent(file));
    const arrayBuf = await audioRes.arrayBuffer();
    STATE.originalBuffer = await STATE.audioContext.decodeAudioData(arrayBuf);

    // use cached analysis if present
    if (cached && typeof cached.analyzedBPM === 'number' && typeof cached.firstBeatTime === 'number') {
      STATE.detectedBPM = cached.analyzedBPM;
      STATE.firstBeatTime = cached.firstBeatTime;
    } else {
      const bpmResult = await fetchBPM(file, STATE.originalBuffer);
      STATE.detectedBPM = bpmResult.bpm;
      STATE.firstBeatTime = bpmResult.firstBeatTime;

      // cache analysis result
      saveSongSettings({
        analyzedBPM: STATE.detectedBPM,
        firstBeatTime: STATE.firstBeatTime
      });
    }

    // If targetBPM wasn’t restored, default it (baseline behavior)
    if (!cached || typeof cached.targetBPM !== 'number') {
      STATE.targetBPM = (STATE.gridBPM && STATE.gridBPM > 0) ? STATE.gridBPM : (STATE.detectedBPM || 120);
      targetBpmInput.value = STATE.targetBPM;
      saveSongSettings({ targetBPM: STATE.targetBPM });
    }

    updateBeatDurationFromGrid();
    recomputeTotalBeats();

    renderBpmDisplay();

    initChunks();          // unique whole-beat starts
    selectChunk(0);
    renderTimeline();      // update timeline block widths
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
      saveSongSettings({ gridBPM: 0 });

      STATE.targetBPM = getPlaybackBaseBPM();
      targetBpmInput.value = STATE.targetBPM;
      saveSongSettings({ targetBPM: STATE.targetBPM });
    } else {
      // set override
      STATE.gridBPM = val;
      saveSongSettings({ gridBPM: val });

      // snap target bpm to new baseline
      STATE.targetBPM = val;
      targetBpmInput.value = val;
      saveSongSettings({ targetBPM: val });
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
    STATE.metronome.nextTickTime += getTargetBeatDuration();
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
  gain.connect(STATE.metronome.gainNode);

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

  const defaultLen = 1;
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
  renderTimeline();
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
  for (const [, src] of STATE.activeSources) {
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

  if (!quantActive) {
    // original monophonic behavior (immediate stop + start)
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

  // Quantization active (keypress only): queue to next gridline
  ensureAudioContext();
  const now = STATE.audioContext.currentTime;
  const startAt = getQuantizedTime(now, STATE.quantizeDiv);

  // latest key wins
  clearPending();

  // stop current at the gridline
  stopAllPlayingAt(startAt);

  // schedule next sample at gridline
  const queuedSource = schedulePlayAt(index, startAt);
  if (!queuedSource) return;

  STATE.pending.source = queuedSource;
  STATE.pending.index = index;
  STATE.pending.startAt = startAt;

  // UI handoff at gridline
  const ms = Math.max(0, (startAt - now) * 1000);
  STATE.pending.uiTimeoutId = setTimeout(() => {
    for (const [idx] of STATE.activeSources) {
      padEls[idx].classList.remove('active');
    }
    STATE.activeSources.clear();

    STATE.activeSources.set(index, queuedSource);
    padEls[index].classList.add('active');

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
  a.download = `sampleo_chunk_${index + 1}.wav`;
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

// ══════════════════════════════════════════════════════════════════════
// ── SEQUENCER ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// ── Pad drag → timeline logic ────────────────────────────────────────
const PAD_DRAG_THRESHOLD = 8; // px before drag starts
let _padDragState = null;     // {padIndex, startX, startY, isDragging, ghost}

function padPointerDown(padIndex, e) {
  if (e.button !== 0) return;
  _padDragState = {
    padIndex,
    startX: e.clientX,
    startY: e.clientY,
    isDragging: false,
    ghost: null
  };
  // Don't trigger pad yet — wait for pointerup (click) vs drag
}

document.addEventListener('pointermove', (e) => {
  if (!_padDragState) return;

  const dx = e.clientX - _padDragState.startX;
  const dy = e.clientY - _padDragState.startY;

  if (!_padDragState.isDragging) {
    if (Math.sqrt(dx * dx + dy * dy) < PAD_DRAG_THRESHOLD) return;
    _padDragState.isDragging = true;
    STATE.sequencer.dragSource = _padDragState.padIndex;

    // Create ghost element
    const ghost = document.createElement('div');
    ghost.className = 'seq-note';
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    ghost.style.width = '50px';
    ghost.style.height = '44px';
    ghost.style.opacity = '0.8';
    ghost.textContent = allKeys[_padDragState.padIndex];
    document.body.appendChild(ghost);
    _padDragState.ghost = ghost;
  }

  if (_padDragState.ghost) {
    _padDragState.ghost.style.left = (e.clientX - 25) + 'px';
    _padDragState.ghost.style.top = (e.clientY - 22) + 'px';
  }

  // Show drop indicator on timeline
  updateDropIndicator(e);
});

document.addEventListener('pointerup', (e) => {
  if (!_padDragState) return;

  const state = _padDragState;
  _padDragState = null;

  if (state.ghost) {
    state.ghost.remove();
  }
  removeDropIndicator();

  if (!state.isDragging) {
    // It was a click, not a drag — trigger the pad
    triggerPad(state.padIndex, { fromKeyboard: false });
    STATE.sequencer.dragSource = null;
    return;
  }

  // Was a drag — check if dropped on timeline
  if (!seqTimeline) { STATE.sequencer.dragSource = null; return; }

  const rect = seqTimeline.getBoundingClientRect();
  if (e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom) {
    const relX = (e.clientX - rect.left) / rect.width;
    const beat = Math.round(relX * STATE.sequencer.gridBeats * 4) / 4;
    const snapped = Math.max(0, Math.min(STATE.sequencer.gridBeats - 0.25, beat));

    STATE.sequencer.notes.push({ padIndex: state.padIndex, beat: snapped });
    renderTimeline();
  }

  STATE.sequencer.dragSource = null;
});

// ── Drop indicator on timeline during pad drag ──────────────────────
function updateDropIndicator(e) {
  removeDropIndicator();
  if (!seqTimeline || !_padDragState || !_padDragState.isDragging) return;

  const rect = seqTimeline.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top || e.clientY > rect.bottom) return;

  const relX = (e.clientX - rect.left) / rect.width;
  const beat = Math.round(relX * STATE.sequencer.gridBeats * 4) / 4;
  const snapped = Math.max(0, Math.min(STATE.sequencer.gridBeats - 0.25, beat));

  const chunk = STATE.chunks[_padDragState.padIndex];
  const lengthBeats = chunk ? chunk.lengthInBeats : 1;

  const indicator = document.createElement('div');
  indicator.className = 'seq-drop-indicator';
  indicator.style.left = (snapped / STATE.sequencer.gridBeats * 100) + '%';
  indicator.style.width = (lengthBeats / STATE.sequencer.gridBeats * 100) + '%';
  indicator.id = 'seq-drop-ind';
  seqTimeline.appendChild(indicator);
}

function removeDropIndicator() {
  const existing = document.getElementById('seq-drop-ind');
  if (existing) existing.remove();
}

// ── Timeline rendering ──────────────────────────────────────────────
function renderTimeline() {
  if (!seqTimeline) return;

  // Preserve playhead if playing
  const wasPlaying = STATE.sequencer.isPlaying;

  seqTimeline.innerHTML = '';
  const gridBeats = STATE.sequencer.gridBeats;

  // Beat lines, quarter-beat subdivisions + labels
  const totalQuarters = gridBeats * 4;
  for (let q = 0; q <= totalQuarters; q++) {
    const beatPos = q / 4;
    const pct = (beatPos / gridBeats * 100) + '%';

    const line = document.createElement('div');
    if (q % 4 === 0) {
      // Whole beat
      line.className = (q % 16 === 0) ? 'seq-bar-line' : 'seq-beat-line';
    } else {
      line.className = 'seq-quarter-line';
    }
    line.style.left = pct;
    seqTimeline.appendChild(line);

    // Beat number labels on whole beats only
    if (q % 4 === 0 && beatPos < gridBeats) {
      const label = document.createElement('div');
      label.className = 'seq-beat-label';
      label.style.left = ((beatPos + 0.5) / gridBeats * 100) + '%';
      label.textContent = beatPos + 1;
      seqTimeline.appendChild(label);
    }
  }

  // Note blocks
  STATE.sequencer.notes.forEach((note, noteIdx) => {
    const chunk = STATE.chunks[note.padIndex];
    if (!chunk) return;

    const block = document.createElement('div');
    block.className = 'seq-note';
    block.style.left = (note.beat / gridBeats * 100) + '%';
    block.style.width = (chunk.lengthInBeats / gridBeats * 100) + '%';
    block.textContent = allKeys[note.padIndex];
    block.dataset.noteIdx = noteIdx;

    // Drag to reposition
    block.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      startNoteDrag(noteIdx, e);
    });

    // Right-click to remove
    block.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      STATE.sequencer.notes.splice(noteIdx, 1);
      renderTimeline();
    });

    seqTimeline.appendChild(block);
  });

  // Playhead
  const playhead = document.createElement('div');
  playhead.className = 'seq-playhead';
  playhead.id = 'seq-playhead';
  playhead.style.left = '0%';
  playhead.style.display = wasPlaying ? 'block' : 'none';
  seqTimeline.appendChild(playhead);
}

// ── Note block drag (reposition within timeline) ────────────────────
let _noteDragState = null;

function startNoteDrag(noteIdx, e) {
  const note = STATE.sequencer.notes[noteIdx];
  if (!note) return;

  const rect = seqTimeline.getBoundingClientRect();
  const blockEl = e.target.closest('.seq-note');

  _noteDragState = {
    noteIdx,
    originalBeat: note.beat,
    startX: e.clientX,
    startY: e.clientY,
    isDragging: false,
    timelineRect: rect,
    blockEl
  };

  const onMove = (ev) => {
    if (!_noteDragState) return;

    if (!_noteDragState.isDragging) {
      const dx = ev.clientX - _noteDragState.startX;
      const dy = ev.clientY - _noteDragState.startY;
      if (Math.sqrt(dx * dx + dy * dy) < PAD_DRAG_THRESHOLD) return;
      _noteDragState.isDragging = true;
      if (_noteDragState.blockEl) _noteDragState.blockEl.classList.add('dragging');
    }

    const relX = (ev.clientX - _noteDragState.timelineRect.left) / _noteDragState.timelineRect.width;
    const beat = Math.round(relX * STATE.sequencer.gridBeats * 4) / 4;
    const snapped = Math.max(0, Math.min(STATE.sequencer.gridBeats - 0.25, beat));

    STATE.sequencer.notes[_noteDragState.noteIdx].beat = snapped;
    if (_noteDragState.blockEl) {
      _noteDragState.blockEl.style.left = (snapped / STATE.sequencer.gridBeats * 100) + '%';
    }
  };

  const onUp = () => {
    const wasDragging = _noteDragState && _noteDragState.isDragging;

    if (_noteDragState && _noteDragState.blockEl) {
      _noteDragState.blockEl.classList.remove('dragging');
    }

    // Click (no drag) — select the corresponding pad/chunk
    if (!wasDragging && note) {
      selectChunk(note.padIndex);
    }

    _noteDragState = null;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    renderTimeline();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// ── Sequencer playback engine ───────────────────────────────────────
function startSequencer() {
  ensureAudioContext();
  if (STATE.audioContext.state === 'suspended') STATE.audioContext.resume();

  const seq = STATE.sequencer;
  const now = STATE.audioContext.currentTime;

  seq.startTime = now + 0.05;
  seq.nextBeatTime = seq.startTime;
  seq.currentBeat = 0;
  seq.isPlaying = true;

  seq.intervalId = setInterval(sequencerScheduler, 25);
  seq.animFrameId = requestAnimationFrame(updatePlayhead);

  const ph = document.getElementById('seq-playhead');
  if (ph) ph.style.display = 'block';

  updateSeqPlayBtn();
}

function stopSequencer() {
  const seq = STATE.sequencer;
  seq.isPlaying = false;

  if (seq.intervalId) {
    clearInterval(seq.intervalId);
    seq.intervalId = null;
  }
  if (seq.animFrameId) {
    cancelAnimationFrame(seq.animFrameId);
    seq.animFrameId = null;
  }

  // Stop any sequencer-triggered sounds
  for (const [idx, src] of STATE.activeSources) {
    try { src.stop(); } catch (_) {}
    padEls[idx].classList.remove('active');
  }
  STATE.activeSources.clear();

  const ph = document.getElementById('seq-playhead');
  if (ph) { ph.style.display = 'none'; ph.style.left = '0%'; }

  updateSeqPlayBtn();
}

function sequencerScheduler() {
  const seq = STATE.sequencer;
  if (!seq.isPlaying || !STATE.audioContext) return;

  const now = STATE.audioContext.currentTime;
  const ahead = now + 0.12;

  const quarterBeatDur = getTargetBeatDuration() / 4;

  while (seq.nextBeatTime < ahead) {
    // currentBeat counts quarter-beats; convert to beat position
    const beat = (seq.currentBeat % (seq.gridBeats * 4)) / 4;

    // Find notes at this beat (compare as quarter-beat indices to avoid float issues)
    const qIdx = seq.currentBeat % (seq.gridBeats * 4);
    for (const note of seq.notes) {
      if (Math.round(note.beat * 4) === qIdx) {
        // Monophonic: stop all current at this time
        stopAllPlayingAt(seq.nextBeatTime);

        const src = schedulePlayAt(note.padIndex, seq.nextBeatTime);
        if (src) {
          // Update active sources for UI
          const padIdx = note.padIndex;
          STATE.activeSources.set(padIdx, src);

          // Schedule UI highlight
          const delayMs = Math.max(0, (seq.nextBeatTime - now) * 1000);
          setTimeout(() => {
            padEls.forEach(p => p.classList.remove('active'));
            padEls[padIdx].classList.add('active');
          }, delayMs);
        }
      }
    }

    seq.nextBeatTime += quarterBeatDur;
    seq.currentBeat++;
  }
}

function updatePlayhead() {
  const seq = STATE.sequencer;
  if (!seq.isPlaying) return;

  const now = STATE.audioContext.currentTime;
  const elapsed = now - seq.startTime;
  const totalDuration = seq.gridBeats * getTargetBeatDuration();
  const position = (elapsed % totalDuration) / totalDuration;

  const ph = document.getElementById('seq-playhead');
  if (ph) ph.style.left = (position * 100) + '%';

  seq.animFrameId = requestAnimationFrame(updatePlayhead);
}

function updateSeqPlayBtn() {
  if (!seqPlayBtn) return;
  seqPlayBtn.innerHTML = STATE.sequencer.isPlaying ? '&#9646;&#9646;' : '&#9654;';
  seqPlayBtn.title = STATE.sequencer.isPlaying ? 'Pause sequencer' : 'Play sequencer';
}

// ── Sequencer UI wiring ─────────────────────────────────────────────
if (seqPlayBtn) {
  seqPlayBtn.addEventListener('click', () => {
    if (STATE.sequencer.isPlaying) stopSequencer();
    else startSequencer();
  });
}

if (seqBeatsSelect) {
  seqBeatsSelect.addEventListener('change', () => {
    const val = parseInt(seqBeatsSelect.value, 10);
    STATE.sequencer.gridBeats = val;

    // Remove notes outside the new range
    STATE.sequencer.notes = STATE.sequencer.notes.filter(n => n.beat < val);

    // Restart if playing
    if (STATE.sequencer.isPlaying) {
      stopSequencer();
      renderTimeline();
      startSequencer();
    } else {
      renderTimeline();
    }
  });
}

if (seqClearBtn) {
  seqClearBtn.addEventListener('click', () => {
    STATE.sequencer.notes = [];
    renderTimeline();
  });
}

// Initial render
renderTimeline();
updateSeqPlayBtn();