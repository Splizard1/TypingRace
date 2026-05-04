const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const QUOTES = require('./quotes.json').map(q => ({ text: q.quote.trim(), author: q.author }));

const COUNTDOWN_SECS = 5;
const RESULTS_DURATION_MS = 12000;
const GUESS_TIMEOUT_MS = 15000;
const MIN_PLAYERS = 2;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O to avoid confusion

const rooms = new Map();
let idCounter = 0;

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // ws -> player (active)
    this.pending = new Map();   // ws -> player (waiting for race to end)
    this.gameState = 'lobby';
    this.currentText = '';
    this.currentQuote = null;
    this.countdownTimer = null;
    this.countdownVal = COUNTDOWN_SECS;
    this.raceStartTime = null;
    this.isSolo = false;
    this.guessOptions = [];
    this.correctOptionIndex = -1;
    this.playerGuesses = new Map();
    this.guessTimer = null;
    this.pendingResults = null;
    this.cleanupTimer = null;
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of [...this.players.keys(), ...this.pending.keys()]) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  lobbyPayload() {
    return {
      type: 'lobby_update',
      code: this.code,
      gameState: this.gameState,
      countdown: this.gameState === 'countdown' ? this.countdownVal : null,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })),
    };
  }

  racePayload() {
    return {
      type: 'race_update',
      totalChars: this.currentText.length,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, progress: p.progress, finished: p.finished,
      })),
    };
  }

  checkAllReady() {
    const allReady = this.players.size >= MIN_PLAYERS && [...this.players.values()].every(p => p.ready);
    if (allReady && this.gameState === 'lobby') this.startCountdown();
    else if (!allReady && this.gameState === 'countdown') this.cancelCountdown();
  }

  startCountdown() {
    if (this.countdownTimer || this.gameState !== 'lobby') return;
    this.gameState = 'countdown';
    this.countdownVal = COUNTDOWN_SECS;
    this.broadcast(this.lobbyPayload());

    this.countdownTimer = setInterval(() => {
      this.countdownVal--;
      if (this.countdownVal <= 0) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.startRace();
      } else {
        this.broadcast(this.lobbyPayload());
      }
    }, 1000);
  }

  cancelCountdown() {
    if (!this.countdownTimer) return;
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.gameState = 'lobby';
    this.broadcast(this.lobbyPayload());
  }

  startRace(solo = false) {
    this.isSolo = solo;
    this.gameState = 'racing';
    this.currentQuote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    this.currentText = this.currentQuote.text;
    this.raceStartTime = Date.now();
    this.players.forEach(p => { p.progress = 0; p.finished = false; p.finishTime = null; p.ready = false; });
    this.broadcast({
      type: 'race_start',
      text: this.currentText,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, progress: 0, finished: false })),
    });
  }

  endRace() {
    this.gameState = 'guessing';
    const sorted = [...this.players.values()]
      .filter(p => p.finished)
      .sort((a, b) => a.finishTime - b.finishTime);
    const dnf = [...this.players.values()].filter(p => !p.finished);

    this.pendingResults = [
      ...sorted.map((p, i) => ({
        rank: i + 1, id: p.id, name: p.name,
        timeMs: p.finishTime - this.raceStartTime,
        wpm: Math.round((this.currentText.split(' ').length / ((p.finishTime - this.raceStartTime) / 60000))),
      })),
      ...dnf.map(p => ({ rank: null, id: p.id, name: p.name, timeMs: null, wpm: null })),
    ];

    const correct = this.currentQuote.author;
    const others = [...new Set(QUOTES.map(q => q.author).filter(a => a !== correct))];
    const wrong = others.sort(() => Math.random() - 0.5).slice(0, 2);
    this.guessOptions = [...wrong, correct].sort(() => Math.random() - 0.5);
    this.correctOptionIndex = this.guessOptions.indexOf(correct);
    this.playerGuesses.clear();

    this.broadcast({ type: 'guess_phase', options: this.guessOptions, timeoutMs: GUESS_TIMEOUT_MS });
    this.guessTimer = setTimeout(() => this.resolveGuesses(), GUESS_TIMEOUT_MS);
  }

  resolveGuesses() {
    clearTimeout(this.guessTimer);
    this.guessTimer = null;

    const results = this.pendingResults.map(r => ({
      ...r,
      guessCorrect: this.playerGuesses.get(r.id) === this.correctOptionIndex,
      guessed: this.playerGuesses.has(r.id),
    }));

    this.gameState = 'ended';
    this.broadcast({
      type: 'race_end',
      results,
      solo: this.isSolo,
      correctIndex: this.correctOptionIndex,
      correctAuthor: this.currentQuote.author,
    });

    setTimeout(() => {
      if (this.gameState !== 'ended') return;
      this.pending.forEach((p, ws) => this.players.set(ws, p));
      this.pending.clear();
      this.gameState = 'lobby';
      this.broadcast(this.lobbyPayload());
    }, RESULTS_DURATION_MS);
  }

  checkAllFinished() {
    if (this.players.size > 0 && [...this.players.values()].every(p => p.finished)) this.endRace();
  }

  checkAllGuessed() {
    if (this.players.size === 0 || [...this.players.values()].every(p => this.playerGuesses.has(p.id))) {
      this.resolveGuesses();
    }
  }

  removePlayer(ws) {
    this.pending.delete(ws);
    this.players.delete(ws);

    if (this.players.size === 0 && this.pending.size === 0) {
      clearInterval(this.countdownTimer);
      clearTimeout(this.guessTimer);
      this.cleanupTimer = setTimeout(() => rooms.delete(this.code), 30000);
      return;
    }

    if (this.gameState === 'lobby' || this.gameState === 'countdown') {
      this.checkAllReady();
      this.broadcast(this.lobbyPayload());
    } else if (this.gameState === 'racing') {
      this.broadcast(this.racePayload());
      this.checkAllFinished();
    } else if (this.gameState === 'guessing') {
      this.checkAllGuessed();
    }
  }
}

wss.on('connection', ws => {
  let room = null;
  const player = { id: ++idCounter, name: null, progress: 0, finished: false, finishTime: null, ready: false };
  send(ws, { type: 'hello', id: player.id });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'enter') {
      if (typeof msg.name !== 'string' || !msg.name.trim()) return;
      player.name = msg.name.trim().slice(0, 20);
      const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';

      if (code) {
        room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'error', message: `Room "${code}" not found. Check the code and try again.` });
          return;
        }
      } else {
        room = new Room(generateCode());
        rooms.set(room.code, room);
      }

      if (room.gameState === 'racing' || room.gameState === 'guessing' || room.gameState === 'ended') {
        room.pending.set(ws, player);
        send(ws, { type: 'waiting' });
      } else {
        room.players.set(ws, player);
        room.broadcast(room.lobbyPayload());
      }
      return;
    }

    if (!room) return;

    if (msg.type === 'solo_start') {
      if (room.gameState === 'lobby' && room.players.size === 1 && player.name) room.startRace(true);
      return;
    }

    if (msg.type === 'ready') {
      if (!player.name || room.gameState === 'racing') return;
      player.ready = !player.ready;
      room.checkAllReady();
      room.broadcast(room.lobbyPayload());
      return;
    }

    if (msg.type === 'guess') {
      if (room.gameState !== 'guessing' || !player.name || room.playerGuesses.has(player.id)) return;
      const idx = Number(msg.index);
      if (!Number.isFinite(idx) || idx < 0 || idx > 2) return;
      room.playerGuesses.set(player.id, idx);
      room.checkAllGuessed();
      return;
    }

    if (msg.type === 'progress') {
      if (room.gameState !== 'racing' || !player.name || player.finished) return;
      const chars = Math.round(Number(msg.chars));
      if (!Number.isFinite(chars) || chars < 0) return;
      player.progress = Math.min(chars, room.currentText.length);
      if (player.progress >= room.currentText.length) {
        player.finished = true;
        player.finishTime = Date.now();
      }
      room.broadcast(room.racePayload());
      if (player.finished) room.checkAllFinished();
    }
  });

  ws.on('close', () => { if (room) room.removePlayer(ws); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Typing quest → http://localhost:${PORT}`));
