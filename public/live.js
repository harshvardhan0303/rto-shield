// Gemini Live voice call in the browser: mic (16 kHz PCM) -> WebSocket -> model audio (24 kHz PCM) -> speakers.
// The API key never reaches the browser: the server hands out a single-use, short-lived token.
(function () {
  const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor(){ super(); this.buf = []; this.len = 0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch)); this.len += ch.length;
      if (this.len >= sampleRate / 10) {               // ~100 ms chunks
        const out = new Float32Array(this.len); let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.buf = []; this.len = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('rto-capture', Capture);`;

  function downsample(f32, from, to) {
    if (from === to) return f32;
    const ratio = from / to, n = Math.floor(f32.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * ratio), e = Math.min(f32.length, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = s; j < e; j++) sum += f32[j];
      out[i] = sum / Math.max(1, e - s);
    }
    return out;
  }
  function toB64(i16) {
    const u8 = new Uint8Array(i16.buffer); let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64), u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return new Int16Array(u8.buffer, 0, Math.floor(u8.length / 2));
  }

  class LiveCall {
    constructor({ url, model, instructions, voice, onState, onLine, onLevel, onError }) {
      Object.assign(this, { url, model, instructions, voice, onState, onLine, onLevel, onError });
      this.lines = []; this.cur = null; this.sources = new Set(); this.nextTime = 0; this.closed = false;
    }

    async start() {
      this.onState("connecting");
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.inCtx = new AudioContext();
      this.outCtx = new AudioContext({ sampleRate: 24000 });
      await this.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
      const src = this.inCtx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.inCtx, "rto-capture");
      const mute = this.inCtx.createGain(); mute.gain.value = 0;
      src.connect(this.node); this.node.connect(mute); mute.connect(this.inCtx.destination);
      this.node.port.onmessage = (e) => this.sendAudio(e.data);

      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ setup: {
          model: this.model,
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice || "Kore" } } } },
          systemInstruction: { parts: [{ text: this.instructions }] },
          inputAudioTranscription: {}, outputAudioTranscription: {},
        } }));
      };
      this.ws.onmessage = async (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : await ev.data.text();
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        this.handle(msg);
      };
      this.ws.onerror = () => this.onError?.("Could not connect to Gemini Live.");
      this.ws.onclose = (ev) => {
        if (!this.closed) { this.closed = true; this.cleanup(); this.onState("ended", ev.reason || (ev.code !== 1000 ? `Connection closed (${ev.code})` : "")); }
      };
    }

    handle(msg) {
      if (msg.setupComplete) {
        this.ready = true; this.onState("live");
        this.ws.send(JSON.stringify({ realtimeInput: { text: "(The customer has just picked up the phone. Start the call now with your greeting.)" } }));
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.interrupted) this.stopPlayback();
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data && (part.inlineData.mimeType || "").startsWith("audio")) this.play(part.inlineData.data);
      }
      if (sc.inputTranscription?.text) this.addText("customer", sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.addText("agent", sc.outputTranscription.text);
      if (sc.turnComplete) this.cur = null;
    }

    addText(role, text) {
      if (!this.cur || this.cur.role !== role) { this.cur = { role, text: "" }; this.lines.push(this.cur); }
      this.cur.text = (this.cur.text + text).replace(/\s+/g, " ").replace(/^\s+/, "");
      this.onLine(this.lines);
    }

    sendAudio(f32) {
      if (!this.ready || this.ws?.readyState !== 1) return;
      let peak = 0; for (let i = 0; i < f32.length; i += 8) peak = Math.max(peak, Math.abs(f32[i]));
      this.onLevel?.(Math.min(1, peak * 2.2));
      const d = downsample(f32, this.inCtx.sampleRate, 16000);
      const i16 = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) { const s = Math.max(-1, Math.min(1, d[i])); i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: toB64(i16), mimeType: "audio/pcm;rate=16000" } } }));
    }

    play(b64) {
      const i16 = fromB64(b64);
      const buf = this.outCtx.createBuffer(1, i16.length, 24000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 0x8000;
      const s = this.outCtx.createBufferSource();
      s.buffer = buf; s.connect(this.outCtx.destination);
      this.nextTime = Math.max(this.nextTime, this.outCtx.currentTime + 0.02);
      s.start(this.nextTime); this.nextTime += buf.duration;
      this.sources.add(s); s.onended = () => this.sources.delete(s);
    }
    stopPlayback() { for (const s of this.sources) { try { s.stop(); } catch {} } this.sources.clear(); this.nextTime = 0; }

    stop() {
      if (this.closed) return;
      this.closed = true;
      try { if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); this.ws.close(1000, "Call ended"); } } catch {}
      this.cleanup();
      this.onState("ended");
    }
    cleanup() {
      this.stopPlayback();
      try { this.stream?.getTracks().forEach(t => t.stop()); } catch {}
      try { this.inCtx?.close(); } catch {}
      setTimeout(() => { try { this.outCtx?.close(); } catch {} }, 300);
      this.onLevel?.(0);
    }
  }
  window.LiveCall = LiveCall;
})();
