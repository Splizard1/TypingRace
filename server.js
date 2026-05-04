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
const MIN_PLAYERS = 2;

let players = new Map(); // ws -> player (active in current/upcoming race)
let pending = new Map(); // ws -> player (joined mid-race, waiting for next lobby)
let gameState = 'lobby';
let currentText = '';
let countdownTimer = null;
let countdownVal = COUNTDOWN_SECS;
let raceStartTime = null;
let idCounter = 0;
let isSolo = false;
let currentQuote = null;
let guessOptions = [];
let correctOptionIndex = -1;
let playerGuesses = new Map(); // playerId -> optionIndex
let guessTimer = null;
let pendingResults = null;
const GUESS_TIMEOUT_MS = 15000;

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function lobbyPayload() {
  return {
    type: 'lobby_update',
    gameState,
    countdown: gameState === 'countdown' ? countdownVal : null,
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, ready: p.ready })),
  };
}

function racePayload() {
  return {
    type: 'race_update',
    totalChars: currentText.length,
    players: [...players.values()].map(p => ({
      id: p.id,
      name: p.name,
      progress: p.progress,
      finished: p.finished,
    })),
  };
}

function checkAllReady() {
  const allReady = players.size >= MIN_PLAYERS && [...players.values()].every(p => p.ready);
  if (allReady && gameState === 'lobby') startCountdown();
  else if (!allReady && gameState === 'countdown') cancelCountdown();
}

function startCountdown() {
  if (countdownTimer || gameState !== 'lobby') return;
  gameState = 'countdown';
  countdownVal = COUNTDOWN_SECS;
  broadcast(lobbyPayload());

  countdownTimer = setInterval(() => {
    countdownVal--;
    if (countdownVal <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      startRace();
    } else {
      broadcast(lobbyPayload());
    }
  }, 1000);
}

function cancelCountdown() {
  if (!countdownTimer) return;
  clearInterval(countdownTimer);
  countdownTimer = null;
  gameState = 'lobby';
  broadcast(lobbyPayload());
}

function startRace(solo = false) {
  isSolo = solo;
  gameState = 'racing';
  currentQuote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  currentText = currentQuote.text;
  raceStartTime = Date.now();
  players.forEach(p => { p.progress = 0; p.finished = false; p.finishTime = null; p.ready = false; });
  broadcast({
    type: 'race_start',
    text: currentText,
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, progress: 0, finished: false })),
  });
}

function endRace() {
  gameState = 'guessing';
  const sorted = [...players.values()]
    .filter(p => p.finished)
    .sort((a, b) => a.finishTime - b.finishTime);
  const dnf = [...players.values()].filter(p => !p.finished);

  pendingResults = [
    ...sorted.map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name,
      timeMs: p.finishTime - raceStartTime,
      wpm: Math.round((currentText.split(' ').length / ((p.finishTime - raceStartTime) / 60000))),
    })),
    ...dnf.map(p => ({ rank: null, id: p.id, name: p.name, timeMs: null, wpm: null })),
  ];

  // Build 3 options: correct author + 2 random wrong ones
  const correct = currentQuote.author;
  const others = [...new Set(QUOTES.map(q => q.author).filter(a => a !== correct))];
  const wrong = others.sort(() => Math.random() - 0.5).slice(0, 2);
  guessOptions = [...wrong, correct].sort(() => Math.random() - 0.5);
  correctOptionIndex = guessOptions.indexOf(correct);
  playerGuesses.clear();

  broadcast({ type: 'guess_phase', options: guessOptions, timeoutMs: GUESS_TIMEOUT_MS });

  guessTimer = setTimeout(resolveGuesses, GUESS_TIMEOUT_MS);
}

function resolveGuesses() {
  clearTimeout(guessTimer);
  guessTimer = null;

  const results = pendingResults.map(r => ({
    ...r,
    guessCorrect: playerGuesses.get(r.id) === correctOptionIndex,
    guessed: playerGuesses.has(r.id),
  }));

  gameState = 'ended';
  broadcast({
    type: 'race_end',
    results,
    solo: isSolo,
    correctIndex: correctOptionIndex,
    correctAuthor: currentQuote.author,
  });

  setTimeout(() => {
    if (gameState !== 'ended') return;
    pending.forEach((p, ws) => players.set(ws, p));
    pending.clear();
    gameState = 'lobby';
    broadcast(lobbyPayload());
  }, RESULTS_DURATION_MS);
}

function checkAllFinished() {
  if (players.size > 0 && [...players.values()].every(p => p.finished)) endRace();
}

function checkAllGuessed() {
  if (players.size === 0 || [...players.values()].every(p => playerGuesses.has(p.id))) resolveGuesses();
}

wss.on('connection', ws => {
  const player = { id: ++idCounter, name: null, progress: 0, finished: false, finishTime: null, ready: false };
  send(ws, { type: 'hello', id: player.id });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      if (typeof msg.name !== 'string' || !msg.name.trim()) return;
      player.name = msg.name.trim().slice(0, 20);

      if (gameState === 'racing' || gameState === 'ended') {
        pending.set(ws, player);
        send(ws, { type: 'waiting' });
      } else {
        players.set(ws, player);
        broadcast(lobbyPayload());
      }
      return;
    }

    if (msg.type === 'solo_start') {
      if (gameState === 'lobby' && players.size === 1 && player.name) startRace(true);
      return;
    }

    if (msg.type === 'ready') {
      if (!player.name || gameState === 'racing') return;
      player.ready = !player.ready;
      checkAllReady();
      broadcast(lobbyPayload());
      return;
    }

    if (msg.type === 'guess') {
      if (gameState !== 'guessing' || !player.name || playerGuesses.has(player.id)) return;
      const idx = Number(msg.index);
      if (!Number.isFinite(idx) || idx < 0 || idx > 2) return;
      playerGuesses.set(player.id, idx);
      checkAllGuessed();
      return;
    }

    if (msg.type === 'progress') {
      if (gameState !== 'racing' || !player.name || player.finished) return;
      const chars = Math.round(Number(msg.chars));
      if (!Number.isFinite(chars) || chars < 0) return;
      player.progress = Math.min(chars, currentText.length);
      if (player.progress >= currentText.length) {
        player.finished = true;
        player.finishTime = Date.now();
      }
      broadcast(racePayload());
      if (player.finished) checkAllFinished();
    }
  });

  ws.on('close', () => {
    pending.delete(ws);
    players.delete(ws);
    if (gameState === 'lobby' || gameState === 'countdown') {
      checkAllReady();
      broadcast(lobbyPayload());
    } else if (gameState === 'racing') {
      broadcast(racePayload());
      checkAllFinished();
    } else if (gameState === 'guessing') {
      checkAllGuessed();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Typing race → http://localhost:${PORT}`));
