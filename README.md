# ⚔️ The Typing Quest

A real-time multiplayer typing race built with Node.js and WebSockets. Players join rooms via a shared code, and a persistent
two way connection keeps everyone's progress in sync as they type,  each keystroke triggers a server broadcast 
so all clients update simultaneously. The server runs a state machine across each room
(lobby → countdown → racing → guess phase → results), supporting multiple concurrent gam
es. The frontend is vanilla JS with no framework: typing sounds are generated procedurally using the Web Audio API,
and the video background is driven by the YouTube IFrame API.

## Running locally

```bash
npm install
node server.js
```

Then open http://localhost:3000

## Features

- Multiplayer rooms with shareable codes
- Ready-up system with 5-second countdown
- Quote attribution guess round after each race
- Solo practice mode
- Live WPM and progress bars for all racers
- Procedural typing sounds via Web Audio API
- Lord of the Rings theme
