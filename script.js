'use strict';

/* CONSTANTS */
const PHYSICS = {
  SPEED_OF_SOUND: 343,
};

let SIM_SCALE = 4.5;

const SIM_SCALE_BASE_WIDTH = 900;
const SIM_SCALE_BASE_VALUE = 3.2;
const WAVEFRONT_CULL_EXTRA = 80;
const WAVEFRONT_MAX = 120;

const AMB = {
  WIDTH:  54,
  HEIGHT: 24,
  WHEEL_R: 5,
};

const MIN_RINGS = 4;   // at 100 Hz
const MAX_RINGS = 19;  // at 1000 Hz

function freqToRingCount(freq) {
  const t = Math.max(0, Math.min(1, (freq - 100) / 900));
  return Math.round(t * (MAX_RINGS - MIN_RINGS) + MIN_RINGS);
}

/* SIMULATION STATE */
const state = {
  sourceFreq:    440,
  sourceSpeed:   15,
  animSpeed:     1.0,

  showLabels:    true,
  showWavelength:false,
  showObservers: true,
  showEquations: true,
  showGraph:     true,

  running:       true,
  lastTimestamp: null,

  simTime:       0,
  lastEmitTime:  0,
  emitCount:     0,

  ambulanceX:    0,
  ambulanceY:    0,

  wavefronts:    [],

  canvasW: 0,
  canvasH: 0,

  fps:       60,
  frameCount:0,
  fpsTimer:  0,

  _frameN:     0,
  _graphDirty: true,

  graphMode:      'default',
  focusObserver:  'ahead',

  isFullscreen:   false,

  _lastWlFrontPct:  -1,
  _lastWlSourcePct: -1,
  _lastWlRearPct:   -1,
};

/* PHYSICS CLIENT — talks to the Python backend */
const PhysicsClient = {

  cache: {
    freqAhead:        Infinity,
    freqBehind:       0,
    wavelengthAhead:  0,
    wavelengthBehind: 0,
    lambdaSource:     0,
    lambdaFront:      0,
    lambdaRear:       0,
    mach:             0,
  },

  curve: { frequency: null, points: [] },

  _paramsTimer: null,
  _curveTimer:  null,


  _dopplerReqId: 0,
  _curveReqId:   0,


  onCacheUpdated: null,

  async _fetchDoppler(f, vs) {
    const reqId = ++this._dopplerReqId;
    try {
      const res = await fetch('/api/doppler', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ frequency: f, speed: vs, speedOfSound: PHYSICS.SPEED_OF_SOUND }),
      });
      const data = await res.json();
      if (reqId !== this._dopplerReqId) return this.cache; // a newer request superseded this one — discard
      this.cache = {
        freqAhead:        data.freqAhead        === null ? Infinity : data.freqAhead,
        freqBehind:       data.freqBehind,
        wavelengthAhead:  data.wavelengthAhead   === null ? 0 : data.wavelengthAhead,
        wavelengthBehind: data.wavelengthBehind,
        lambdaSource:     data.lambdaSource,
        lambdaFront:      data.lambdaFront,
        lambdaRear:       data.lambdaRear,
        mach:             data.mach,
      };
      if (this.onCacheUpdated) this.onCacheUpdated();
    } catch (err) {
      console.error('Doppler API request failed, keeping last known values:', err);
    }
    return this.cache;
  },

  async _fetchCurve(f) {
    const reqId = ++this._curveReqId;
    try {
      const res = await fetch('/api/doppler-curve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ frequency: f, speedOfSound: PHYSICS.SPEED_OF_SOUND, maxVs: 100, steps: 200 }),
      });
      const data = await res.json();
      if (reqId !== this._curveReqId) return; // a newer request superseded this one — discard
      this.curve = {
        frequency: f,
        points: data.points.map(p => ({
          vs:         p.vs,
          freqAhead:  p.freqAhead === null ? Infinity : p.freqAhead,
          freqBehind: p.freqBehind,
        })),
      };
    } catch (err) {
      console.error('Doppler curve API request failed, keeping last known curve:', err);
    }
  },

  async init(f, vs) {
    await Promise.all([this._fetchDoppler(f, vs), this._fetchCurve(f)]);
  },

  onParamsChanged(f, vs) {
    clearTimeout(this._paramsTimer);
    this._paramsTimer = setTimeout(() => { this._fetchDoppler(f, vs); }, 30);
  },

  onFrequencyChanged(f) {
    clearTimeout(this._curveTimer);
    this._curveTimer = setTimeout(() => { this._fetchCurve(f); }, 30);
  },

  async fetchFresh(f, vs) {
    return this._fetchDoppler(f, vs);
  },


  observerFreq(observerX, sourceX) {
    const approaching = sourceX < observerX;
    const freq = approaching ? this.cache.freqAhead : this.cache.freqBehind;
    return { freq, approaching };
  },


  curveFreqAt(vs) {
    const pts = this.curve.points;
    if (!pts || pts.length < 2) return { freqAhead: null, freqBehind: 0 };
    const maxVs = pts[pts.length - 1].vs;
    const clamped = Math.max(0, Math.min(maxVs, vs));
    const t  = (clamped / maxVs) * (pts.length - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, pts.length - 1);
    const frac = t - i0;
    const lerp = (a, b) => (!isFinite(a) || !isFinite(b)) ? Infinity : a + (b - a) * frac;
    return {
      freqAhead:  lerp(pts[i0].freqAhead,  pts[i1].freqAhead),
      freqBehind: lerp(pts[i0].freqBehind, pts[i1].freqBehind),
    };
  },
};

/* RENDERER — Main simulation canvas */
const Renderer = {

  canvas: null,
  ctx:    null,

  C: {
    bg:         '#111420',
    grid:       '#1a1f2e',
    gridLine:   '#252d42',
    wavefront:  'rgba(0,229,255,0.35)',
    waveBorder: 'rgba(0,229,255,0.7)',
    ambulance:  '#e8eaf0',
    ambulanceTrim: '#00e5ff',
    obsA:       '#00e5ff',
    obsB:       '#f59e0b',
    obsLabel:   '#e8eaf0',
    text:       '#8892a4',
    textBright: '#e8eaf0',
    wlLine:     'rgba(255,255,255,0.5)',
    wlLabel:    'rgba(255,255,255,0.85)',
    groundLine: '#252d42',
  },

  init(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.resize();
  },

  resize() {
    const wrapper = this.canvas.parentElement;
    const w = wrapper.clientWidth;
    const h = Math.round(w * 7 / 16);
    this.canvas.width  = w;
    this.canvas.height = h;
    state.canvasW = w;
    state.canvasH = h;

    SIM_SCALE = SIM_SCALE_BASE_VALUE * (w / SIM_SCALE_BASE_WIDTH);
    if (SIM_SCALE < 1.8) SIM_SCALE = 1.8;
  },

  toCanvasX(worldX) {
    return state.canvasW / 2 + worldX * SIM_SCALE;
  },

  toCanvasY(worldY) {
    return state.canvasH / 2 + worldY * SIM_SCALE;
  },

  toWorldX(cx) {
    return (cx - state.canvasW / 2) / SIM_SCALE;
  },

  draw() {
    const ctx = this.ctx;
    const W = state.canvasW;
    const H = state.canvasH;

    ctx.fillStyle = this.C.bg;
    ctx.fillRect(0, 0, W, H);

    this.drawGrid(ctx, W, H);

    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = this.C.groundLine;
    ctx.lineWidth = 1;
    const groundY = this.toCanvasY(AMB.HEIGHT / 2 / SIM_SCALE + 10);
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(W, groundY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    this.drawWavefronts(ctx);

    if (state.showWavelength) {
      this.drawWavelengthOverlay(ctx, W, H);
    }

    this.drawObservers(ctx, W, H);
    this.drawAmbulance(ctx);
    this.drawOverlay(ctx, W, H);
  },

  drawGrid(ctx, W, H) {
    ctx.save();
    ctx.strokeStyle = this.C.gridLine;
    ctx.lineWidth = 0.5;
    const spacing = 40;
    for (let x = 0; x < W; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y < H; y += spacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();
  },

  drawWavefronts(ctx) {
    const V  = PHYSICS.SPEED_OF_SOUND;
    const vs = state.sourceSpeed;
    const W  = state.canvasW;
    const H  = state.canvasH;

    const containerCx = this.toCanvasX(state.ambulanceX);
    const containerCy = this.toCanvasY(state.ambulanceY);
    const containerR  = Math.min(W, H) * 0.46;

    ctx.save();

    // Faint container border
    ctx.beginPath();
    ctx.arc(containerCx, containerCy, containerR, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,229,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.translate(containerCx, containerCy);

    // Clip everything to the container circle
    ctx.beginPath();
    ctx.arc(0, 0, containerR, 0, Math.PI * 2);
    ctx.clip();

    const N = freqToRingCount(state.sourceFreq);

    const outerAgeTime = containerR / (V * SIM_SCALE);  // seconds (scaled)
    const maxOffsetPx  = vs * outerAgeTime * SIM_SCALE;

    ctx.strokeStyle = 'rgba(0,229,255,0.55)';
    ctx.lineWidth   = 1.5;

    for (let i = 0; i < N; i++) {
      const fraction = (i + 1) / N;  // 1/N, 2/N, ... N/N=1

      const radiusPx = fraction * containerR;

      const offsetX = -fraction * maxOffsetPx;
      const offsetY = 0;

      ctx.beginPath();
      ctx.arc(offsetX, offsetY, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  },

  drawAmbulance(ctx) {
    const cx = this.toCanvasX(state.ambulanceX);
    const cy = this.toCanvasY(state.ambulanceY);

    const W = AMB.WIDTH;
    const H = AMB.HEIGHT;
    const wr = AMB.WHEEL_R;

    ctx.save();
    ctx.translate(cx, cy);

    ctx.fillStyle = '#c8ccd8';
    ctx.beginPath();
    ctx.roundRect(-W/2, -H/2, W, H, 4);
    ctx.fill();

    ctx.fillStyle = '#e8eaf0';
    ctx.beginPath();
    ctx.roundRect(-W/2 + 4, -H/2 - 8, W * 0.45, 10, [3, 3, 0, 0]);
    ctx.fill();

    ctx.fillStyle = this.C.ambulanceTrim;
    ctx.fillRect(-W/2, -H/2 + H * 0.28, W, H * 0.18);

    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.roundRect(-W/2 + 6, -H/2 - 8, 7, 6, 2);
    ctx.fill();

    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.roundRect(-W/2 + 16, -H/2 - 8, 7, 6, 2);
    ctx.fill();

    ctx.fillStyle = '#1a1f2e';
    ctx.beginPath();
    ctx.arc(-W/2 + 10, H/2, wr, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(W/2 - 10, H/2, wr, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#8892a4';
    ctx.beginPath();
    ctx.arc(-W/2 + 10, H/2, wr * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(W/2 - 10, H/2, wr * 0.5, 0, Math.PI * 2);
    ctx.fill();

    if (state.sourceSpeed > 0) {
      ctx.strokeStyle = this.C.ambulanceTrim;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(W/2 + 4, 0);
      ctx.lineTo(W/2 + 12, 0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = this.C.ambulanceTrim;
      ctx.beginPath();
      ctx.moveTo(W/2 + 14, 0);
      ctx.lineTo(W/2 + 10, -3);
      ctx.lineTo(W/2 + 10, 3);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  },

  drawObservers(ctx, W, H) {
    if (!state.showObservers) return;

    const obsAx = this.toCanvasX(state.observerAX);
    const obsBx = this.toCanvasX(state.observerBX);
    const obsY  = this.toCanvasY(state.ambulanceY);

    const resA = PhysicsClient.observerFreq(state.observerAX, state.ambulanceX);
    const resB = PhysicsClient.observerFreq(state.observerBX, state.ambulanceX);
    const fAstr = isFinite(resA.freq) ? resA.freq.toFixed(1) + ' Hz' : '∞';
    const fBstr = isFinite(resB.freq) ? resB.freq.toFixed(1) + ' Hz' : '∞';

    const mode  = state.graphMode;
    const focus = state.focusObserver;

    const drawA = (mode !== 'focus') || (focus === 'ahead');
    const drawB = (mode !== 'focus') || (focus === 'behind');

    if (drawA) this.drawObserverMarker(ctx, obsAx, obsY, 'A', this.C.obsA, fAstr, resA.approaching ? 'APPROACHING' : 'RECEDING');
    if (drawB) this.drawObserverMarker(ctx, obsBx, obsY, 'B', this.C.obsB, fBstr, resB.approaching ? 'APPROACHING' : 'RECEDING');
  },

  drawObserverMarker(ctx, x, y, label, color, freqStr, tag) {
    ctx.save();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, state.canvasH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const r = 10;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;

    ctx.beginPath();
    ctx.arc(x, y - r - 8, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - r - 2);
    ctx.lineTo(x, y + r * 0.8);
    ctx.moveTo(x - r * 0.8, y - r * 0.4);
    ctx.lineTo(x + r * 0.8, y - r * 0.4);
    ctx.moveTo(x, y + r * 0.8);
    ctx.lineTo(x - r * 0.6, y + r * 1.8);
    ctx.moveTo(x, y + r * 0.8);
    ctx.lineTo(x + r * 0.6, y + r * 1.8);
    ctx.stroke();

    const boxY = y - r - 38;
    const text1 = `Obs. ${label}`;
    const text2 = freqStr;

    ctx.font = 'bold 11px "Space Mono", monospace';
    const tw = Math.max(ctx.measureText(text1).width, ctx.measureText(text2).width);
    const bw = tw + 14;
    const bh = 36;
    const bx = x - bw / 2;

    ctx.fillStyle = 'rgba(10,12,18,0.88)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(bx, boxY, bw, bh, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = '8px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(tag, x, boxY + 11);

    ctx.fillStyle = '#e8eaf0';
    ctx.font = 'bold 10px "Space Mono", monospace';
    ctx.fillText(text2, x, boxY + 28);

    ctx.restore();
  },

  drawWavelengthOverlay(ctx, W, H) {
    const now   = state.simTime;
    const V     = PHYSICS.SPEED_OF_SOUND;
    const ambCy = this.toCanvasY(state.ambulanceY);

    if (state.wavefronts.length < 2) return;

    const sorted = [...state.wavefronts].sort((a, b) => b.emittedAt - a.emittedAt);

    const measureAxis = (sign) => {
      for (let i = 0; i < sorted.length - 1; i++) {
        const wf1 = sorted[i];
        const wf2 = sorted[i + 1];
        const r1 = V * (now - wf1.emittedAt);
        const r2 = V * (now - wf2.emittedAt);
        const pt1x = wf1.x + sign * r1;
        const pt2x = wf2.x + sign * r2;
        const distM = Math.abs(pt1x - pt2x);
        if (distM > 0.1 && distM < 200) {
          return { x1: pt1x, x2: pt2x, dist: distM };
        }
      }
      return null;
    };

    const front = measureAxis(+1);
    const rear  = measureAxis(-1);

    ctx.save();
    ctx.font = 'bold 11px "Space Mono", monospace';
    ctx.textAlign = 'center';

    const drawMeasure = (pair, label, color, yOff) => {
      if (!pair) return;
      const px1 = this.toCanvasX(pair.x1);
      const px2 = this.toCanvasX(pair.x2);
      const py  = ambCy + yOff;

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);

      ctx.beginPath();
      ctx.moveTo(Math.min(px1, px2), py);
      ctx.lineTo(Math.max(px1, px2), py);
      ctx.stroke();
      ctx.setLineDash([]);

      [px1, px2].forEach(px => {
        ctx.beginPath();
        ctx.moveTo(px, py - 5);
        ctx.lineTo(px, py + 5);
        ctx.stroke();
      });

      const midX = (px1 + px2) / 2;
      ctx.fillStyle = 'rgba(10,12,18,0.8)';
      ctx.fillRect(midX - 32, py - 17, 64, 15);
      ctx.fillStyle = color;
      ctx.fillText(`${label} = ${pair.dist.toFixed(2)}m`, midX, py - 5);
    };

    drawMeasure(front, 'λ front', this.C.obsA, -40);
    drawMeasure(rear,  'λ rear',  this.C.obsB,  40);

    ctx.restore();
  },

  drawOverlay(ctx, W, H) {
    ctx.save();
    ctx.font = '10px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(72,85,104,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText(`${state.fps} fps | t = ${state.simTime.toFixed(2)}s`, W - 8, H - 6);

    // Ring count indicator (small, bottom left)
    const N = freqToRingCount(state.sourceFreq);
    ctx.textAlign = 'left';
    ctx.fillText(`rings: ${N} | f: ${state.sourceFreq} Hz`, 8, H - 6);

    const mach = PhysicsClient.cache.mach;
    if (mach >= 0.9) {
      ctx.textAlign = 'center';
      ctx.font = 'bold 11px "Space Mono", monospace';
      ctx.fillStyle = mach >= 1 ? '#ef4444' : '#f59e0b';
      ctx.fillText(
        mach >= 1 ? '⚠ MACH EXCEEDED — source at or above speed of sound' : `⚠ NEAR SONIC — Mach ${mach.toFixed(2)}`,
        W / 2, 20
      );
    }

    ctx.restore();
  },
};

/* GRAPH RENDERER */
const GraphRenderer = {

  canvas: null,
  ctx:    null,
  _layout: null,

  init(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.resize();
    this._bindTooltip();
  },

  resize() {
    const wrapper = this.canvas.parentElement;
    const w = wrapper.clientWidth - 36;
    const h = Math.round(w * 0.65);
    this.canvas.width  = Math.max(w, 180);
    this.canvas.height = Math.max(h, 120);
  },

  _bindTooltip() {
    const tooltip = document.getElementById('graph-tooltip');
    if (!tooltip) return;

    this.canvas.addEventListener('mousemove', (ev) => {
      if (!this._layout) return;
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width  / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const mx = (ev.clientX - rect.left) * scaleX;
      const my = (ev.clientY - rect.top)  * scaleY;

      const { ml, mt, gW, gH, yMin, yRange, maxVs, f, V } = this._layout;

      if (mx < ml || mx > ml + gW || my < mt || my > mt + gH) {
        tooltip.style.display = 'none';
        return;
      }

      const vs = ((mx - ml) / gW) * maxVs;
      const { freqAhead: fA, freqBehind: fB } = PhysicsClient.curveFreqAt(vs);
      const mode  = state.graphMode;
      const focus = state.focusObserver;

      let html = `<span style="color:#4a5568">Speed: </span><strong>${vs.toFixed(1)} m/s</strong><br>`;

      if (mode === 'focus') {
        if (focus === 'ahead' && fA !== null && isFinite(fA)) {
          html += `<span style="color:#00e5ff">▸ Ahead: ${fA.toFixed(1)} Hz</span>`;
        } else if (focus === 'behind') {
          html += `<span style="color:#f59e0b">▸ Behind: ${fB.toFixed(1)} Hz</span>`;
        }
      } else {
        if (fA !== null && isFinite(fA)) {
          html += `<span style="color:#00e5ff">▸ Ahead: ${fA.toFixed(1)} Hz</span><br>`;
        }
        html += `<span style="color:#f59e0b">▸ Behind: ${fB.toFixed(1)} Hz</span>`;
        if (mode === 'theory') {
          html += `<br><span style="color:#4a7060;font-size:9px">Theory matches simulation for ideal medium</span>`;
        }
      }

      tooltip.innerHTML = html;
      tooltip.style.display = 'block';

      const containerRect = this.canvas.parentElement.getBoundingClientRect();
      let left = ev.clientX - containerRect.left + 12;
      const tipW = 170;
      if (left + tipW > containerRect.width) left = ev.clientX - containerRect.left - tipW - 12;
      tooltip.style.left = left + 'px';
      tooltip.style.top  = (ev.clientY - containerRect.top - 10) + 'px';
    });

    this.canvas.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });
  },

  updateLegend() {
    const el = document.getElementById('graph-legend');
    if (!el) return;
    const mode  = state.graphMode;
    const focus = state.focusObserver;

    if (mode === 'focus') {
      if (focus === 'ahead') {
        el.innerHTML = `<span class="legend-dot legend-a"></span><span>Observer A — Ahead (simulated)</span>
                        <span class="legend-dot legend-src"></span><span>Source frequency f₀</span>`;
      } else {
        el.innerHTML = `<span class="legend-dot legend-b"></span><span>Observer B — Behind (simulated)</span>
                        <span class="legend-dot legend-src"></span><span>Source frequency f₀</span>`;
      }
    } else if (mode === 'theory') {
      el.innerHTML = `<span class="legend-dot legend-a"></span><span>Obs A simulated</span>
                      <span class="legend-dot" style="background:#00ff88"></span><span>Obs A theory</span>
                      <span class="legend-dot legend-b"></span><span>Obs B simulated</span>
                      <span class="legend-dot" style="background:#ff8c00"></span><span>Obs B theory</span>
                      <span class="legend-dot legend-src"></span><span>f₀ source</span>`;
    } else if (mode === 'velocity') {
      el.innerHTML = `<span class="legend-dot legend-a"></span><span>Ahead — f increases with v</span>
                      <span class="legend-dot legend-b"></span><span>Behind — f decreases with v</span>
                      <span class="legend-dot legend-src"></span><span>Source f₀ (no shift)</span>`;
    } else {
      el.innerHTML = `<span class="legend-dot legend-a"></span><span>Observer A (ahead)</span>
                      <span class="legend-dot legend-b"></span><span>Observer B (behind)</span>
                      <span class="legend-dot legend-src"></span><span>Source frequency</span>`;
    }
  },

  draw() {
    const ctx = this.ctx;
    const W   = this.canvas.width;
    const H   = this.canvas.height;

    const f  = state.sourceFreq;
    const V  = PHYSICS.SPEED_OF_SOUND;
    const mode   = state.graphMode;
    const focus  = state.focusObserver;

    const ml = 52, mr = 16, mt = 20, mb = 38;
    const gW = W - ml - mr;
    const gH = H - mt - mb;

    ctx.fillStyle = '#0a0c12';
    ctx.fillRect(0, 0, W, H);

    const maxVs = 100;
    let yMin = Infinity, yMax = -Infinity;
    const steps = 200;
    const curvePts = PhysicsClient.curve.points;
    for (let i = 0; i <= steps; i++) {
      const point = curvePts[i];
      if (!point) continue;
      const vs = point.vs;
      if (V - vs <= 0) continue;
      const fA = point.freqAhead;
      const fB = point.freqBehind;

      if (mode === 'focus') {
        if (focus === 'ahead'  && isFinite(fA)) { yMin = Math.min(yMin, fA); yMax = Math.max(yMax, fA); }
        if (focus === 'behind')                 { yMin = Math.min(yMin, fB); yMax = Math.max(yMax, fB); }
      } else {
        if (isFinite(fA)) { yMin = Math.min(yMin, fA); yMax = Math.max(yMax, fA); }
        yMin = Math.min(yMin, fB); yMax = Math.max(yMax, fB);
      }
    }
    yMin = Math.min(yMin, f);
    yMax = Math.max(yMax, f);
    yMin = Math.max(0,    yMin * 0.9);
    yMax = Math.min(3000, yMax * 1.1);
    const yRange = yMax - yMin || 1;

    const toX = (vs)   => ml + (vs / maxVs) * gW;
    const toY = (freq) => mt + gH - ((freq - yMin) / yRange) * gH;

    this._layout = { ml, mt, gW, gH, yMin, yRange, maxVs, f, V };

    const xSteps = 5, ySteps = 5;
    ctx.strokeStyle = '#252d42';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= xSteps; i++) {
      const x = ml + (i / xSteps) * gW;
      ctx.beginPath(); ctx.moveTo(x, mt); ctx.lineTo(x, mt + gH); ctx.stroke();
    }
    for (let j = 0; j <= ySteps; j++) {
      const y = mt + (j / ySteps) * gH;
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + gW, y); ctx.stroke();
    }

    ctx.fillStyle = '#4a5568';
    ctx.font = '9px "Space Mono", monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i <= xSteps; i++) {
      const vs = (i / xSteps) * maxVs;
      ctx.fillText(vs.toFixed(0), ml + (i / xSteps) * gW, mt + gH + 13);
    }

    ctx.fillStyle = '#8892a4';
    ctx.font = '9px "Space Mono", monospace';
    ctx.textAlign = 'center';
    const xLabel = (mode === 'velocity') ? 'Source Velocity v_s (m/s)' : 'Source Speed (m/s)';
    ctx.fillText(xLabel, ml + gW / 2, H - 4);

    ctx.fillStyle = '#4a5568';
    ctx.font = '9px "Space Mono", monospace';
    ctx.textAlign = 'right';
    for (let j = 0; j <= ySteps; j++) {
      const freq = yMin + (j / ySteps) * yRange;
      const y    = mt + gH - (j / ySteps) * gH;
      ctx.fillText(freq.toFixed(0), ml - 6, y + 3);
    }

    ctx.save();
    ctx.fillStyle = '#8892a4';
    ctx.font = '9px "Space Mono", monospace';
    ctx.translate(10, mt + gH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('Observed Frequency (Hz)', 0, 0);
    ctx.restore();

    if (mode !== 'default') {
      const modeLabels = {
        theory:   'THEORY VS SIMULATION',
        focus:    focus === 'ahead' ? 'OBSERVER FOCUS — AHEAD (A)' : 'OBSERVER FOCUS — BEHIND (B)',
        velocity: 'VELOCITY IMPACT MODE',
      };
      ctx.save();
      ctx.font = 'bold 8px "Space Mono", monospace';
      ctx.fillStyle = 'rgba(0,229,255,0.35)';
      ctx.textAlign = 'left';
      ctx.fillText(modeLabels[mode] || '', ml + 4, mt + 11);
      ctx.restore();
    }

    const drawCurve = (color, lineWidth, dashPattern, getFreq) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      if (dashPattern) ctx.setLineDash(dashPattern);
      ctx.beginPath();
      let first = true;
      for (let i = 0; i <= steps; i++) {
        const point = curvePts[i];
        if (!point) continue;
        const vs = point.vs;
        if (V - vs <= 0 && getFreq === 'ahead') break;
        const freq = (getFreq === 'ahead') ? point.freqAhead : point.freqBehind;
        if (!isFinite(freq)) break;
        const x = toX(vs);
        const y = toY(freq);
        if (y < mt - 2) { first = true; continue; }
        if (first) { ctx.moveTo(x, y); first = false; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (dashPattern) ctx.setLineDash([]);
      ctx.restore();
    };

    if (mode === 'focus') {
      if (focus === 'ahead') {
        drawCurve('#00e5ff', 2.2, null, 'ahead');
      } else {
        drawCurve('#f59e0b', 2.2, null, 'behind');
      }
    } else if (mode === 'theory') {
      drawCurve('#00e5ff', 1.6, null,   'ahead');
      drawCurve('#f59e0b', 1.6, null,   'behind');
      drawCurve('#00ff88', 1.4, [5, 3], 'ahead');
      drawCurve('#ff8c00', 1.4, [5, 3], 'behind');

      ctx.save();
      ctx.font = '8px "Space Mono", monospace';
      ctx.fillStyle = 'rgba(0,255,136,0.45)';
      ctx.textAlign = 'right';
      ctx.fillText('theory ≡ simulation in ideal medium', ml + gW - 4, mt + gH - 6);
      ctx.restore();
    } else {
      drawCurve('#00e5ff', 1.8, null, 'ahead');
      drawCurve('#f59e0b', 1.8, null, 'behind');
    }

    ctx.save();
    ctx.strokeStyle = '#8b5cf6';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    const srcY = toY(f);
    if (srcY >= mt && srcY <= mt + gH) {
      ctx.moveTo(ml, srcY);
      ctx.lineTo(ml + gW, srcY);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();

    const curX = toX(state.sourceSpeed);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(curX, mt);
    ctx.lineTo(curX, mt + gH);
    ctx.stroke();
    ctx.setLineDash([]);

    const fACur = PhysicsClient.cache.freqAhead;
    const fBCur = PhysicsClient.cache.freqBehind;

    const showA = (mode !== 'focus') || (focus === 'ahead');
    const showB = (mode !== 'focus') || (focus === 'behind');

    if (showA && isFinite(fACur)) {
      const dotY = toY(fACur);
      if (dotY >= mt && dotY <= mt + gH) {
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath();
        ctx.arc(curX, dotY, 4, 0, Math.PI * 2);
        ctx.fill();
        if (mode === 'theory') {
          ctx.strokeStyle = '#00ff88';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(curX, dotY, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    if (showB) {
      const dotYB = toY(fBCur);
      if (dotYB >= mt && dotYB <= mt + gH) {
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(curX, dotYB, 4, 0, Math.PI * 2);
        ctx.fill();
        if (mode === 'theory') {
          ctx.strokeStyle = '#ff8c00';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(curX, dotYB, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    ctx.restore();

    if (mode === 'velocity') {
      ctx.save();
      ctx.font = '8px "Space Mono", monospace';
      ctx.fillStyle = 'rgba(0,229,255,0.55)';
      ctx.textAlign = 'left';
      ctx.fillText('↑ higher observed f', ml + gW * 0.55, mt + 14);
      ctx.fillStyle = 'rgba(245,158,11,0.55)';
      ctx.fillText('↓ lower observed f', ml + gW * 0.55, mt + gH - 8);
      ctx.restore();
    }

    ctx.strokeStyle = '#2e3854';
    ctx.lineWidth = 1;
    ctx.strokeRect(ml, mt, gW, gH);

    this.updateLegend();
  },
};

/* AUDIO ENGINE — optional Doppler tone demonstration (default OFF) */
const AudioEngine = {

  ctx:      null,
  osc:      null,
  gain:     null,
  enabled:  false,
  observer: 'A',   // which observer's perceived tone is played: 'A' or 'B'

  MIN_HZ: 60,
  MAX_HZ: 3000,

  start() {
    if (this.enabled) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();

      this.osc  = this.ctx.createOscillator();
      this.gain = this.ctx.createGain();

      this.osc.type = 'sine';
      this.gain.gain.value = 0.12;

      this.osc.connect(this.gain);
      this.gain.connect(this.ctx.destination);

      this.osc.frequency.value = this._clampedFreq();
      this.osc.start();

      this.enabled = true;
    } catch (err) {
      this.enabled = false;
    }
  },

  stop() {
    if (!this.enabled) return;
    try {
      if (this.osc) {
        this.osc.stop();
        this.osc.disconnect();
      }
      if (this.gain) this.gain.disconnect();
    } catch (err) { /* already stopped */ }
    this.osc  = null;
    this.gain = null;
    this.enabled = false;
  },

  setObserver(obs) {
    this.observer = (obs === 'B') ? 'B' : 'A';
    this.update();
  },

  _rawFreq() {
    const observerX = (this.observer === 'B') ? state.observerBX : state.observerAX;
    const res = PhysicsClient.observerFreq(observerX, state.ambulanceX);
    return res.freq;
  },

  _clampedFreq() {
    const f = this._rawFreq();
    const safe = isFinite(f) ? f : this.MAX_HZ;
    return Math.max(this.MIN_HZ, Math.min(this.MAX_HZ, safe));
  },

  // Called whenever frequency, speed, or the source/observer relationship
  // changes. Cheap (a single param ramp), so it does not affect animation
  // performance.
  update() {
    if (!this.enabled || !this.osc || !this.ctx) return;
    const target = this._clampedFreq();
    this.osc.frequency.setTargetAtTime(target, this.ctx.currentTime, 0.05);
  },
};

/* UI CONTROLLER */
const UIController = {

  els: {},

  init() {
    const id = (x) => document.getElementById(x);

    this.els = {
      canvas:       id('sim-canvas'),
      graphCanvas:  id('graph-canvas'),
      btnPlayPause: id('btn-playpause'),
      btnReset:     id('btn-reset'),

      slFreq:       id('sl-frequency'),
      slSpeed:      id('sl-speed'),
      slAnimSpeed:  id('sl-animspeed'),

      valFreq:      id('val-frequency'),
      valSpeed:     id('val-speed'),
      valAnimSpeed: id('val-animspeed'),

      dSrcFreq:     id('d-src-freq'),
      dSrcSpeed:    id('d-src-speed'),
      dSoundSpeed:  id('d-sound-speed'),
      dMach:        id('d-mach'),
      dFreqA:       id('d-freq-a'),
      dFreqB:       id('d-freq-b'),
      dWaveA:       id('d-wave-a'),
      dWaveB:       id('d-wave-b'),
      dShiftA:      id('d-shift-a'),
      dShiftB:      id('d-shift-b'),

      wlSource:     id('wl-source'),
      wlFront:      id('wl-front'),
      wlRear:       id('wl-rear'),

      wlBarFront:      id('wl-bar-front'),
      wlBarSource:     id('wl-bar-source'),
      wlBarRear:       id('wl-bar-rear'),
      wlBarFrontVal:   id('wl-bar-front-val'),
      wlBarSourceVal:  id('wl-bar-source-val'),
      wlBarRearVal:    id('wl-bar-rear-val'),

      equationsBox: id('equations-box'),
      eqLiveA:      id('eq-live-a'),
      eqLiveB:      id('eq-live-b'),

      graphPanel:   id('graph-panel'),

      chkLabels:    id('chk-labels'),
      chkWavelength:id('chk-wavelength'),
      chkObservers: id('chk-observers'),
      chkEquations: id('chk-equations'),
      chkGraph:     id('chk-graph'),

      fpsDisplay:   id('fps-display'),
      statusDisplay:id('status-display'),

      helpBtn:      id('help-btn'),
      helpTooltip:  id('help-tooltip'),

      gmodeDefault:  id('gmode-default'),
      gmodeTheory:   id('gmode-theory'),
      gmodeFocus:    id('gmode-focus'),
      gmodeVelocity: id('gmode-velocity'),

      observerFocusBar: id('observer-focus-bar'),
      ofocusAhead:      id('ofocus-ahead'),
      ofocusBehind:     id('ofocus-behind'),

      obsCardA: id('obs-card-a'),
      obsCardB: id('obs-card-b'),
      obsTagA:  id('obs-tag-a'),
      obsTagB:  id('obs-tag-b'),
      obsReadingsContainer: id('observer-readings-container'),

      chkAudio:         id('chk-audio'),
      selAudioObserver: id('sel-audio-observer'),

      btnFullscreen:  id('btn-fullscreen'),
      btnScreenshot:  id('btn-screenshot'),
      btnCompare:     id('btn-compare'),
      btnLearn:       id('btn-learn'),

      fsBtnPlayPause: id('fs-btn-playpause'),
      fsBtnScreenshot:id('fs-btn-screenshot'),
      fsBtnCompare:   id('fs-btn-compare'),
      fsBtnExit:      id('fs-btn-exit'),
    };

    this.bindEvents();
  },

  bindEvents() {
    const e = this.els;

    e.btnPlayPause.addEventListener('click', () => {
      if (state.running) {
        SimulationController.pause();
      } else {
        SimulationController.play();
      }
    });

    e.btnReset.addEventListener('click', () => SimulationController.reset());

    e.slFreq.addEventListener('input', () => {
      state.sourceFreq = parseFloat(e.slFreq.value);
      e.valFreq.textContent = state.sourceFreq + ' Hz';
      state._graphDirty = true;
      PhysicsClient.onParamsChanged(state.sourceFreq, state.sourceSpeed);
      PhysicsClient.onFrequencyChanged(state.sourceFreq);
      this.updateDataPanel();
      AudioEngine.update();
    });

    e.slSpeed.addEventListener('input', () => {
      state.sourceSpeed = parseFloat(e.slSpeed.value);
      e.valSpeed.textContent = state.sourceSpeed + ' m/s';
      state._graphDirty = true;
      PhysicsClient.onParamsChanged(state.sourceFreq, state.sourceSpeed);
      this.updateDataPanel();
      AudioEngine.update();
    });

    e.slAnimSpeed.addEventListener('input', () => {
      state.animSpeed = parseFloat(e.slAnimSpeed.value);
      e.valAnimSpeed.textContent = state.animSpeed.toFixed(2) + '×';
    });

    e.chkLabels.addEventListener('change',    () => { state.showLabels     = e.chkLabels.checked; });
    e.chkWavelength.addEventListener('change',() => { state.showWavelength = e.chkWavelength.checked; });
    e.chkObservers.addEventListener('change', () => { state.showObservers  = e.chkObservers.checked; });
    e.chkEquations.addEventListener('change', () => {
      state.showEquations = e.chkEquations.checked;
      e.equationsBox.style.display = state.showEquations ? '' : 'none';
    });
    e.chkGraph.addEventListener('change', () => {
      state.showGraph = e.chkGraph.checked;
      e.graphPanel.style.display = state.showGraph ? '' : 'none';
    });

    if (e.chkAudio) {
      e.chkAudio.addEventListener('change', () => {
        if (e.chkAudio.checked) {
          AudioEngine.start();
        } else {
          AudioEngine.stop();
        }
        if (e.selAudioObserver) {
          e.selAudioObserver.style.display = e.chkAudio.checked ? '' : 'none';
        }
      });
    }

    if (e.selAudioObserver) {
      e.selAudioObserver.addEventListener('change', () => {
        AudioEngine.setObserver(e.selAudioObserver.value);
      });
    }

    e.helpBtn.addEventListener('click', () => {
      e.helpTooltip.classList.toggle('visible');
    });
    document.addEventListener('click', (ev) => {
      if (!e.helpBtn.contains(ev.target) && !e.helpTooltip.contains(ev.target)) {
        e.helpTooltip.classList.remove('visible');
      }
    });

    let _resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        Renderer.resize();
        GraphRenderer.resize();
        state._graphDirty = true;
        SimulationController.initObservers();
      }, 120);
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.target.tagName === 'INPUT') return;
      switch(ev.code) {
        case 'Space':
          ev.preventDefault();
          state.running ? SimulationController.pause() : SimulationController.play();
          break;
        case 'KeyR':
          SimulationController.reset();
          break;
        case 'Escape':
          if (state.isFullscreen) {
            FullscreenManager.exit();
          } else {
            LearnMode.close();
            CompareManager.closeModal();
          }
          break;
      }
    });

    const modeButtons = [e.gmodeDefault, e.gmodeTheory, e.gmodeFocus, e.gmodeVelocity];
    modeButtons.forEach(btn => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        this.setGraphMode(btn.dataset.mode);
      });
    });

    [e.ofocusAhead, e.ofocusBehind].forEach(btn => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        const obs = btn.dataset.obs;
        state.focusObserver = obs;
        e.ofocusAhead.classList.toggle('active',  obs === 'ahead');
        e.ofocusBehind.classList.toggle('active', obs === 'behind');
        this.updateObserverFocusPanel();
        state._graphDirty = true;
      });
    });

    if (e.btnScreenshot) {
      e.btnScreenshot.addEventListener('click', () => ScreenshotExporter.capture());
    }
    if (e.btnFullscreen) {
      e.btnFullscreen.addEventListener('click', () => FullscreenManager.toggle());
    }
    if (e.btnCompare) {
      e.btnCompare.addEventListener('click', () => CompareManager.openModal());
    }
    if (e.btnLearn) {
      e.btnLearn.addEventListener('click', () => {
        if (!state.isFullscreen) LearnMode.open();
      });
    }

    if (e.fsBtnPlayPause) {
      e.fsBtnPlayPause.addEventListener('click', () => {
        if (state.running) {
          SimulationController.pause();
        } else {
          SimulationController.play();
        }
      });
    }
    if (e.fsBtnScreenshot) {
      e.fsBtnScreenshot.addEventListener('click', () => ScreenshotExporter.capture());
    }
    if (e.fsBtnCompare) {
      e.fsBtnCompare.addEventListener('click', () => CompareManager.openModal());
    }
    if (e.fsBtnExit) {
      e.fsBtnExit.addEventListener('click', () => FullscreenManager.exit());
    }
  },

  setGraphMode(newMode) {
    const e = this.els;
    state.graphMode = newMode;

    const allBtns = [e.gmodeDefault, e.gmodeTheory, e.gmodeFocus, e.gmodeVelocity];
    allBtns.forEach(btn => {
      if (!btn) return;
      btn.classList.toggle('active', btn.dataset.mode === newMode);
    });

    const showFocusBar = (newMode === 'focus');
    if (e.observerFocusBar) {
      e.observerFocusBar.style.display = showFocusBar ? 'flex' : 'none';
    }

    this.updateObserverFocusPanel();
    state._graphDirty = true;
  },

  updateObserverFocusPanel() {
    const e = this.els;
    if (!e.obsCardA || !e.obsCardB) return;

    const mode  = state.graphMode;
    const focus = state.focusObserver;

    if (mode === 'focus') {
      e.obsCardA.style.display = (focus === 'ahead')  ? '' : 'none';
      e.obsCardB.style.display = (focus === 'behind') ? '' : 'none';
      if (e.obsReadingsContainer) e.obsReadingsContainer.classList.add('single-col');
    } else {
      e.obsCardA.style.display = '';
      e.obsCardB.style.display = '';
      if (e.obsReadingsContainer) e.obsReadingsContainer.classList.remove('single-col');
    }
  },

  updatePlayPauseBtn() {
    const mainBtn = this.els.btnPlayPause;
    const fsBtn   = this.els.fsBtnPlayPause;
    const label   = state.running ? '⏸ Pause' : '▶ Play';
    if (mainBtn) mainBtn.textContent = label;
    if (fsBtn)   fsBtn.textContent   = label;
  },

  updateDataPanel() {
    const f  = state.sourceFreq;
    const vs = state.sourceSpeed;
    const V  = PHYSICS.SPEED_OF_SOUND;

    const resA = PhysicsClient.observerFreq(state.observerAX, state.ambulanceX);
    const resB = PhysicsClient.observerFreq(state.observerBX, state.ambulanceX);
    const fA = resA.freq;
    const fB = resB.freq;
    const fAstr = isFinite(fA) ? fA.toFixed(1) : '∞';
    const fBstr = isFinite(fB) ? fB.toFixed(1) : '∞';

    const cache = PhysicsClient.cache;
    const wA = isFinite(fA) ? (resA.approaching ? cache.wavelengthAhead : cache.wavelengthBehind).toFixed(4) : '—';
    const wB = isFinite(fB) ? (resB.approaching ? cache.wavelengthAhead : cache.wavelengthBehind).toFixed(4) : '—';

    const shiftA = isFinite(fA) ? fA - f : Infinity;
    const shiftB = isFinite(fB) ? fB - f : Infinity;

    const mach   = cache.mach;
    const lSrc   = cache.lambdaSource;
    const lFront = cache.lambdaFront;
    const lRear  = cache.lambdaRear;

    const e = this.els;

    e.dSrcFreq.textContent    = f + ' Hz';
    e.dSrcSpeed.textContent   = vs + ' m/s';
    e.dSoundSpeed.textContent = V + ' m/s';
    e.dMach.textContent       = mach.toFixed(3);

    e.dFreqA.textContent = fAstr + ' Hz';
    e.dFreqB.textContent = fBstr + ' Hz';
    e.dWaveA.textContent = wA + ' m';
    e.dWaveB.textContent = wB + ' m';

    e.dShiftA.textContent = (isFinite(shiftA) ? (shiftA >= 0 ? '+' : '') + shiftA.toFixed(1) : '+∞') + ' Hz';
    e.dShiftB.textContent = (isFinite(shiftB) ? (shiftB >= 0 ? '+' : '') + shiftB.toFixed(1) : '+∞') + ' Hz';

    // Shift value colour reflects direction of the shift, not a fixed observer identity
    e.dShiftA.classList.toggle('shift-up',   !isFinite(shiftA) || shiftA >= 0);
    e.dShiftA.classList.toggle('shift-down', isFinite(shiftA) && shiftA < 0);
    e.dShiftB.classList.toggle('shift-up',   !isFinite(shiftB) || shiftB >= 0);
    e.dShiftB.classList.toggle('shift-down', isFinite(shiftB) && shiftB < 0);

    // Observer tags update dynamically based on whether the source has passed each observer
    if (e.obsTagA) e.obsTagA.textContent = resA.approaching ? 'APPROACHING' : 'RECEDING';
    if (e.obsTagB) e.obsTagB.textContent = resB.approaching ? 'APPROACHING' : 'RECEDING';

    e.wlSource.textContent = lSrc.toFixed(4) + ' m';
    e.wlFront.textContent  = V - vs > 0 ? lFront.toFixed(4) + ' m' : '—';
    e.wlRear.textContent   = lRear.toFixed(4) + ' m';

    const maxLambda = Math.max(lSrc, lFront, lRear, 0.001);
    const pctFront  = lFront > 0 ? Math.min(Math.round((lFront / maxLambda) * 1000) / 10, 100) : 0;
    const pctSource = Math.min(Math.round((lSrc  / maxLambda) * 1000) / 10, 100);
    const pctRear   = Math.min(Math.round((lRear / maxLambda) * 1000) / 10, 100);

    if (e.wlBarFront && pctFront !== state._lastWlFrontPct) {
      e.wlBarFront.style.width = pctFront + '%';
      state._lastWlFrontPct = pctFront;
    }
    if (e.wlBarSource && pctSource !== state._lastWlSourcePct) {
      e.wlBarSource.style.width = pctSource + '%';
      state._lastWlSourcePct = pctSource;
    }
    if (e.wlBarRear && pctRear !== state._lastWlRearPct) {
      e.wlBarRear.style.width = pctRear + '%';
      state._lastWlRearPct = pctRear;
    }

    if (e.wlBarFrontVal)  e.wlBarFrontVal.textContent  = V - vs > 0 ? lFront.toFixed(3) + ' m' : '—';
    if (e.wlBarSourceVal) e.wlBarSourceVal.textContent = lSrc.toFixed(3) + ' m';
    if (e.wlBarRearVal)   e.wlBarRearVal.textContent   = lRear.toFixed(3) + ' m';

    // v_o = 0 (observers are stationary) — kept explicit in the displayed
    // equation per the formula sheet's full f_o = f_s(v ± v_o) ÷ (v ∓ v_s)
    const vo = 0;
    const voSignA = resA.approaching ? '+' : '−';
    const vsSignA = resA.approaching ? '−' : '+';
    const voSignB = resB.approaching ? '+' : '−';
    const vsSignB = resB.approaching ? '−' : '+';

    const eqAStr = `f<sub>A</sub> = ${f} × (${V} ${voSignA} ${vo}) ÷ (${V} ${vsSignA} ${vs})`;
    const eqBStr = `f<sub>B</sub> = ${f} × (${V} ${voSignB} ${vo}) ÷ (${V} ${vsSignB} ${vs})`;

    e.eqLiveA.innerHTML = isFinite(fA)
      ? `${eqAStr} = <strong>${fAstr} Hz</strong>`
      : `${eqAStr} = <strong>∞ (sonic)</strong>`;
    e.eqLiveB.innerHTML = isFinite(fB)
      ? `${eqBStr} = <strong>${fBstr} Hz</strong>`
      : `${eqBStr} = <strong>∞ (sonic)</strong>`;

    e.fpsDisplay.textContent = state.fps + ' FPS';

    AudioEngine.update();
  },

  setStatus(running) {
    const e = this.els;
    e.statusDisplay.textContent = running ? 'RUNNING' : 'PAUSED';
    e.statusDisplay.style.color         = running ? '#10b981' : '#f59e0b';
    e.statusDisplay.style.borderColor   = running ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)';
    e.statusDisplay.style.background    = running ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.08)';
    this.updatePlayPauseBtn();
  },
};

/* SIMULATION CONTROLLER */
const SimulationController = {

  initObservers() {
    const halfW = (state.canvasW / 2) / SIM_SCALE;
    state.observerAX =  halfW * 0.72;
    state.observerBX = -halfW * 0.72;
  },

  init() {
    Renderer.init(UIController.els.canvas);
    GraphRenderer.init(UIController.els.graphCanvas);

    const halfW = (state.canvasW / 2) / SIM_SCALE;
    state.ambulanceX = -halfW + 40;
    state.ambulanceY = 0;

    this.initObservers();
    UIController.updateDataPanel();
    UIController.updatePlayPauseBtn();
  },

  play() {
    state.running     = true;
    state.lastTimestamp = null;
    UIController.setStatus(true);
  },

  pause() {
    state.running = false;
    UIController.setStatus(false);
  },

  reset() {
    state.running       = false;
    state.simTime       = 0;
    state.lastEmitTime  = 0;
    state.emitCount     = 0;
    state.wavefronts    = [];
    state.lastTimestamp = null;
    state.frameCount    = 0;
    state.fpsTimer      = 0;
    state._frameN       = 0;
    state._graphDirty   = true;

    const halfW = (state.canvasW / 2) / SIM_SCALE;
    state.ambulanceX = -halfW + 40;
    state.ambulanceY = 0;

    this.initObservers();
    UIController.updateDataPanel();
    UIController.setStatus(false);

    Renderer.draw();
    GraphRenderer.draw();
  },

  update(dtReal) {
    if (!state.running) return;

    const dt = dtReal * state.animSpeed;
    state.simTime += dt;

    state.ambulanceX += state.sourceSpeed * dt;

    const halfW = (state.canvasW / 2) / SIM_SCALE;
    if (state.ambulanceX > halfW + 60) {
      state.ambulanceX = -halfW - 60;
      state.wavefronts = [];
      state.lastEmitTime = state.simTime;
    }

    // Keep emit logic for data-panel wavelength overlay compatibility
    const emitPeriod = 1 / state.sourceFreq;
    while (state.simTime - state.lastEmitTime >= emitPeriod) {
      state.lastEmitTime += emitPeriod;
      state.wavefronts.push({
        x:         state.ambulanceX,
        y:         state.ambulanceY,
        emittedAt: state.lastEmitTime,
        id:        ++state.emitCount,
      });
    }

    const maxRadiusM = (Math.max(state.canvasW, state.canvasH) / SIM_SCALE);
    state.wavefronts = state.wavefronts.filter(wf => {
      const r = PHYSICS.SPEED_OF_SOUND * (state.simTime - wf.emittedAt);
      return r < maxRadiusM;
    });

    if (state.wavefronts.length > WAVEFRONT_MAX) {
      state.wavefronts = state.wavefronts.slice(state.wavefronts.length - WAVEFRONT_MAX);
    }

    state.frameCount++;
    state.fpsTimer += dtReal;
    if (state.fpsTimer >= 1.0) {
      state.fps = Math.round(state.frameCount / state.fpsTimer);
      state.frameCount = 0;
      state.fpsTimer   = 0;
      UIController.els.fpsDisplay.textContent = state.fps + ' FPS';
    }
  },
};

/* ANIMATION LOOP */
const AnimationLoop = {

  rafId: null,

  start() {
    const loop = (timestamp) => {
      if (state.lastTimestamp === null) {
        state.lastTimestamp = timestamp;
      }

      const dtMs   = timestamp - state.lastTimestamp;
      const dtSec  = Math.min(dtMs / 1000, 0.05);
      state.lastTimestamp = timestamp;

      state._frameN++;

      SimulationController.update(dtSec);

      Renderer.draw();

      if (state.showGraph && (state._graphDirty || state._frameN % 5 === 0)) {
        GraphRenderer.draw();
        state._graphDirty = false;
      }

      if (state._frameN % 6 === 0) {
        UIController.updateDataPanel();
      }

      this.rafId = requestAnimationFrame(loop);
    };

    this.rafId = requestAnimationFrame(loop);
  },

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
  },
};

/* SCREENSHOT EXPORTER */
const ScreenshotExporter = {

  capture() {
    const src = Renderer.canvas;

    const scale = 2;
    const offscreen = document.createElement('canvas');
    offscreen.width  = src.width  * scale;
    offscreen.height = src.height * scale;
    const octx = offscreen.getContext('2d');

    octx.imageSmoothingEnabled = false;
    octx.scale(scale, scale);
    octx.drawImage(src, 0, 0);

    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.fillStyle = 'rgba(10,12,18,0.78)';
    octx.fillRect(0, offscreen.height - 36, offscreen.width, 36);
    octx.font = `bold ${12 * scale}px "Space Mono", monospace`;
    octx.fillStyle = '#8892a4';
    octx.textAlign = 'left';
    octx.fillText(
      `f₀=${state.sourceFreq}Hz  v_s=${state.sourceSpeed}m/s  t=${state.simTime.toFixed(2)}s`,
      12 * scale,
      offscreen.height - 10 * scale
    );
    octx.textAlign = 'right';
    octx.fillStyle = '#4a5568';
    octx.fillText('Doppler Effect Simulator', offscreen.width - 12 * scale, offscreen.height - 10 * scale);

    try {
      const dataURL = offscreen.toDataURL('image/png');
      const a = document.createElement('a');
      a.href     = dataURL;
      a.download = `Physics Doppler Effect Simulation Tool - f${state.sourceFreq}_v${state.sourceSpeed}_t${state.simTime.toFixed(1)}.png`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.warn('Screenshot download failed, opening in tab:', err);
      const dataURL = offscreen.toDataURL('image/png');
      window.open(dataURL, '_blank');
    }
  },
};

/* FULLSCREEN MANAGER */
const FullscreenManager = {

  _active: false,

  init() {
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this._active) {
        this._deactivate();
      }
    });
  },

  toggle() {
    this._active ? this.exit() : this.enter();
  },

  enter() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (!wrapper) return;

    if (wrapper.requestFullscreen) {
      wrapper.requestFullscreen().then(() => {
        this._activate(wrapper);
      }).catch(() => {
        this._activate(wrapper);
      });
    } else {
      this._activate(wrapper);
    }
  },

  _activate(wrapper) {
    wrapper.classList.add('is-fullscreen');
    document.body.classList.add('is-fullscreen');
    this._active = true;
    state.isFullscreen = true;

    const btn = document.getElementById('btn-fullscreen');
    if (btn) btn.textContent = '⛶ Exit Fullscreen';

    const learnBtn = document.getElementById('btn-learn');
    if (learnBtn) {
      learnBtn.style.opacity = '0.3';
      learnBtn.style.pointerEvents = 'none';
      learnBtn.title = 'Learning Mode is not available in fullscreen';
    }

    LearnMode.close();

    requestAnimationFrame(() => {
      setTimeout(() => {
        Renderer.resize();
        SimulationController.initObservers();
      }, 80);
    });
  },

  exit() {
    if (!this._active) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    this._deactivate();
  },

  _deactivate() {
    const wrapper = document.getElementById('canvas-wrapper');
    if (wrapper) wrapper.classList.remove('is-fullscreen');
    document.body.classList.remove('is-fullscreen');
    this._active = false;
    state.isFullscreen = false;

    const btn = document.getElementById('btn-fullscreen');
    if (btn) btn.textContent = '⛶ Fullscreen';

    const learnBtn = document.getElementById('btn-learn');
    if (learnBtn) {
      learnBtn.style.opacity = '';
      learnBtn.style.pointerEvents = '';
      learnBtn.title = '';
    }

    requestAnimationFrame(() => {
      setTimeout(() => {
        Renderer.resize();
        SimulationController.initObservers();
        state._graphDirty = true;
      }, 80);
    });
  },
};

/* COMPARE MANAGER */
const CompareManager = {

  _snapshots: [],
  MAX: 4,
  _wasRunning: false,

  openModal() {
    this._wasRunning = state.running;
    if (state.running) SimulationController.pause();
    const modal = document.getElementById('compare-modal');
    if (modal) modal.style.display = 'flex';
    this._renderGrid();
  },

  closeModal() {
    const modal = document.getElementById('compare-modal');
    if (modal) modal.style.display = 'none';
    if (this._wasRunning) SimulationController.play();
  },

  // Bypasses the debounced cache and asks the backend for a guaranteed
  // fresh value at the exact moment the user clicks "Save Current State".
  async saveSnapshot() {
    if (this._snapshots.length >= this.MAX) {
      this._snapshots.shift();
    }

    const f  = state.sourceFreq;
    const vs = state.sourceSpeed;
    const result = await PhysicsClient.fetchFresh(f, vs);
    const fA = result.freqAhead;
    const fB = result.freqBehind;
    const lFront = result.lambdaFront;
    const lRear  = result.lambdaRear;

    const imageDataURL = Renderer.canvas.toDataURL('image/png');

    this._snapshots.push({
      imageDataURL,
      speed: vs,
      freq:  f,
      fA:    isFinite(fA) ? fA : null,
      fB,
      lFront,
      lRear,
      time:  state.simTime,
      id:    Date.now(),
    });

    this._renderGrid();
  },

  deleteSnapshot(id) {
    this._snapshots = this._snapshots.filter(s => s.id !== id);
    this._renderGrid();
  },

  clearAll() {
    this._snapshots = [];
    this._renderGrid();
  },

  _renderGrid() {
    const grid  = document.getElementById('compare-grid');
    const empty = document.getElementById('compare-empty');
    if (!grid) return;

    Array.from(grid.querySelectorAll('.snapshot-card')).forEach(c => c.remove());

    if (this._snapshots.length === 0) {
      if (empty) empty.style.display = '';
      return;
    }

    if (empty) empty.style.display = 'none';

    this._snapshots.forEach(snap => {
      const card = document.createElement('div');
      card.className = 'snapshot-card';
      card.dataset.snapId = snap.id;

      const fAstr    = snap.fA !== null ? snap.fA.toFixed(1) + ' Hz' : '—';
      const fBstr    = snap.fB.toFixed(1) + ' Hz';
      const lFstr    = snap.lFront > 0 ? snap.lFront.toFixed(3) + ' m' : '—';
      const lRstr    = snap.lRear.toFixed(3) + ' m';

      card.innerHTML = `
        <div class="snapshot-card-header">
          <span class="snapshot-speed-badge">${snap.speed} m/s</span>
          <button class="snapshot-delete" aria-label="Delete snapshot" data-id="${snap.id}">✕</button>
        </div>
        <div class="snapshot-canvas-wrap">
          <img src="${snap.imageDataURL}" alt="Snapshot at ${snap.speed} m/s" style="width:100%;display:block;" />
        </div>
        <div class="snapshot-stats">
          <div class="snapshot-stat-row">
            <span class="snapshot-stat-label">f₀</span>
            <span class="snapshot-stat-val">${snap.freq} Hz</span>
          </div>
          <div class="snapshot-stat-row">
            <span class="snapshot-stat-label">f ahead (A)</span>
            <span class="snapshot-stat-val ahead-val">${fAstr}</span>
          </div>
          <div class="snapshot-stat-row">
            <span class="snapshot-stat-label">f behind (B)</span>
            <span class="snapshot-stat-val behind-val">${fBstr}</span>
          </div>
          <div class="snapshot-stat-row">
            <span class="snapshot-stat-label">λ front</span>
            <span class="snapshot-stat-val">${lFstr}</span>
          </div>
          <div class="snapshot-stat-row">
            <span class="snapshot-stat-label">λ rear</span>
            <span class="snapshot-stat-val">${lRstr}</span>
          </div>
        </div>`;

      card.querySelector('.snapshot-delete').addEventListener('click', (ev) => {
        const id = parseInt(ev.currentTarget.dataset.id, 10);
        this.deleteSnapshot(id);
      });

      grid.appendChild(card);
    });

    const title = document.querySelector('#compare-modal .modal-title');
    if (title) {
      title.textContent = `⊞ Compare Panel (${this._snapshots.length}/${this.MAX})`;
    }
  },

  init() {
    const modal = document.getElementById('compare-modal');
    if (modal && modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }

    const closeBtn = document.getElementById('compare-close');
    const saveBtn  = document.getElementById('btn-save-snapshot');
    const clearBtn = document.getElementById('btn-clear-snapshots');
    const overlay  = document.getElementById('compare-modal');

    if (closeBtn) closeBtn.addEventListener('click', () => this.closeModal());
    if (saveBtn)  saveBtn.addEventListener('click',  () => this.saveSnapshot());
    if (clearBtn) clearBtn.addEventListener('click', () => this.clearAll());

    if (overlay) {
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) this.closeModal();
      });
    }
  },
};

/* LEARN MODE */
const LearnMode = {

  _currentStep: 0,
  _open: false,

  STEPS: [
    {
      title: 'Step 1 — Stationary Source',
      body:  'When the ambulance is not moving (v_s = 0 m/s), it emits wavefronts at a constant rate in all directions. Each ring expands outward from the same central point, so the wavefronts are <strong>evenly spaced</strong> all around. Both observers hear the same frequency as the source.',
      formula: 'f_obs = f₀  (when v_s = 0)',
      hint: 'Try setting Source Speed to 0 m/s to see perfectly symmetric rings.',
    },
    {
      title: 'Step 2 — Source Begins Moving',
      body:  'As the ambulance accelerates, each new wavefront is emitted from a position <em>slightly ahead</em> of the previous one. The centre of each circle is fixed at its emission point — the source moves on, but the rings do not follow it.',
      formula: 'λ_front = (v − v_s) / f',
      hint: 'Set Source Speed to ~15 m/s and watch the rings shift asymmetrically.',
    },
    {
      title: 'Step 3 — Compression Ahead',
      body:  'Ahead of the source, successive wavefronts are emitted closer together in space. This <strong>compresses</strong> the wavelength in the forward direction. Observer A (ahead) encounters wave crests more frequently — the pitch sounds <em>higher</em>.',
      formula: 'f_A = f · v ÷ (v − v_s)',
      hint: 'Notice how the cyan rings are bunched tightly ahead of the ambulance.',
    },
    {
      title: 'Step 4 — Expansion Behind',
      body:  'Behind the source, each wavefront is emitted from a position further back, <strong>stretching</strong> the wavelength. Observer B (behind) encounters crests less frequently — the pitch sounds <em>lower</em>.',
      formula: 'f_B = f · v ÷ (v + v_s)',
      hint: 'Observer B always reads a lower frequency than the source. Watch the Δf shift in the data panel.',
    },
    {
      title: 'Step 5 — The Doppler Formula',
      body:  'The Doppler Effect is described by a single elegant relationship. As source speed increases toward the speed of sound (343 m/s, Mach 1), the observed frequency ahead approaches infinity. This is called the "sonic barrier." Try dragging the speed slider toward 100 m/s to see both frequencies diverge.',
      formula: 'f_obs = f · v ÷ (v ± v_s)',
      hint: 'Use the Graph panel → "Velocity Impact" mode to visualise frequency vs speed.',
    },
  ],

  open() {
    if (state.isFullscreen) return;
    if (this._open) { this.close(); return; }
    this._open = true;
    this._currentStep = 0;
    const overlay = document.getElementById('learn-overlay');
    if (overlay) overlay.style.display = 'flex';
    this._render();
  },

  close() {
    this._open = false;
    const overlay = document.getElementById('learn-overlay');
    if (overlay) overlay.style.display = 'none';
  },

  _render() {
    const step  = this.STEPS[this._currentStep];
    const total = this.STEPS.length;

    const fill = document.getElementById('learn-progress-fill');
    if (fill) fill.style.width = ((this._currentStep + 1) / total * 100) + '%';

    const counter = document.getElementById('learn-step-counter');
    if (counter) counter.textContent = `Step ${this._currentStep + 1} of ${total}`;

    const content = document.getElementById('learn-content');
    if (content) {
      content.innerHTML = `
        <div class="learn-step-title">${step.title}</div>
        <div class="learn-step-body">${step.body}</div>
        ${step.formula ? `<div class="learn-step-formula">${step.formula}</div>` : ''}
        ${step.hint ? `<div class="learn-step-body" style="margin-top:8px;font-size:12px;color:#4a5568">💡 ${step.hint}</div>` : ''}
      `;
    }

    const dotsEl = document.getElementById('learn-dots');
    if (dotsEl) {
      dotsEl.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const dot = document.createElement('button');
        dot.className = 'learn-dot' + (i === this._currentStep ? ' active' : '');
        dot.setAttribute('aria-label', `Go to step ${i + 1}`);
        dot.addEventListener('click', () => { this._currentStep = i; this._render(); });
        dotsEl.appendChild(dot);
      }
    }

    const prevBtn = document.getElementById('learn-prev');
    const nextBtn = document.getElementById('learn-next');
    if (prevBtn) prevBtn.disabled = (this._currentStep === 0);
    if (nextBtn) {
      if (this._currentStep === total - 1) {
        nextBtn.textContent = 'Done ✓';
      } else {
        nextBtn.textContent = 'Next →';
      }
    }
  },

  init() {
    const closeBtn = document.getElementById('learn-close');
    const prevBtn  = document.getElementById('learn-prev');
    const nextBtn  = document.getElementById('learn-next');

    if (closeBtn) closeBtn.addEventListener('click', () => this.close());

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (this._currentStep > 0) {
          this._currentStep--;
          this._render();
        }
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (this._currentStep < this.STEPS.length - 1) {
          this._currentStep++;
          this._render();
        } else {
          this.close();
        }
      });
    }
  },
};

/* BOOTSTRAP */
document.addEventListener('DOMContentLoaded', async () => {
  UIController.init();

  // Refresh the data panel the instant a fresh Doppler response actually
  // arrives from the backend. Without this, a slider drag while paused would
  // show stale numbers from the previous position indefinitely — the panel
  // only used to update on the next animation frame, which never comes
  // while state.running is false.
  PhysicsClient.onCacheUpdated = () => UIController.updateDataPanel();

  // One-time fetch of initial Doppler values/curve from the Python backend
  // before anything is drawn, so the simulator never shows placeholder or
  // undefined numbers on first paint.
  await PhysicsClient.init(state.sourceFreq, state.sourceSpeed);

  SimulationController.init();

  FullscreenManager.init();
  CompareManager.init();
  LearnMode.init();

  AnimationLoop.start();

  GraphRenderer.draw();
  UIController.updateDataPanel();
});