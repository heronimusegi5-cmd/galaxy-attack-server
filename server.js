// server.js — Galaxy Attack Multiplayer Server
const WebSocket = require('ws');
const http = require('http');

// Buat HTTP server untuk health check (Railway/Render butuh ini)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Galaxy Attack Server is Running!');
});

const wss = new WebSocket.Server({ server });

// Room system: { roomId: { players: Map, hostId, level, enemies, ... } }
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcastToRoom(roomId, message, excludeId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(message);
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }

    switch (msg.type) {
      // === CREATE ROOM ===
      case 'create_room': {
        roomId = generateRoomId();
        playerId = msg.playerId || 'P' + Math.random().toString(36).substring(2, 8);
        
        rooms.set(roomId, {
          hostId: playerId,
          players: new Map(),
          createdAt: Date.now(),
          gameState: {
            level: msg.level || 1,
            score: 0,
            inProgress: false,
          },
        });

        rooms.get(roomId).players.set(playerId, {
          id: playerId,
          name: msg.name || 'Player',
          ws,
          x: 0, y: 0, hp: 100, maxHp: 100,
          score: 0,
          shipId: msg.shipId || 'scout',
          alive: true,
          joinedAt: Date.now(),
        });

        ws.send(JSON.stringify({
          type: 'room_created',
          roomId,
          playerId,
          isHost: true,
          maxPlayers: 10,
        }));
        console.log(`Room ${roomId} created by ${playerId}`);
        break;
      }

      // === JOIN ROOM ===
      case 'join_room': {
        const targetRoom = msg.roomId?.toUpperCase();
        const room = rooms.get(targetRoom);
        
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room tidak ditemukan!' }));
          return;
        }
        if (room.players.size >= 10) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room penuh! (max 10)' }));
          return;
        }

        roomId = targetRoom;
        playerId = msg.playerId || 'P' + Math.random().toString(36).substring(2, 8);

        room.players.set(playerId, {
          id: playerId,
          name: msg.name || 'Player',
          ws,
          x: 0, y: 0, hp: 100, maxHp: 100,
          score: 0,
          shipId: msg.shipId || 'scout',
          alive: true,
          joinedAt: Date.now(),
        });

        // Kirim info ke yang join
        ws.send(JSON.stringify({
          type: 'room_joined',
          roomId,
          playerId,
          isHost: false,
          players: Array.from(room.players.values()).map(p => ({
            id: p.id, name: p.name, x: p.x, y: p.y,
            hp: p.hp, maxHp: p.maxHp, score: p.score,
            shipId: p.shipId, alive: p.alive,
          })),
        }));

        // Broadcast ke yang lain
        broadcastToRoom(roomId, {
          type: 'player_joined',
          player: {
            id: playerId, name: msg.name || 'Player',
            x: 0, y: 0, hp: 100, maxHp: 100,
            score: 0, shipId: msg.shipId || 'scout', alive: true,
          },
        }, playerId);

        console.log(`${playerId} joined room ${roomId}`);
        break;
      }

      // === PLAYER UPDATE (posisi, hp) ===
      case 'player_update': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player) return;

        player.x = msg.x;
        player.y = msg.y;
        player.hp = msg.hp;
        player.maxHp = msg.maxHp;
        player.score = msg.score;
        player.alive = msg.alive;

        broadcastToRoom(roomId, {
          type: 'player_update',
          id: playerId,
          x: msg.x, y: msg.y,
          hp: msg.hp, maxHp: msg.maxHp,
          score: msg.score, alive: msg.alive,
        }, playerId);
        break;
      }

      // === SHOOT ===
      case 'shoot': {
        if (!roomId) return;
        broadcastToRoom(roomId, {
          type: 'player_shoot',
          id: playerId,
          x: msg.x, y: msg.y,
          vx: msg.vx, vy: msg.vy,
          color: msg.color,
        }, playerId);
        break;
      }

      // === HOST: START GAME ===
      case 'start_game': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room || room.hostId !== playerId) return;
        room.gameState.inProgress = true;
        room.gameState.level = msg.level || 1;
        broadcastToRoom(roomId, {
          type: 'game_started',
          level: msg.level || 1,
        });
        break;
      }

      // === HOST: SPAWN ENEMY ===
      case 'spawn_enemy': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room || room.hostId !== playerId) return;
        broadcastToRoom(roomId, {
          type: 'enemy_spawned',
          enemy: msg.enemy,
        }, playerId);
        break;
      }

      // === HOST: SYNC ENEMIES (batch tiap 100ms) ===
      case 'sync_enemies': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room || room.hostId !== playerId) return;
        broadcastToRoom(roomId, {
          type: 'enemies_sync',
          enemies: msg.enemies,
        }, playerId);
        break;
      }

      // === HOST: LEVEL COMPLETE ===
      case 'level_complete': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room || room.hostId !== playerId) return;
        room.gameState.level = msg.nextLevel;
        broadcastToRoom(roomId, {
          type: 'level_completed',
          nextLevel: msg.nextLevel,
        });
        break;
      }

      // === CHAT ===
      case 'chat': {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player) return;
        broadcastToRoom(roomId, {
          type: 'chat',
          name: player.name,
          message: msg.message,
        });
        break;
      }

      // === LEAVE ROOM ===
      case 'leave_room': {
        handleLeave();
        break;
      }
    }
  });

  function handleLeave() {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(playerId);
    
    // Kalau host keluar, pindah ke player lain atau hapus room
    if (room.hostId === playerId) {
      if (room.players.size > 0) {
        const newHostId = room.players.keys().next().value;
        room.hostId = newHostId;
        broadcastToRoom(roomId, {
          type: 'host_changed',
          newHostId,
        });
      } else {
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty)`);
        return;
      }
    }

    broadcastToRoom(roomId, {
      type: 'player_left',
      id: playerId,
    });

    console.log(`${playerId} left room ${roomId}`);
  }

  ws.on('close', () => {
    handleLeave();
  });

  ws.on('error', (err) => {
    console.error('WS error:', err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Galaxy Attack Server running on port ${PORT}`);
});

// Cleanup room kosong tiap 5 menit
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (room.players.size === 0 && now - room.createdAt > 5 * 60 * 1000) {
      rooms.delete(id);
      console.log(`Auto-cleanup room ${id}`);
    }
  });
}, 60 * 1000);
