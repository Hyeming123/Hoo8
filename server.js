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

<<<<<<< HEAD
// --- Middleware ---
app.use(helmet.contentSecurityPolicy({
    directives: {
        "default-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", "ws:", "wss:"]
    },
}));
=======
const express = require('express');
const helmet = require('helmet');

app.use(
    helmet.contentSecurityPolicy({
        directives: {
            "default-src": ["'self'"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com"],
            "script-src": ["'self'", "'unsafe-inline'"],
            // 필요한 다른 소스들도 추가
        },
    })
);

>>>>>>> 98d3efc169b8eecfa2cdb383f323b28b1ee4aaee
app.use(express.static(path.join(__dirname, 'public')));

// --- Room Management ---
const rooms = new Map(); // roomId -> { players: [ws, ws], state: {} }

function broadcast(room, data) {
    room.players.forEach(p => {
        if (p && p.readyState === 1) p.send(JSON.stringify(data));
    });
}

function sendTo(ws, data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

// --- Claude AI Commentator ---
async function getClaudeCommentary(matchContext) {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20240620', // 최신 모델명으로 업데이트 권장
            max_tokens: 300,
            messages: [{
                role: 'user',
                content: `당신은 e스포츠 경기 해설가입니다. 다음 경기 상황을 짧고 흥미롭게 한국어로 해설해주세요 (2-3문장).
경기: ${matchContext.home} vs ${matchContext.away}
세트: ${matchContext.homeWins} : ${matchContext.awayWins}
방금 일어난 일: ${matchContext.event}
홈팀 전력: ${matchContext.homePower} / 원정팀 전력: ${matchContext.awayPower}
해설만 출력하고 다른 말은 하지 마세요.`
            }]
        });
        return response.content[0].text;
    } catch (e) {
        console.error('Claude Commentary Error:', e);
        return null;
    }
}

async function getMatchSummary(matchContext) {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20240620',
            max_tokens: 200,
            messages: [{
                role: 'user',
                content: `e스포츠 감독 대결 게임의 경기 결과입니다. 승패를 포함한 짧은 총평을 한국어로 작성해주세요 (2문장).
${matchContext.winner} 가 ${matchContext.loser}를 ${matchContext.score}로 꺾었습니다.
홈팀 감독: ${matchContext.homeCoach} / 원정팀 감독: ${matchContext.awayCoach}
총평만 출력하세요.`
            }]
        });
        return response.content[0].text;
    } catch (e) {
        console.error('Claude Summary Error:', e);
        return null;
    }
}

// --- Game Logic ---
const positions = ["TOP", "JGL", "MID", "BOT", "SPT"];
const playerNames = [
    "Zeus", "Kiin", "Doran", "Kingen", "Morgan", "Oner", "Canyon", "Peanut", "Lucid",
    "Faker", "Chovy", "Zeka", "ShowMaker", "Bdd", "Gumayusi", "Ruler", "Viper", "Aiming",
    "Keria", "Lehends", "Delight", "Kellin", "BeryL", "Pyosik", "Cuzz", "Sylvie", "Clear"
];

function randName() { return playerNames[Math.floor(Math.random() * playerNames.length)]; }

function generateRoster(baseOvr) {
    return positions.map(pos => ({
        name: randName(), pos,
        ovr: Math.floor(baseOvr + (Math.random() * 6 - 3)),
        form: 0
    }));
}

function getTeamOvr(roster) {
    return roster.reduce((a, b) => a + b.ovr + b.form, 0) / 5;
}

function getPower(ovr) {
    return ovr + (Math.random() * 24 - 12);
}

async function playSeriesOnline(room, homeTeam, awayTeam, targetWins) {
    let hW = 0, aW = 0, set = 1;

    while (hW < targetWins && aW < targetWins) {
        const hOvr = getTeamOvr(homeTeam.roster);
        const aOvr = getTeamOvr(awayTeam.roster);
        const hPower = getPower(hOvr);
        const aPower = getPower(aOvr);
        const homeWin = hPower >= aPower;

        if (homeWin) hW++; else aW++;

        // Claude 해설 요청
        const commentary = await getClaudeCommentary({
            home: homeTeam.name,
            away: awayTeam.name,
            homeWins: hW,
            awayWins: aW,
            event: `SET ${set} - ${homeWin ? homeTeam.name : awayTeam.name} 승리!`,
            homePower: Math.round(hPower),
            awayPower: Math.round(aPower)
        });

        broadcast(room, {
            type: 'SET_RESULT',
            set, hW, aW,
            setWinner: homeWin ? homeTeam.name : awayTeam.name,
            commentary
        });

        await new Promise(r => setTimeout(r, 800));
        set++;
    }

    const winner = hW > aW ? homeTeam : awayTeam;
    const loser = hW > aW ? awayTeam : homeTeam;

    const summary = await getMatchSummary({
        winner: winner.name,
        loser: loser.name,
        score: `${Math.max(hW, aW)}:${Math.min(hW, aW)}`,
        homeCoach: homeTeam.coachName,
        awayCoach: awayTeam.coachName
    });

    return { winner, loser, hW, aW, summary };
}

// --- WebSocket Handler ---
wss.on('connection', (ws) => {
    ws.id = uuidv4();
    ws.roomId = null;

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case 'CREATE_ROOM': {
                const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
                const roster = generateRoster(81);
                const team = {
                    name: msg.teamName || 'TEAM A',
                    coachName: msg.coachName || 'COACH',
                    roster, money: 1500, fatigue: 0,
                    w: 0, l: 0
                };
                rooms.set(roomId, {
                    id: roomId,
                    players: [ws, null],
                    teams: [team, null],
                    state: 'WAITING',
                    week: 1
                });
                ws.roomId = roomId;
                ws.playerIndex = 0;
                sendTo(ws, { type: 'ROOM_CREATED', roomId, team, playerIndex: 0 });
                break;
            }

            case 'JOIN_ROOM': {
                const roomId = msg.roomId?.toUpperCase();
                const room = rooms.get(roomId);
                if (!room) { sendTo(ws, { type: 'ERROR', message: '방을 찾을 수 없습니다.' }); break; }
                if (room.players[1]) { sendTo(ws, { type: 'ERROR', message: '이미 가득 찬 방입니다.' }); break; }

                const roster = generateRoster(81);
                const team = {
                    name: msg.teamName || 'TEAM B',
                    coachName: msg.coachName || 'COACH 2',
                    roster, money: 1500, fatigue: 0,
                    w: 0, l: 0
                };
                room.players[1] = ws;
                room.teams[1] = team;
                room.state = 'READY';
                ws.roomId = roomId;
                ws.playerIndex = 1;

                sendTo(ws, { type: 'ROOM_JOINED', roomId, team, playerIndex: 1, opponentTeam: { name: room.teams[0].name, coachName: room.teams[0].coachName } });
                sendTo(room.players[0], { type: 'OPPONENT_JOINED', opponentTeam: { name: team.name, coachName: team.coachName } });
                broadcast(room, { type: 'GAME_START', teams: room.teams.map(t => ({ name: t.name, coachName: t.coachName })) });
                break;
            }

            case 'PLAYER_ACTION': {
                const room = rooms.get(ws.roomId);
                if (!room) break;
                const idx = ws.playerIndex;

                if (!room.actions) room.actions = [null, null];
                room.actions[idx] = msg.actions;

                sendTo(ws, { type: 'ACTION_RECEIVED' });

                if (room.actions[0] && room.actions[1]) {
                    room.teams.forEach((team, ti) => {
                        const acts = room.actions[ti];
                        acts.forEach(act => {
                            if (act === 'rest') team.fatigue = Math.max(0, team.fatigue - 20);
                            else if (act === 'stream') { team.money += 200; team.fatigue += 15; }
                            else if (act === 'train') { team.fatigue += 10; if (Math.random() > 0.7) { team.roster[Math.floor(Math.random() * 5)].ovr += 1; } }
                            else if (act === 'scrim') { if (team.money >= 50) { team.money -= 50; team.fatigue += 25; if (Math.random() > 0.5) team.roster[Math.floor(Math.random() * 5)].ovr += 2; } }
                        });
                    });

                    room.actions = [null, null];
                    broadcast(room, { type: 'WEEK_START', week: room.week });

                    const homeTeam = { ...room.teams[0] };
                    const awayTeam = { ...room.teams[1] };

                    if (room.teams[0].fatigue > 50) homeTeam.roster = homeTeam.roster.map(p => ({ ...p, ovr: p.ovr - Math.floor((room.teams[0].fatigue - 45) / 2) }));
                    if (room.teams[1].fatigue > 50) awayTeam.roster = awayTeam.roster.map(p => ({ ...p, ovr: p.ovr - Math.floor((room.teams[1].fatigue - 45) / 2) }));

                    const result = await playSeriesOnline(room, { ...homeTeam, name: room.teams[0].name, coachName: room.teams[0].coachName }, { ...awayTeam, name: room.teams[1].name, coachName: room.teams[1].coachName }, 2);

                    const winnerIdx = result.winner.name === room.teams[0].name ? 0 : 1;
                    room.teams[winnerIdx].w++;
                    room.teams[winnerIdx].money += 600;
                    room.teams[1 - winnerIdx].l++;

                    room.week++;

                    broadcast(room, {
                        type: 'MATCH_RESULT',
                        hW: result.hW,
                        aW: result.aW,
                        winner: result.winner.name,
                        summary: result.summary,
                        teams: room.teams.map(t => ({ name: t.name, w: t.w, l: t.l, money: t.money, fatigue: t.fatigue }))
                    });

                    if (room.week > 10) {
                        const winner = room.teams[0].w >= room.teams[1].w ? room.teams[0] : room.teams[1];
                        broadcast(room, { type: 'SEASON_END', winner: winner.name, teams: room.teams });
                        rooms.delete(ws.roomId);
                    }
                }
                break;
            }

            case 'PING':
                sendTo(ws, { type: 'PONG' });
                break;
        }
    });

    ws.on('close', () => {
        if (ws.roomId) {
            const room = rooms.get(ws.roomId);
            if (room) {
                broadcast(room, { type: 'OPPONENT_LEFT' });
                rooms.delete(ws.roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Esports Manager server running on port ${PORT}`));