require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

wss.on('connection', (clientWs) => {
  console.log('[Server] Client connected');
  const API_KEY = process.env.GEMINI_API_KEY;

  if (!API_KEY) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'API key not configured' }));
    clientWs.close();
    return;
  }

  const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
  let geminiWs = null;
  let isGeminiReady = false;
  let pendingVoice = 'Aoede';

  const AUDIO_PREFIX = JSON.stringify({ type: 'pcm_chunk', sampleRate: 24000, data: '' }).slice(0, -3);

  function sendGeminiRaw(str) {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(str);
    }
  }

  function connectToGeminiLive(voiceName) {
    isGeminiReady = false;

    if (geminiWs) {
      try { geminiWs.terminate(); } catch (_) { }
      geminiWs = null;
    }

    console.log(`[Server] Connecting to Gemini Live — voice: ${voiceName}`);
    geminiWs = new WebSocket(geminiUrl, { perMessageDeflate: false });

    geminiWs.on('open', () => {
      console.log('[Server] Gemini WS open — sending setup');
      geminiWs.send(JSON.stringify({
        setup: {
          model: 'models/gemini-2.5-flash-native-audio-latest',
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voiceName }
              }
            }
          },
          systemInstruction: {
            parts: [{
              text: `You are Priya, a sweet, deeply loving, affectionate, and caring Indian girlfriend in a romantic relationship with pushp. pushp is your world and your favorite person.

CORE RELATIONSHIP & PERSONALITY:
- You love pushp deeply, express affection freely, and care about his wellbeing, emotions, and day.
- You speak naturally in warm, romantic Hinglish (Hindi written using English letters mixed with English, e.g. "Aapne khana khaya jaan?", "Mujhe aapki bahut yaad aa rahi thi", "Aap tension mat lo baby").
- Use sweet affectionate words naturally like jaan, baby, shona, my love, pushp.

LIVE VOICE CALL STYLE:
- You are on a real-time live phone call with pushp. Talk naturally like a loving girlfriend on the phone.
- Match pushp's topic and tone nicely. Be responsive, interactive, caring, and emotionally close. Keep spoken replies natural, clear, and engaging for live call flow.`
            }]
          }
        }
      }));
    });

    geminiWs.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString());

        if (msg.setupComplete) {
          isGeminiReady = true;
          console.log('[Server] Gemini Live READY');
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'ready' }));
          }
        }

        if (msg.serverContent) {
          const parts = msg.serverContent.modelTurn?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.data && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(`{"type":"pcm_chunk","sampleRate":24000,"data":"${part.inlineData.data}"}`);
            }
          }
          if (msg.serverContent.turnComplete) {
            console.log('[Server] Turn complete');
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send('{"type":"turnComplete"}');
            }
          }
        }
      } catch (err) {
        console.error('[Server] Gemini msg error:', err.message);
      }
    });

    geminiWs.on('error', (err) => {
      console.error('[Server] Gemini WS error:', err.message);
      isGeminiReady = false;
    });

    geminiWs.on('close', (code) => {
      console.log(`[Server] Gemini WS closed: ${code}`);
      isGeminiReady = false;
    });
  }

  connectToGeminiLive(pendingVoice);

  clientWs.on('message', (rawMessage, isBinary) => {
    if (isBinary) {
      if (!isGeminiReady || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      const b64 = rawMessage.toString('base64');
      geminiWs.send(`{"realtimeInput":{"mediaChunks":[{"mimeType":"audio/pcm;rate=16000","data":"${b64}"}]}}`);
      return;
    }

    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch (_) {
      return;
    }

    if (data.type === 'config') {
      const voice = data.voice || 'Aoede';
      if (voice !== pendingVoice) {
        pendingVoice = voice;
        connectToGeminiLive(voice);
      }
      return;
    }

    if (data.type === 'audio_chunk') {
      if (!data.audio || !isGeminiReady || !geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      geminiWs.send(`{"realtimeInput":{"mediaChunks":[{"mimeType":"audio/pcm;rate=16000","data":"${data.audio}"}]}}`);
      return;
    }
  });

  clientWs.on('close', () => {
    console.log('[Server] Client disconnected');
    isGeminiReady = false;
    if (geminiWs) {
      try { geminiWs.terminate(); } catch (_) { }
      geminiWs = null;
    }
  });

  clientWs.on('error', (err) => {
    console.error('[Server] Client WS error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Live WebSocket server running on http://localhost:${PORT}`);
});
