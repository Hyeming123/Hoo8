const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const helmet = require('helmet');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Middleware ---
app.use(helmet.contentSecurityPolicy({
    directives: {
        "default-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", "ws:", "wss:"]
    },
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Room Management (League System) ---
const TOTAL_TEAMS = 11;
const rooms = new Map();

function broadcast(room, data) {
    room.players.forEach(p => {
        if (p && p.readyState === 1) p.send(JSON.stringify(data));
    });
}

function sendTo(ws, data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

// --- Game Logic ---
const positions = ["TOP", "JGL", "MID", "BOT", "SPT"];
const playerNames = ["Zeus", "Kiin", "Doran", "Kingen", "Morgan", "Oner", "Canyon", "Peanut", "Lucid", "Faker", "Chovy", "Zeka", "ShowMaker", "Bdd", "Gumayusi", "Ruler", "Viper", "Aiming", "Keria", "Lehends", "Delight", "Kellin", "BeryL", "Pyosik", "Cuzz", "Sylvie", "Clear"];
const botTeamNames = ["T1", "Gen.G", "DK", "HLE", "KT", "Kwangdong", "FearX", "BNK", "NS", "DRX", "OK Savings"];

function generateRoster(baseOvr) {
    return positions.map(pos => ({
        name: playerNames[Math.floor(Math.random() * playerNames.length)],
        pos, ovr: Math.floor(baseOvr + (Math.random() * 6 - 3)), form: 0
    }));
}

function getTeamOvr(roster) {
    return roster.reduce((a, b) => a + b.ovr + b.form, 0) / 5;
}

function getPower(ovr) {
    return ovr + (Math.random() * 24 - 12);
}

function generateLeagueSchedule(numTeams) {
    let teams = Array.from({ length: numTeams }, (_, i) => i);
    if (numTeams % 2 !== 0) teams.push(null);

    const rounds = teams.length - 1;
    const matchesPerRound = teams.length / 2;
    const schedule = [];

    for (let r = 0; r < rounds; r++) {
        const roundMatches = [];
        for (let m = 0; m < matchesPerRound; m++) {
            const home = teams[m];
            const away = teams[teams.length - 1 - m];
            if (home !== null && away !== null) roundMatches.push([home, away]);
        }
        schedule.push(roundMatches);
        teams.splice(1, 0, teams.pop());
    }
    return schedule;
}

// --- WebSocket Handler ---
wss.on('connection', (ws) => {
    ws.id = uuidv4();

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'CREATE_ROOM': {
                const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
                const team = {
                    name: msg.teamName || 'USER TEAM',
                    coachName: msg.coachName || 'COACH',
                    roster: generateRoster(81), money: 1500, fatigue: 0, w: 0, l: 0, isBot: false
                };
                rooms.set(roomId, {
                    id: roomId,
                    players: [ws],
                    teams: [team],
                    state: 'WAITING',
                    week: 1,
                    actions: []
                });
                ws.roomId = roomId;
                ws.playerIndex = 0;
                sendTo(ws, { type: 'ROOM_CREATED', roomId, team, playerIndex: 0, totalTeams: TOTAL_TEAMS });
                break;
            }

            case 'JOIN_ROOM': {
                const roomId = msg.roomId?.toUpperCase();
                const room = rooms.get(roomId);
                if (!room) { sendTo(ws, { type: 'ERROR', message: '방을 찾을 수 없습니다.' }); break; }
                if (room.players.length >= TOTAL_TEAMS) { sendTo(ws, { type: 'ERROR', message: '이미 가득 찬 방입니다.' }); break; }

                const playerIndex = room.players.length;
                const team = {
                    name: msg.teamName || `USER TEAM ${playerIndex + 1}`,
                    coachName: msg.coachName || `COACH ${playerIndex + 1}`,
                    roster: generateRoster(81), money: 1500, fatigue: 0, w: 0, l: 0, isBot: false
                };

                room.players.push(ws);
                room.teams.push(team);
                ws.roomId = roomId;
                ws.playerIndex = playerIndex;

                sendTo(ws, { type: 'ROOM_JOINED', roomId, team, playerIndex, currentPlayers: room.players.length });
                broadcast(room, { type: 'PLAYER_JOINED', count: room.players.length, teams: room.teams.map(t => t.name) });
                break;
            }

            case 'START_GAME': {
                const room = rooms.get(ws.roomId);
                if (!room || ws.playerIndex !== 0) break;

                // 부족한 인원 봇으로 채우기
                const humanCount = room.teams.length;
                const botCount = TOTAL_TEAMS - humanCount;

                for (let i = 0; i < botCount; i++) {
                    const botName = botTeamNames[i % botTeamNames.length] + " (BOT)";
                    room.teams.push({
                        name: botName,
                        coachName: "AI Coach",
                        roster: generateRoster(80 + Math.random() * 4), // 봇은 약간의 전력 차이를 둠
                        money: 1500, fatigue: 0, w: 0, l: 0, isBot: true
                    });
                }

                room.state = 'PLAYING';
                room.schedule = generateLeagueSchedule(TOTAL_TEAMS);
                broadcast(room, {
                    type: 'GAME_START',
                    teams: room.teams.map(t => ({ name: t.name, coachName: t.coachName, isBot: t.isBot })),
                    schedule: room.schedule
                });
                break;
            }

            case 'PLAYER_ACTION': {
                const room = rooms.get(ws.roomId);
                if (!room) break;

                if (!room.actions) room.actions = [];
                room.actions[ws.playerIndex] = msg.actions;
                sendTo(ws, { type: 'ACTION_RECEIVED' });

                // 현재 접속 중인 모든 '인간' 플레이어가 제출했는지 확인
                const humanIndices = room.teams.map((t, i) => t.isBot ? null : i).filter(i => i !== null);
                const allHumansSubmitted = humanIndices.every(idx => room.actions[idx]);

                if (allHumansSubmitted) {
                    // 1. 인간 플레이어 행동 적용
                    humanIndices.forEach(idx => {
                        const team = room.teams[idx];
                        const acts = room.actions[idx];
                        acts.forEach(act => {
                            if (act === 'rest') team.fatigue = Math.max(0, team.fatigue - 20);
                            else if (act === 'stream') { team.money += 200; team.fatigue += 15; }
                            else if (act === 'train') { team.fatigue += 10; if (Math.random() > 0.7) team.roster[Math.floor(Math.random() * 5)].ovr += 1; }
                            else if (act === 'scrim') { if (team.money >= 50) { team.money -= 50; team.fatigue += 25; if (Math.random() > 0.5) team.roster[Math.floor(Math.random() * 5)].ovr += 2; } }
                        });
                    });

                    // 2. 봇 플레이어 자동 행동 (간단한 로직)
                    room.teams.forEach((team, idx) => {
                        if (team.isBot) {
                            // 봇은 무작위로 훈련이나 스크림 진행
                            if (Math.random() > 0.5) team.roster[Math.floor(Math.random() * 5)].ovr += 1;
                        }
                    });

                    room.actions = [];
                    const currentWeekMatches = room.schedule[room.week - 1];

                    // 3. 경기 시뮬레이션
                    for (const match of currentWeekMatches) {
                        const [hIdx, aIdx] = match;
                        const home = room.teams[hIdx];
                        const away = room.teams[aIdx];

                        const hPower = getPower(getTeamOvr(home.roster));
                        const aPower = getPower(getTeamOvr(away.roster));
                        const homeWin = hPower >= aPower;

                        if (homeWin) { home.w++; home.money += 600; away.l++; }
                        else { away.w++; away.money += 600; home.l++; }

                        broadcast(room, {
                            type: 'MATCH_RESULT',
                            home: home.name, away: away.name,
                            winner: homeWin ? home.name : away.name,
                            week: room.week
                        });
                    }

                    room.week++;
                    if (room.week > room.schedule.length) {
                        const winner = [...room.teams].sort((a, b) => b.w - a.w)[0];
                        broadcast(room, { type: 'SEASON_END', winner: winner.name, teams: room.teams });
                        rooms.delete(ws.roomId);
                    } else {
                        broadcast(room, {
                            type: 'WEEK_START',
                            week: room.week,
                            teams: room.teams.map(t => ({ name: t.name, w: t.w, l: t.l, money: t.money, fatigue: t.fatigue, isBot: t.isBot }))
                        });
                    }
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        if (ws.roomId) {
            const room = rooms.get(ws.roomId);
            if (room) {
                // 한 명이라도 남아있으면 유지, 모두 나가면 삭제
                const stillConnected = room.players.some(p => p.readyState === 1);
                if (!stillConnected) rooms.delete(ws.roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 11-Team League (Bots included) running on port ${PORT}`));
