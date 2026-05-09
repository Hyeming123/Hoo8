const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const helmet = require('helmet');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(helmet.contentSecurityPolicy({
    directives: {
        "default-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "script-src-attr": ["'unsafe-inline'"],
        "connect-src": ["'self'", "ws:", "wss:"]
    },
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── 상수 ──────────────────────────────────────────────
const MAX_PLAYERS = 8;
const BOT_NAMES   = ["T1","GEN","HLE","DK","KT","KDF","FOX","NS","DRX","BRO"];
const POSITIONS   = ["TOP","JGL","MID","BOT","SPT"];
const PLAYER_NAMES = ["Zeus","Kiin","Doran","Kingen","Morgan","Clear","Oner","Canyon","Peanut","Lucid",
    "Faker","Chovy","Zeka","ShowMaker","Bdd","Gumayusi","Ruler","Viper","Aiming","Keria",
    "Lehends","Delight","Kellin","BeryL","Pyosik","Cuzz","Sylvie","HO08","Siwoo","Callme"];

const SPR_PTS = {1:150,2:100,3:70,4:60,5:40,6:35,7:20,8:10};
const SUM_PTS = {1:9999,2:120,3:85,4:65,5:50,6:45,7:30,8:20};

const rooms = new Map();

// ── 유틸 ──────────────────────────────────────────────
function rng(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function genPlayer(pos, baseOvr) {
    return {
        name: pick(PLAYER_NAMES), pos,
        ovr: Math.floor(baseOvr + rng(-3, 3)), form: 0,
        price: Math.floor(Math.pow(Math.max(baseOvr - 60, 1), 1.8) * 8) + 100
    };
}

function genRoster(baseOvr) {
    return POSITIONS.map(pos => genPlayer(pos, baseOvr));
}

function teamOvr(roster, bonusLv = 0) {
    return roster.reduce((s, p) => s + p.ovr + p.form, 0) / 5 + bonusLv;
}

function getPwr(ovr, fatigue = 0) {
    let p = ovr;
    if (fatigue > 50) p -= (fatigue - 45) / 2;
    return p + rng(-12, 12);
}

function simSeries(hOvr, aOvr, hFatigue, aFatigue, wins) {
    let hw = 0, aw = 0;
    while (hw < wins && aw < wins) {
        if (getPwr(hOvr, hFatigue) >= getPwr(aOvr, aFatigue)) hw++; else aw++;
    }
    return { hw, aw, homeWin: hw > aw };
}

function broadcast(room, data) {
    const str = JSON.stringify(data);
    room.players.forEach(p => { if (p?.ws?.readyState === 1) p.ws.send(str); });
}

function sendTo(ws, data) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(data));
}

function getStandings(room) {
    return [...room.teams].sort((a, b) =>
        b.w - a.w || (b.sw - b.sl) - (a.sw - a.sl)
    );
}

// ── 더블 라운드로빈 스케줄 ──────────────────────────────
function genSchedule(teams) {
    let arr = [...teams, null]; // null = BYE
    if (arr.length % 2 !== 0) arr.push(null);
    const n = arr.length, rounds = n - 1, mpw = n / 2;
    const half = [];
    for (let r = 0; r < rounds; r++) {
        const wk = [];
        for (let i = 0; i < mpw; i++) {
            const h = arr[i], a = arr[n - 1 - i];
            if (h && a) wk.push([h, a]);
        }
        half.push(wk);
        arr.splice(1, 0, arr.pop());
    }
    return [...half, ...half.map(w => w.map(([h, a]) => [a, h]))];
}

// ── 봇 행동 적용 ─────────────────────────────────────
function applyBotActions(team) {
    if (Math.random() > 0.5) {
        const idx = Math.floor(Math.random() * 5);
        team.roster[idx].ovr += 1;
    }
}

// ── 플레이어 행동 적용 ────────────────────────────────
function applyActions(player, acts) {
    acts.forEach(act => {
        if (act === 'rest')   player.fatigue = Math.max(0, player.fatigue - 20);
        else if (act === 'stream') { player.money += 200; player.fatigue += 15; }
        else if (act === 'train')  {
            player.fatigue += 10;
            if (Math.random() > 0.7) player.roster[Math.floor(Math.random() * 5)].ovr += 1;
        }
        else if (act === 'scrim')  {
            if (player.money >= 50) {
                player.money -= 50; player.fatigue += 25;
                if (Math.random() > 0.5) player.roster[Math.floor(Math.random() * 5)].ovr += 2;
            }
        }
    });
}

// ── 주간 경기 시뮬 ────────────────────────────────────
function simWeek(room) {
    const results = [];
    const wk = room.schedule[room.week - 1];

    wk.forEach(([home, away]) => {
        const hOvr = teamOvr(home.roster, home.isBot ? 0 : (home.coachLv - 1));
        const aOvr = teamOvr(away.roster, away.isBot ? 0 : (away.coachLv - 1));
        const res = simSeries(hOvr, aOvr, home.fatigue || 0, away.fatigue || 0, 2);

        const winner = res.homeWin ? home : away;
        const loser  = res.homeWin ? away : home;
        winner.w++; loser.l++;
        winner.sw += Math.max(res.hw, res.aw);
        winner.sl += Math.min(res.hw, res.aw);
        loser.sw  += Math.min(res.hw, res.aw);
        loser.sl  += Math.max(res.hw, res.aw);
        winner.money = (winner.money || 1500) + 600;

        results.push({ home: home.name, away: away.name, hw: res.hw, aw: res.aw, winner: winner.name });
    });
    return results;
}

// ── 플레이오프 시뮬 (전체 즉시) ───────────────────────
function simPO(room) {
    const sorted = getStandings(room);
    sorted.forEach((t, i) => t.regRank = i + 1);
    const seeds = sorted.slice(0, 8);
    const out   = sorted.slice(8);
    out.forEach((t, i) => t.splitRank = 9 + i);

    const bo5 = (a, b) => {
        const aOvr = teamOvr(a.roster, a.isBot ? 0 : (a.coachLv - 1));
        const bOvr = teamOvr(b.roster, b.isBot ? 0 : (b.coachLv - 1));
        const r = simSeries(aOvr, bOvr, a.fatigue || 0, b.fatigue || 0, 3);
        return { winner: r.homeWin ? a : b, loser: r.homeWin ? b : a, hw: r.hw, aw: r.aw };
    };

    const log = [];

    // Play-in
    let pi1 = bo5(seeds[4], seeds[7]); pi1.loser.splitRank = 8; log.push({phase:'PI M1', ...fmtMatch(pi1)});
    let pi2 = bo5(seeds[5], seeds[6]); pi2.loser.splitRank = 7; log.push({phase:'PI M2', ...fmtMatch(pi2)});
    let piW = bo5(pi1.winner, pi2.winner); log.push({phase:'PI Win', ...fmtMatch(piW)});
    let piL = bo5(pi1.loser,  pi2.loser);  log.push({phase:'PI Los', ...fmtMatch(piL)});
    let piF = bo5(piW.loser,  piL.winner); piF.loser.splitRank = 6; log.push({phase:'PI Final', ...fmtMatch(piF)});
    seeds[4] = piW.winner; seeds[5] = piF.winner;

    // 1R & 2R
    let r1a = bo5(seeds[2], seeds[4]); r1a.loser.splitRank = 5; log.push({phase:'PO 1R M1', ...fmtMatch(r1a)});
    let r1b = bo5(seeds[3], seeds[5]); r1b.loser.splitRank = 6; log.push({phase:'PO 1R M2', ...fmtMatch(r1b)});
    let r2a = bo5(seeds[0], r1a.winner); log.push({phase:'PO 2R M1', ...fmtMatch(r2a)});
    let r2b = bo5(seeds[1], r1b.winner); log.push({phase:'PO 2R M2', ...fmtMatch(r2b)});

    // Finals
    let w3 = bo5(r2a.winner, r2b.winner); log.push({phase:'W-Bracket', ...fmtMatch(w3)});
    let l3 = bo5(r2a.loser,  r2b.loser);  l3.loser.splitRank = 4; log.push({phase:'L-Bracket', ...fmtMatch(l3)});
    let lf = bo5(w3.loser, l3.winner);    lf.loser.splitRank = 3; log.push({phase:'Lower Final', ...fmtMatch(lf)});
    let gf = bo5(w3.winner, lf.winner);   log.push({phase:'Grand Final', ...fmtMatch(gf)});

    gf.loser.splitRank = 2; gf.winner.splitRank = 1;
    return { log, champion: gf.winner.name };
}

function fmtMatch(r) {
    return { winner: r.winner.name, loser: r.loser.name, score: `${r.hw}:${r.aw}` };
}

// ── 월즈 시뮬 ─────────────────────────────────────────
const FOREIGN = ["BLG","TES","JDG","WBG","G2","FNC","TL","C9","PSG","GAM","FLY","NIP"];
function simWorlds(room) {
    const sorted = [...room.teams].sort((a, b) => b.champPts - a.champPts);
    const qualified = sorted.slice(0, 4);
    const foreignTeams = FOREIGN.slice(0, 12).map(name => ({
        name, roster: genRoster(75 + rng(0, 20)), fatigue: 0, isBot: true, coachLv: 1
    }));
    const all = [...qualified, ...foreignTeams].sort(() => Math.random() - 0.5).slice(0, 16);

    const groups = [[], [], [], []];
    all.forEach((t, i) => { t.w = 0; t.l = 0; groups[i % 4].push(t); });

    groups.forEach(grp => {
        for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
            for (let r = 0; r < 2; r++) {
                const res = simSeries(teamOvr(grp[i].roster), teamOvr(grp[j].roster), 0, 0, 2);
                if (res.homeWin) { grp[i].w++; grp[j].l++; } else { grp[j].w++; grp[i].l++; }
            }
        }
        grp.sort((a, b) => b.w - a.w);
    });

    const ko = [
        groups[0][0], groups[1][1], groups[2][0], groups[3][1],
        groups[1][0], groups[0][1], groups[3][0], groups[2][1]
    ];

    const bo5 = (a, b) => {
        const r = simSeries(teamOvr(a.roster), teamOvr(b.roster), 0, 0, 3);
        return { winner: r.homeWin ? a : b, loser: r.homeWin ? b : a, hw: r.hw, aw: r.aw };
    };

    const log = [];
    const qf1 = bo5(ko[0], ko[1]); log.push({phase:'QF1', ...fmtMatch(qf1)});
    const qf2 = bo5(ko[2], ko[3]); log.push({phase:'QF2', ...fmtMatch(qf2)});
    const qf3 = bo5(ko[4], ko[5]); log.push({phase:'QF3', ...fmtMatch(qf3)});
    const qf4 = bo5(ko[6], ko[7]); log.push({phase:'QF4', ...fmtMatch(qf4)});
    const sf1 = bo5(qf1.winner, qf2.winner); log.push({phase:'SF1', ...fmtMatch(sf1)});
    const sf2 = bo5(qf3.winner, qf4.winner); log.push({phase:'SF2', ...fmtMatch(sf2)});
    const fin = bo5(sf1.winner, sf2.winner); log.push({phase:'Final', ...fmtMatch(fin)});

    return { log, champion: fin.winner.name, groups, ko };
}

// ── 방 진행 로직 ──────────────────────────────────────
function advanceWeek(room) {
    const results = simWeek(room);
    broadcast(room, { type: 'WEEK_RESULT', week: room.week, results, teams: publicTeams(room) });
    room.week++;

    if (room.week > room.schedule.length) {
        startPO(room);
    } else {
        // 공통 브로드캐스트
        broadcast(room, { type: 'WEEK_START', week: room.week, teams: publicTeams(room) });
        // 각 플레이어에게 개인 피로도/자금 전송
        room.players.forEach(p => {
            sendTo(p.ws, { type: 'MY_STATUS', fatigue: p.fatigue, money: p.money });
        });
        room.pendingActions = {};
    }
}

function startPO(room) {
    broadcast(room, { type: 'PO_START', teams: publicTeams(room) });
    const res = simPO(room);

    // 챔피언 포인트 적용
    const ptsTable = room.split === 'SPRING' ? SPR_PTS : SUM_PTS;
    room.teams.forEach(t => { if (ptsTable[t.splitRank]) t.champPts = (t.champPts || 0) + ptsTable[t.splitRank]; });

    broadcast(room, { type: 'PO_RESULT', log: res.log, champion: res.champion, teams: publicTeams(room) });

    if (room.split === 'SPRING') {
        room.split = 'SUMMER';
        setTimeout(() => startSplit(room), 2000);
    } else {
        setTimeout(() => startWorlds(room), 2000);
    }
}

function startWorlds(room) {
    broadcast(room, { type: 'WORLDS_START' });
    const res = simWorlds(room);
    broadcast(room, { type: 'WORLDS_RESULT', log: res.log, champion: res.champion });
    setTimeout(() => stoveLeague(room), 2000);
}

function stoveLeague(room) {
    room.year++;
    room.teams.forEach(t => {
        t.champPts = 0;
        t.roster.forEach(p => { p.ovr += Math.floor(rng(-2, 4)); p.form = 0; });
        if (!t.isBot) {
            // 유저 팀 마켓 리프레시
            const p = room.players.find(pl => pl.teamName === t.name);
            if (p) sendTo(p.ws, { type: 'STOVE', year: room.year });
        }
    });
    broadcast(room, { type: 'STOVE_LEAGUE', year: room.year });
    setTimeout(() => startSplit(room), 3000);
}

function startSplit(room) {
    room.week = 1;
    room.pendingActions = {};
    room.teams.forEach(t => {
        t.w = 0; t.l = 0; t.sw = 0; t.sl = 0; t.splitRank = 11;
        if (!t.isBot) {
            const p = room.players.find(pl => pl.teamName === t.name);
            if (p) p.fatigue = 0;
        }
        // 봇 form 랜덤화
        if (t.isBot) t.roster.forEach(p => { p.form = Math.floor(rng(-2, 3)); });
    });
    room.schedule = genSchedule(room.teams);
    broadcast(room, {
        type: 'SPLIT_START', split: room.split, year: room.year,
        schedule: room.schedule.map(wk => wk.map(([h, a]) => [h.name, a.name])),
        teams: publicTeams(room), week: room.week
    });
}

function publicTeams(room) {
    return room.teams.map(t => ({
        name: t.name, isBot: t.isBot,
        w: t.w, l: t.l, sw: t.sw || 0, sl: t.sl || 0,
        champPts: t.champPts || 0, splitRank: t.splitRank || 0,
        ovr: Math.floor(teamOvr(t.roster))
    }));
}

function checkAllSubmitted(room) {
    const humanNames = room.players.filter(p => p.ws?.readyState === 1).map(p => p.teamName);
    return humanNames.every(name => room.pendingActions[name]);
}

// ── WebSocket ─────────────────────────────────────────
wss.on('connection', ws => {
    ws.id = uuidv4();

    ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            case 'CREATE_ROOM': {
                const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
                const team = {
                    name: msg.teamName, isBot: false,
                    roster: genRoster(81), money: 1500, fatigue: 0,
                    w:0, l:0, sw:0, sl:0, champPts:0, splitRank:0, coachLv:1
                };
                const player = { ws, teamName: msg.teamName, fatigue: 0, money: 1500, coachLv: 1, roster: team.roster };
                const room = {
                    id: roomId, players: [player], teams: [team],
                    state: 'WAITING', week: 1, split: 'SPRING', year: 1,
                    schedule: [], pendingActions: {}
                };
                rooms.set(roomId, room);
                ws.roomId = roomId;
                sendTo(ws, { type: 'ROOM_CREATED', roomId, team, playerIndex: 0 });
                break;
            }

            case 'JOIN_ROOM': {
                const room = rooms.get(msg.roomId?.toUpperCase());
                if (!room) { sendTo(ws, { type: 'ERROR', message: '방을 찾을 수 없습니다.' }); break; }
                if (room.state !== 'WAITING') { sendTo(ws, { type: 'ERROR', message: '이미 시작된 방입니다.' }); break; }
                if (room.players.length >= MAX_PLAYERS) { sendTo(ws, { type: 'ERROR', message: '방이 가득 찼습니다.' }); break; }

                const team = {
                    name: msg.teamName, isBot: false,
                    roster: genRoster(81), money: 1500, fatigue: 0,
                    w:0, l:0, sw:0, sl:0, champPts:0, splitRank:0, coachLv:1
                };
                const player = { ws, teamName: msg.teamName, fatigue: 0, money: 1500, coachLv: 1, roster: team.roster };
                room.players.push(player);
                room.teams.push(team);
                ws.roomId = msg.roomId.toUpperCase();

                sendTo(ws, { type: 'ROOM_JOINED', roomId: room.id, team, playerIndex: room.players.length - 1 });
                broadcast(room, { type: 'PLAYER_JOINED', teams: room.teams.map(t => t.name), count: room.teams.length });
                break;
            }

            case 'START_GAME': {
                const room = rooms.get(ws.roomId);
                if (!room || room.players[0].ws !== ws) break;

                // 봇으로 채우기 (11팀)
                const botCount = 11 - room.teams.length;
                const usedBots = BOT_NAMES.slice(0, botCount);
                usedBots.forEach(name => {
                    room.teams.push({
                        name, isBot: true,
                        roster: genRoster(78 + rng(0, 6)), money: 1500, fatigue: 0,
                        w:0, l:0, sw:0, sl:0, champPts:0, splitRank:0, coachLv:1
                    });
                });

                room.state = 'PLAYING';
                room.schedule = genSchedule(room.teams);

                // 각 플레이어 초기 FA 생성
                room.players.forEach(p => {
                    p.fa = Array.from({length:6}, () => genPlayer(pick(POSITIONS), 75 + Math.floor(rng(0, 15))));
                });

                broadcast(room, {
                    type: 'GAME_START', split: 'SPRING', year: 1,
                    teams: publicTeams(room),
                    schedule: room.schedule.map(wk => wk.map(([h, a]) => [h.name, a.name])),
                    week: 1
                });

                // 각 플레이어에게 개인 FA 전송
                room.players.forEach(p => {
                    sendTo(p.ws, { type: 'MARKET_REFRESHED', fa: p.fa, money: p.money });
                });
                break;
            }

            case 'PLAYER_ACTION': {
                const room = rooms.get(ws.roomId);
                if (!room) break;
                const player = room.players.find(p => p.ws === ws);
                if (!player) break;

                // 행동 적용
                applyActions(player, msg.actions);
                // 팀 데이터에 반영
                const team = room.teams.find(t => t.name === player.teamName);
                if (team) { team.roster = player.roster; team.money = player.money; team.fatigue = player.fatigue; }

                room.pendingActions[player.teamName] = true;
                sendTo(ws, { type: 'ACTION_RECEIVED' });

                if (checkAllSubmitted(room)) {
                    // 봇 행동
                    room.teams.filter(t => t.isBot).forEach(t => applyBotActions(t));
                    advanceWeek(room);
                }
                break;
            }

            case 'BUY_PLAYER': {
                const room = rooms.get(ws.roomId);
                if (!room) break;
                const player = room.players.find(p => p.ws === ws);
                const team = room.teams.find(t => t.name === player?.teamName);
                if (!player || !team) break;

                const idx = msg.faIndex;
                if (!player.fa || idx == null || !player.fa[idx]) {
                    sendTo(ws, { type: 'ERROR', message: '유효하지 않은 선수입니다.' }); break;
                }
                const buyP = player.fa[idx];
                if (player.money < buyP.price) { sendTo(ws, { type: 'ERROR', message: '자금 부족' }); break; }

                const existIdx = player.roster.findIndex(p => p.pos === buyP.pos);
                if (existIdx > -1) player.roster[existIdx] = buyP;
                else player.roster.push(buyP);
                player.money -= buyP.price;
                player.fa.splice(idx, 1);
                team.roster = player.roster; team.money = player.money;

                sendTo(ws, { type: 'PLAYER_BOUGHT', roster: player.roster, money: player.money, fa: player.fa });
                break;
            }

            case 'REFRESH_MARKET': {
                const room = rooms.get(ws.roomId);
                if (!room) break;
                const player = room.players.find(p => p.ws === ws);
                if (!player) break;
                if (player.money < 50) { sendTo(ws, { type: 'ERROR', message: '자금 부족 (50G)' }); break; }
                player.money -= 50;
                const team = room.teams.find(t => t.name === player.teamName);
                if (team) team.money = player.money;

                player.fa = Array.from({length:6}, () => genPlayer(pick(POSITIONS), 75 + Math.floor(rng(0, 15))));
                sendTo(ws, { type: 'MARKET_REFRESHED', fa: player.fa, money: player.money });
                break;
            }
        }
    });

    ws.on('close', () => {
        const room = rooms.get(ws.roomId);
        if (!room) return;
        if (room.state === 'WAITING') {
            room.players = room.players.filter(p => p.ws !== ws);
            room.teams = room.teams.filter(t => !room.players.every(p => p.teamName !== t.name) || t.isBot);
        }
        if (room.players.every(p => p.ws.readyState !== 1)) rooms.delete(ws.roomId);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Esports Manager Hardcore Multiplayer on port ${PORT}`));
