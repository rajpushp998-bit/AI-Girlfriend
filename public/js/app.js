const micButton = document.getElementById('mic-button');
const micIcon = document.getElementById('mic-icon');
const statusTitle = document.getElementById('status-title');
const statusSubtitle = document.getElementById('status-subtitle');
const avatarOrb = document.getElementById('avatar-orb');
const avatarContainer = document.getElementById('avatar-container');
const wsIndicator = document.getElementById('ws-indicator');

let socket = null;
let isMicActive = false;

let micAudioCtx = null;
let mediaStream = null;
let scriptProcessor = null;
let sourceNode = null;
let silentGain = null;

let playbackCtx = null;
let nextPlayAt = 0;
let isSpeaking = false;
let speakEndTimer = null;

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socketUrl = `${protocol}//${location.host}`;

function setStatus(title, subtitle) {
  if (statusTitle) statusTitle.textContent = title;
  if (statusSubtitle) statusSubtitle.textContent = subtitle;
}

function setOrbState(state) {
  if (!avatarOrb) return;
  avatarOrb.className = 'avatar-orb' + (state ? ' ' + state : '');
  if (avatarContainer) {
    avatarContainer.classList.remove('speaking', 'listening');
    if (state) avatarContainer.classList.add(state);
  }
}

function sendToServer(obj) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

function warmPlaybackCtx() {
  if (playbackCtx && playbackCtx.state !== 'closed') return;
  playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000, latencyHint: 'interactive' });
  nextPlayAt = 0;
  isSpeaking = false;
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume().catch(() => {});
  }
  const silence = playbackCtx.createBuffer(1, 1, 24000);
  const src = playbackCtx.createBufferSource();
  src.buffer = silence;
  src.connect(playbackCtx.destination);
  src.start();
  console.log('[Audio] Playback context warmed up');
}

function playPcmChunk(base64Pcm, sampleRate) {
  try {
    if (!playbackCtx || playbackCtx.state === 'closed') warmPlaybackCtx();
    const ctx = playbackCtx;
    if (ctx.state === 'suspended') ctx.resume();

    const binaryStr = atob(base64Pcm);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate || 24000);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now, nextPlayAt);
    source.start(startAt);
    nextPlayAt = startAt + audioBuffer.duration;

    if (!isSpeaking) {
      isSpeaking = true;
      setOrbState('speaking');
      setStatus('Priya is speaking 💕', 'Live voice call');
    }

    if (speakEndTimer) clearTimeout(speakEndTimer);
    const msUntilEnd = Math.max(0, (nextPlayAt - ctx.currentTime) * 1000) + 150;
    speakEndTimer = setTimeout(() => {
      isSpeaking = false;
      if (!isMicActive) {
        setOrbState(null);
        setStatus('Priya is online 💕', 'Tap mic to talk live');
      }
    }, msUntilEnd);

  } catch (err) {
    console.error('[Audio] playPcmChunk error:', err);
  }
}

function initLiveWebSocket() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;

  socket = new WebSocket(socketUrl);

  socket.onopen = () => {
    console.log('[WS] Connected');
    if (wsIndicator) wsIndicator.classList.add('connected');
    setStatus('Priya is connecting...', 'Setting up live call...');
    sendToServer({ type: 'config', voice: 'Aoede' });
    warmPlaybackCtx();
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'ready') {
        setStatus('Priya is online 💕', 'Tap mic to talk live');
        warmPlaybackCtx();
        console.log('[WS] Gemini Live READY');

      } else if (data.type === 'pcm_chunk') {
        if (data.data) playPcmChunk(data.data, data.sampleRate || 24000);

      } else if (data.type === 'turnComplete') {
        console.log('[WS] Turn complete');

      } else if (data.type === 'error') {
        console.error('[WS] Error:', data.message);
        setStatus('⚠️ Error', data.message);
      }
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  };

  socket.onerror = () => {
    if (wsIndicator) wsIndicator.classList.remove('connected');
    setStatus('Connection Error', 'Retrying...');
  };

  socket.onclose = () => {
    if (wsIndicator) wsIndicator.classList.remove('connected');
    setStatus('Disconnected', 'Reconnecting...');
    socket = null;
    setTimeout(initLiveWebSocket, 3000);
  };
}


async function startLiveMicStreaming() {
  if (isMicActive) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus('Not connected', 'Please wait...');
    return;
  }

  nextPlayAt = 0;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    micAudioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000,
      latencyHint: 'interactive'
    });
    if (micAudioCtx.state === 'suspended') await micAudioCtx.resume();

    sourceNode = micAudioCtx.createMediaStreamSource(mediaStream);
    scriptProcessor = micAudioCtx.createScriptProcessor(512, 1, 1);
    silentGain = micAudioCtx.createGain();
    silentGain.gain.value = 0;

    let sendBuffer = [];
    let sendScheduled = false;

    scriptProcessor.onaudioprocess = (e) => {
      if (!isMicActive || !socket || socket.readyState !== WebSocket.OPEN) return;
      const floatData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(floatData.length);
      for (let i = 0; i < floatData.length; i++) {
        const s = Math.max(-1, Math.min(1, floatData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      sendBuffer.push(pcm16);

      if (!sendScheduled) {
        sendScheduled = true;
        Promise.resolve().then(() => {
          sendScheduled = false;
          if (sendBuffer.length === 0) return;
          const total = sendBuffer.reduce((acc, b) => acc + b.length, 0);
          const combined = new Int16Array(total);
          let offset = 0;
          for (const buf of sendBuffer) {
            combined.set(buf, offset);
            offset += buf.length;
          }
          sendBuffer = [];
          const bytes = new Uint8Array(combined.buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
          }
          socket.send(JSON.stringify({ type: 'audio_chunk', audio: btoa(binary) }));
        });
      }
    };

    sourceNode.connect(scriptProcessor);
    scriptProcessor.connect(silentGain);
    silentGain.connect(micAudioCtx.destination);

    isMicActive = true;
    micButton.classList.add('listening');
    if (micIcon) micIcon.className = 'fas fa-stop';
    setOrbState('listening');
    setStatus('🎙️ Listening...', 'Tap mic again to stop');
    console.log('[Mic] Live streaming started at 16kHz');

  } catch (err) {
    console.error('[Mic] getUserMedia error:', err.name, err.message);
    isMicActive = false;
    if (err.name === 'NotAllowedError') {
      setStatus('Mic Blocked', 'Allow microphone in browser settings');
    } else {
      setStatus('Mic Error', err.message);
    }
  }
}

function stopLiveMicStreaming() {
  if (!isMicActive) return;
  isMicActive = false;

  if (scriptProcessor) {
    scriptProcessor.onaudioprocess = null;
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (silentGain) { silentGain.disconnect(); silentGain = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (micAudioCtx) { micAudioCtx.close().catch(() => {}); micAudioCtx = null; }

  micButton.classList.remove('listening');
  if (micIcon) micIcon.className = 'fas fa-microphone';

  if (!isSpeaking) {
    setOrbState(null);
    setStatus('Priya is online 💕', 'Tap mic to talk live');
  }
  console.log('[Mic] Stopped');
}

micButton.addEventListener('click', () => {
  if (isMicActive) stopLiveMicStreaming();
  else startLiveMicStreaming();
});

micButton.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (isMicActive) stopLiveMicStreaming();
  else startLiveMicStreaming();
}, { passive: false });

micButton.addEventListener('touchcancel', () => {
  if (isMicActive) stopLiveMicStreaming();
});

initLiveWebSocket();
