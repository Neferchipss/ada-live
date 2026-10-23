// Live PC stats: CPU and RAM from the OS, GPU from a long-running `nvidia-smi -lms` stream.
// Keeps ~10 minutes of history for the page's sparklines.
import os from 'node:os';
import { spawn } from 'node:child_process';

const SAMPLE_MS = 3000;
const HISTORY = 200; // 200 x 3 s = 10 min
// "Throttle reasons" bitmask from nvidia-smi: the ones that mean the GPU is being held back.
const THROTTLE = { 0x4: 'power cap', 0x20: 'thermal (SW)', 0x40: 'thermal (HW)', 0x80: 'power brake', 0x8: 'HW slowdown' };

export class Stats {
  constructor() {
    this.history = [];
    this.gpu = null;
    this.gpuName = '';
    this.lastCpu = os.cpus();
    this.#startGpu();
    this.timer = setInterval(() => this.#sample(), SAMPLE_MS);
    this.#sample();
  }

  #startGpu() {
    const fields = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr,clocks.mem,fan.speed,clocks_throttle_reasons.active';
    let proc;
    try {
      proc = spawn('nvidia-smi', [`--query-gpu=${fields}`, '--format=csv,noheader,nounits', `-lms`, String(SAMPLE_MS)], { windowsHide: true });
    } catch { return; }
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const [name, util, memUsed, memTotal, temp, power, clkGr, clkMem, fan, reasons] = l.split(',').map((x) => x.trim());
        if (!name) continue;
        const mask = parseInt(reasons, 16) || 0;
        this.gpuName = name;
        this.gpu = {
          util: num(util), memUsed: num(memUsed), memTotal: num(memTotal), temp: num(temp),
          power: num(power), clkGr: num(clkGr), clkMem: num(clkMem), fan: num(fan),
          throttle: Object.entries(THROTTLE).filter(([bit]) => mask & Number(bit)).map(([, v]) => v),
        };
      }
    });
    proc.on('error', () => { this.gpu = null; });
    proc.on('exit', () => { setTimeout(() => this.#startGpu(), 30000); });
    this.proc = proc;
  }

  #sample() {
    const now = os.cpus();
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      const p = this.lastCpu[i]?.times || c.times;
      const d = Object.keys(c.times).reduce((s, k) => s + (c.times[k] - p[k]), 0);
      total += d;
      idle += c.times.idle - p.idle;
    });
    this.lastCpu = now;
    const cpu = total ? Math.round(100 * (1 - idle / total)) : 0;
    const memTotal = os.totalmem(), memUsed = memTotal - os.freemem();
    const g = this.gpu;
    this.history.push({
      t: Date.now(), cpu, ram: Math.round((memUsed / memTotal) * 100),
      gpu: g?.util ?? null, vram: g ? Math.round((g.memUsed / g.memTotal) * 100) : null, temp: g?.temp ?? null,
    });
    if (this.history.length > HISTORY) this.history.shift();
    this.current = {
      cpu, cpuName: os.cpus()[0]?.model?.trim(), cores: now.length,
      ramUsedGB: +(memUsed / 2 ** 30).toFixed(1), ramTotalGB: Math.round(memTotal / 2 ** 30),
      gpuName: this.gpuName, gpu: g, uptimeH: +(os.uptime() / 3600).toFixed(1),
    };
  }

  snapshot() {
    // Columnar history keeps the payload small.
    const h = this.history;
    return {
      now: this.current,
      history: { t0: h[0]?.t || Date.now(), step: SAMPLE_MS, cpu: h.map((x) => x.cpu), ram: h.map((x) => x.ram), gpu: h.map((x) => x.gpu), vram: h.map((x) => x.vram), temp: h.map((x) => x.temp) },
    };
  }
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
