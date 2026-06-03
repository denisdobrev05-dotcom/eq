'use strict';

/* =========================================================================
   Аудио Ефекти — PWA (Slowed/Sped up + Reverb)
   Чист Web Audio API, без външни библиотеки, без build процес.
   Верига: източник → скорост → еквалайзер → bass → компресор → loudness → reverb → изход
   ========================================================================= */

/* ---------------------- Пресети ---------------------- */
const PRESETS = {
  slowed: [
    { name: 'Леко забавено',  speed: 0.92, reverb: 0.18, bass: 2,  meta: '0.92x' },
    { name: 'Класик slowed',  speed: 0.85, reverb: 0.30, bass: 3,  meta: '0.85x' },
    { name: 'Дълбоко slowed', speed: 0.75, reverb: 0.42, bass: 4,  meta: '0.75x' },
    { name: 'Лоуфай',         speed: 0.80, reverb: 0.55, bass: 7,  meta: '0.80x · lofi', comp: true, high: -3 },
    { name: 'Подводно',       speed: 0.70, reverb: 0.95, bass: 6,  meta: '0.70x · max reverb', low: 2, high: -5 },
  ],
  sped: [
    { name: 'Леко ускорено', speed: 1.15, reverb: 0.12, bass: 1, meta: '1.15x' },
    { name: 'Класик sped up', speed: 1.25, reverb: 0.15, bass: 2, meta: '1.25x' },
    { name: 'Найткор',        speed: 1.40, reverb: 0.10, bass: 1, meta: '1.40x' },
    { name: 'Енергично',      speed: 1.30, reverb: 0.22, bass: 3, meta: '1.30x · reverb', comp: true },
    { name: 'Хипер',          speed: 1.50, reverb: 0.08, bass: 0, meta: '1.50x' },
  ],
};

const MODE_LABELS = {
  slowed: 'Slowed + Reverb',
  sped: 'Sped up + Reverb',
};

/* ---------------------- Състояние ---------------------- */
const state = {
  mode: null,
  fileName: '',
  audioBuffer: null,   // декодиран AudioBuffer
  settings: {
    speed: 1, reverb: 0.2, bass: 0, loudness: 1,
    comp: false, low: 0, mid: 0, high: 0,
  },
  playing: false,
  // позиция за плейбек
  startCtxTime: 0,
  startOffset: 0,
};

/* ---------------------- DOM ---------------------- */
const $ = (id) => document.getElementById(id);
const screens = {
  mode: $('screen-mode'),
  upload: $('screen-upload'),
  studio: $('screen-studio'),
};

/* ---------------------- Audio engine ---------------------- */
let audioCtx = null;
let impulseBuffer = null;
let sourceNode = null;
let nodes = null;   // постоянните нодове за реално време
let rafId = null;

function ensureCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/* Генериран синтетичен импулсен отговор за ConvolverNode (без външен файл). */
function createImpulseResponse(ctx, seconds = 3, decay = 3.2) {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // лек pre-delay + експоненциален decay върху бял шум
      const env = Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return ir;
}

/* Изгражда веригата от нодове върху даден контекст (реален или offline). */
function buildChain(ctx, source, settings, impulse) {
  // --- Еквалайзер (3 ленти) ---
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf'; eqLow.frequency.value = 220; eqLow.gain.value = settings.low;

  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1; eqMid.gain.value = settings.mid;

  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf'; eqHigh.frequency.value = 3500; eqHigh.gain.value = settings.high;

  // --- Bass boost (lowshelf ~120 Hz) ---
  const bass = ctx.createBiquadFilter();
  bass.type = 'lowshelf'; bass.frequency.value = 120; bass.gain.value = settings.bass;

  // --- Компресор ---
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24; comp.knee.value = 30; comp.ratio.value = 4;
  comp.attack.value = 0.003; comp.release.value = 0.25;

  // --- Loudness ---
  const loudness = ctx.createGain();
  loudness.gain.value = settings.loudness;

  // --- Reverb (dry/wet) ---
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse;
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = 1 - settings.reverb * 0.55;
  wet.gain.value = settings.reverb;

  // Свързване: source → eqLow → eqMid → eqHigh → bass → [comp?] → loudness
  source.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(bass);

  if (settings.comp) {
    bass.connect(comp);
    comp.connect(loudness);
  } else {
    bass.connect(loudness);
  }

  // loudness → dry → out  и  loudness → convolver → wet → out
  loudness.connect(dry);
  loudness.connect(convolver);
  convolver.connect(wet);
  dry.connect(ctx.destination);
  wet.connect(ctx.destination);

  return { eqLow, eqMid, eqHigh, bass, comp, loudness, convolver, dry, wet, source };
}

/* Пресъздава реалния граф (вика се при play и при смяна на компресор). */
function rebuildLiveGraph(offset) {
  const ctx = ensureCtx();
  if (!impulseBuffer) impulseBuffer = createImpulseResponse(ctx);

  // спри стария източник, ако има
  stopSource();

  const src = ctx.createBufferSource();
  src.buffer = state.audioBuffer;
  src.playbackRate.value = state.settings.speed;

  nodes = buildChain(ctx, src, state.settings, impulseBuffer);
  sourceNode = src;

  src.onended = () => {
    // достигнат край при естествено приключване
    if (state.playing && getPosition() >= state.audioBuffer.duration - 0.05) {
      stopPlayback(true);
    }
  };

  state.startCtxTime = ctx.currentTime;
  state.startOffset = offset;
  src.start(0, offset);
}

function stopSource() {
  if (sourceNode) {
    try { sourceNode.onended = null; sourceNode.stop(); } catch (e) {}
    try { sourceNode.disconnect(); } catch (e) {}
    sourceNode = null;
  }
}

function getPosition() {
  if (!state.audioBuffer) return 0;
  if (!state.playing) return state.startOffset;
  const elapsed = (audioCtx.currentTime - state.startCtxTime) * state.settings.speed;
  return Math.min(state.startOffset + elapsed, state.audioBuffer.duration);
}

function startPlayback() {
  if (!state.audioBuffer) return;
  let offset = state.startOffset;
  if (offset >= state.audioBuffer.duration - 0.05) offset = 0; // restart от край
  rebuildLiveGraph(offset);
  state.playing = true;
  updatePlayUI();
  tickProgress();
}

function stopPlayback(reachedEnd) {
  if (audioCtx && state.playing) {
    state.startOffset = reachedEnd ? 0 : getPosition();
  }
  state.playing = false;
  stopSource();
  cancelAnimationFrame(rafId);
  updatePlayUI();
  updateProgressUI();
}

function togglePlay() {
  if (state.playing) stopPlayback(false);
  else startPlayback();
}

/* Прилага текущите настройки към живите нодове в реално време. */
function applyLiveSettings(changed) {
  if (!nodes || !audioCtx) return;
  const s = state.settings;
  const now = audioCtx.currentTime;

  if (changed === 'speed' && sourceNode) {
    // пре-закотвяне на позицията, за да остане прогресът точен
    state.startOffset = getPosition();
    state.startCtxTime = now;
    sourceNode.playbackRate.setTargetAtTime(s.speed, now, 0.02);
  }
  nodes.eqLow.gain.setTargetAtTime(s.low, now, 0.02);
  nodes.eqMid.gain.setTargetAtTime(s.mid, now, 0.02);
  nodes.eqHigh.gain.setTargetAtTime(s.high, now, 0.02);
  nodes.bass.gain.setTargetAtTime(s.bass, now, 0.02);
  nodes.loudness.gain.setTargetAtTime(s.loudness, now, 0.02);
  nodes.dry.gain.setTargetAtTime(1 - s.reverb * 0.55, now, 0.02);
  nodes.wet.gain.setTargetAtTime(s.reverb, now, 0.02);

  // Компресорът изисква пренасочване на графа
  if (changed === 'comp' && state.playing) {
    const offset = getPosition();
    startPlaybackFrom(offset);
  }
}

function startPlaybackFrom(offset) {
  state.startOffset = offset;
  rebuildLiveGraph(offset);
  state.playing = true;
  updatePlayUI();
  tickProgress();
}

/* ---------------------- Прогрес / UI ---------------------- */
const CIRC = 2 * Math.PI * 54;

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function updatePlayUI() {
  const btn = $('play-btn');
  const icon = $('play-icon');
  btn.classList.toggle('is-playing', state.playing);
  icon.textContent = state.playing ? '❚❚' : '▶';
  btn.setAttribute('aria-label', state.playing ? 'Пауза' : 'Възпроизвеждане');
}

function updateProgressUI() {
  if (!state.audioBuffer) return;
  const pos = getPosition();
  const dur = state.audioBuffer.duration;
  const frac = dur ? pos / dur : 0;
  $('play-progress').style.strokeDashoffset = String(CIRC * (1 - frac));
  $('time-current').textContent = fmtTime(pos);
  $('time-total').textContent = fmtTime(dur);
}

function tickProgress() {
  updateProgressUI();
  if (state.playing) rafId = requestAnimationFrame(tickProgress);
}

/* ---------------------- Навигация между екрани ---------------------- */
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('screen--active'));
  screens[name].classList.add('screen--active');
  window.scrollTo(0, 0);
}

/* ---------------------- Рендиране на пресети ---------------------- */
function renderPresets() {
  const wrap = $('presets');
  wrap.innerHTML = '';
  const list = PRESETS[state.mode] || [];
  list.forEach((p, idx) => {
    const btn = document.createElement('button');
    btn.className = 'preset';
    btn.dataset.idx = String(idx);
    btn.innerHTML =
      `<span class="preset__name">${p.name}</span>` +
      `<span class="preset__meta">${p.meta}</span>`;
    btn.addEventListener('click', () => applyPreset(idx));
    wrap.appendChild(btn);
  });
}

function applyPreset(idx) {
  const p = PRESETS[state.mode][idx];
  if (!p) return;
  const s = state.settings;
  s.speed = p.speed;
  s.reverb = p.reverb;
  s.bass = p.bass;
  s.comp = !!p.comp;
  s.low = p.low || 0;
  s.mid = p.mid || 0;
  s.high = p.high || 0;
  syncControlsFromState();
  // отбележи активния пресет
  document.querySelectorAll('.preset').forEach((el, i) => {
    el.classList.toggle('is-active', i === idx);
  });
  // приложи всичко наведнъж
  applyLiveSettings('speed');
  applyLiveSettings('comp');
  toast(`Пресет: ${p.name}`);
}

function clearActivePreset() {
  document.querySelectorAll('.preset.is-active').forEach((el) => el.classList.remove('is-active'));
}

/* ---------------------- Синхронизация контроли ↔ състояние ---------------------- */
function syncControlsFromState() {
  const s = state.settings;
  setSlider('ctl-speed', s.speed);
  setSlider('ctl-reverb', s.reverb);
  setSlider('ctl-bass', s.bass);
  setSlider('ctl-loudness', s.loudness);
  setSlider('ctl-low', s.low);
  setSlider('ctl-mid', s.mid);
  setSlider('ctl-high', s.high);
  $('ctl-comp').setAttribute('aria-checked', s.comp ? 'true' : 'false');
  updateOutputs();
}

function setSlider(id, value) {
  const el = $(id);
  el.value = String(value);
  updateSliderFill(el);
}

function updateSliderFill(el) {
  const min = parseFloat(el.min), max = parseFloat(el.max);
  const frac = (parseFloat(el.value) - min) / (max - min);
  el.style.backgroundSize = (frac * 100) + '% 100%';
}

function updateOutputs() {
  const s = state.settings;
  $('val-speed').textContent = s.speed.toFixed(2) + 'x';
  $('val-reverb').textContent = Math.round(s.reverb * 100) + '%';
  $('val-bass').textContent = (s.bass >= 0 ? '+' : '') + s.bass + ' dB';
  $('val-loudness').textContent = Math.round(s.loudness * 100) + '%';
  $('val-low').textContent = (s.low >= 0 ? '+' : '') + s.low + ' dB';
  $('val-mid').textContent = (s.mid >= 0 ? '+' : '') + s.mid + ' dB';
  $('val-high').textContent = (s.high >= 0 ? '+' : '') + s.high + ' dB';
}

/* ---------------------- Качване / декодиране ---------------------- */
async function handleFile(file) {
  if (!file) return;
  const okTypes = /(mp3|wav|m4a|mpeg|x-m4a|aac|ogg|audio)/i;
  if (!okTypes.test(file.type) && !/\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name)) {
    toast('Неподдържан формат. Използвай mp3, wav или m4a.', true);
    return;
  }
  const status = $('upload-status');
  status.hidden = false;
  $('upload-status-text').textContent = 'Зареждане на „' + file.name + '“…';
  try {
    const arrayBuf = await file.arrayBuffer();
    const ctx = ensureCtx();
    $('upload-status-text').textContent = 'Декодиране…';
    const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
    state.audioBuffer = decoded;
    state.fileName = file.name;
    // нулирай позиция
    state.startOffset = 0;
    state.playing = false;
    enterStudio();
  } catch (e) {
    console.error(e);
    toast('Файлът не може да бъде декодиран. Опитай друг файл.', true);
  } finally {
    status.hidden = true;
  }
}

function enterStudio() {
  $('studio-mode-label').textContent = MODE_LABELS[state.mode];
  $('track-name').textContent = state.fileName || '—';
  renderPresets();
  syncControlsFromState();
  updateProgressUI();
  updatePlayUI();
  showScreen('studio');
}

/* ---------------------- Експорт WAV (OfflineAudioContext) ---------------------- */
async function exportWav() {
  if (!state.audioBuffer) return;
  const btn = $('save-btn');
  const prog = $('export-progress');
  btn.disabled = true;
  prog.hidden = false;
  $('export-bar').style.width = '8%';
  $('export-text').textContent = 'Обработка…';

  // спри реалното възпроизвеждане за по-чист рендер
  const wasPlaying = state.playing;
  if (wasPlaying) stopPlayback(false);

  try {
    const buf = state.audioBuffer;
    const speed = state.settings.speed;
    const outLength = Math.ceil(buf.length / speed) + 1;
    const channels = Math.min(2, buf.numberOfChannels) || 1;

    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OAC(channels, outLength, buf.sampleRate);

    const impulse = createImpulseResponse(offline);
    const src = offline.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    buildChain(offline, src, state.settings, impulse);
    src.start(0);

    $('export-bar').style.width = '35%';
    const rendered = await offline.startRendering();
    $('export-bar').style.width = '75%';
    $('export-text').textContent = 'Кодиране на WAV…';

    const wav = encodeWav(rendered);
    $('export-bar').style.width = '95%';

    const baseName = (state.fileName || 'audio').replace(/\.[^.]+$/, '');
    const tag = state.mode === 'slowed' ? 'slowed-reverb' : 'spedup-reverb';
    downloadBlob(wav, `${baseName}_${tag}.wav`);

    $('export-bar').style.width = '100%';
    toast('Готово! Файлът се сваля.');
  } catch (e) {
    console.error(e);
    toast('Грешка при експорт. Опитай отново.', true);
  } finally {
    setTimeout(() => { prog.hidden = true; $('export-bar').style.width = '0%'; }, 700);
    btn.disabled = false;
  }
}

/* 16-bit PCM WAV енкодер */
function encodeWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const rate = audioBuffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);         // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // interleave + клиппинг
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let sample = chans[c][i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

/* ---------------------- Toast ---------------------- */
let toastTimer = null;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('toast--error', !!isError);
  // force reflow за анимация
  void el.offsetWidth;
  el.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-show');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 2600);
}

/* ---------------------- Слушатели ---------------------- */
function bindEvents() {
  // Избор на режим
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.mode = card.dataset.mode;
      $('upload-mode-label').textContent = MODE_LABELS[state.mode];
      showScreen('upload');
    });
  });

  // Назад
  document.querySelector('[data-action="back-to-mode"]').addEventListener('click', () => {
    stopPlayback(false);
    showScreen('mode');
  });
  document.querySelector('[data-action="back-to-upload"]').addEventListener('click', () => {
    stopPlayback(false);
    showScreen('upload');
  });

  // Качване
  const fileInput = $('file-input');
  fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-drag'); }));
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // Play / Pause
  $('play-btn').addEventListener('click', togglePlay);

  // Плъзгачи
  const bind = (id, key, parse) => {
    const el = $(id);
    el.addEventListener('input', () => {
      state.settings[key] = parse(el.value);
      updateSliderFill(el);
      updateOutputs();
      clearActivePreset();
      applyLiveSettings(key);
    });
  };
  bind('ctl-speed', 'speed', parseFloat);
  bind('ctl-reverb', 'reverb', parseFloat);
  bind('ctl-bass', 'bass', parseFloat);
  bind('ctl-loudness', 'loudness', parseFloat);
  bind('ctl-low', 'low', parseFloat);
  bind('ctl-mid', 'mid', parseFloat);
  bind('ctl-high', 'high', parseFloat);

  // Компресор switch
  $('ctl-comp').addEventListener('click', () => {
    const el = $('ctl-comp');
    const on = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    state.settings.comp = on;
    clearActivePreset();
    applyLiveSettings('comp');
  });

  // Запази
  $('save-btn').addEventListener('click', exportWav);

  // Пауза при скриване на таба
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.playing) stopPlayback(false);
  });
}

/* ---------------------- Service Worker ---------------------- */
function registerSW() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW fail', e));
    });
  }
}

/* ---------------------- Старт ---------------------- */
bindEvents();
registerSW();
