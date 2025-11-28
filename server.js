import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes de base
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Données en mémoire
const users = new Map();
const rooms = new Map();
const tournaments = new Map();
const leaderboard = new Map();

// Initialisation des données
function initializeData() {
  // Utilisateur admin par défaut
  users.set('admin', {
    id: '1',
    username: 'admin',
    password: bcrypt.hashSync('admin123', 12),
    email: 'admin@gamehub.com',
    stats: { totalGames: 0, wins: 0, totalScore: 0, level: 1 },
    createdAt: new Date()
  });

  // Classement initial
  leaderboard.set('all', [
    { username: 'ProGamer', score: 1250, avatar: 'P' },
    { username: 'MasterPlayer', score: 1100, avatar: 'M' },
    { username: 'GameChanger', score: 980, avatar: 'G' },
    { username: 'SkillShot', score: 720, avatar: 'S' },
    { username: 'EliteGamer', score: 680, avatar: 'E' }
  ]);
}

// API Routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    
    if (users.has(username)) {
      return res.status(400).json({ error: 'Nom d\'utilisateur déjà pris' });
    }

    const user = {
      id: 'user-' + Date.now(),
      username,
      password: bcrypt.hashSync(password, 12),
      email,
      stats: { totalGames: 0, wins: 0, totalScore: 0, level: 1 },
      achievements: [],
      createdAt: new Date()
    };

    users.set(username, user);
    
    const token = jwt.sign({ userId: user.id, username }, 'gamehub-secret', { expiresIn: '7d' });
    
    res.json({ 
      success: true, 
      user: { 
        id: user.id, 
        username: user.username, 
        stats: user.stats 
      }, 
      token 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = users.get(username);
    
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const token = jwt.sign({ userId: user.id, username }, 'gamehub-secret', { expiresIn: '7d' });
    
    res.json({ 
      success: true, 
      user: { 
        id: user.id, 
        username: user.username, 
        stats: user.stats 
      }, 
      token 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/leaderboard/:game?', (req, res) => {
  const game = req.params.game || 'all';
  const data = leaderboard.get(game) || [];
  res.json(data);
});

app.get('/api/stats', (req, res) => {
  const stats = {
    onlinePlayers: Array.from(rooms.values()).reduce((acc, room) => acc + room.players.length, 0),
    activeRooms: rooms.size,
    activeTournaments: tournaments.size,
    games: {
      morpion: Array.from(rooms.values()).filter(r => r.game === 'morpion').length,
      memory: Array.from(rooms.values()).filter(r => r.game === 'memory').length,
      snake: Array.from(rooms.values()).filter(r => r.game === 'snake').length
    }
  };
  res.json(stats);
});

// WebSocket Events
io.on('connection', (socket) => {
  console.log('🔗 Nouveau joueur connecté:', socket.id);

  socket.on('join-room', (data) => {
    const { game, playerName, roomId } = data;
    const roomKey = roomId || `${game}-${Date.now()}`;
    
    let room = rooms.get(roomKey);
    if (!room) {
      room = {
        id: roomKey,
        game,
        players: [],
        status: 'waiting',
        createdAt: new Date()
      };
      rooms.set(roomKey, room);
    }

    if (room.players.length < 4) {
      const player = {
        id: socket.id,
        name: playerName,
        joinedAt: new Date()
      };
      
      room.players.push(player);
      socket.join(roomKey);
      rooms.set(roomKey, room);

      // Notifier tous les joueurs
      io.to(roomKey).emit('player-joined', {
        player,
        room: room,
        players: room.players
      });

      // Mettre à jour les stats globales
      updateGlobalStats();
    } else {
      socket.emit('room-full', { message: 'Salle pleine' });
    }
  });

  socket.on('game-move', (data) => {
    const { game, move, roomId } = data;
    
    // Transmettre le mouvement aux autres joueurs
    socket.to(roomId).emit('opponent-move', {
      move,
      timestamp: new Date()
    });
  });

  socket.on('chat-message', (data) => {
    const { message, roomId } = data;
    
    // Diffuser le message à tous les joueurs de la salle
    io.to(roomId).emit('chat-message', {
      message,
      playerName: data.playerName,
      timestamp: new Date()
    });
  });

  socket.on('create-tournament', (data) => {
    const tournament = {
      id: 'tournament-' + Date.now(),
      ...data,
      status: 'registration',
      participants: [],
      createdAt: new Date()
    };
    
    tournaments.set(tournament.id, tournament);
    io.emit('tournament-created', tournament);
  });

  socket.on('join-tournament', (data) => {
    const { tournamentId, playerName } = data;
    const tournament = tournaments.get(tournamentId);
    
    if (tournament && tournament.status === 'registration') {
      if (!tournament.participants.includes(playerName)) {
        tournament.participants.push(playerName);
        tournaments.set(tournamentId, tournament);
        
        io.emit('tournament-updated', tournament);
        
        // Démarrer le tournoi si plein
        if (tournament.participants.length >= tournament.maxPlayers) {
          tournament.status = 'active';
          startTournament(tournamentId);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    // Nettoyer les salles et joueurs
    rooms.forEach((room, roomId) => {
      room.players = room.players.filter(p => p.id !== socket.id);
      
      if (room.players.length === 0) {
        rooms.delete(roomId);
      } else {
        rooms.set(roomId, room);
        io.to(roomId).emit('player-left', {
          players: room.players
        });
      }
    });
    
    updateGlobalStats();
  });
});

function updateGlobalStats() {
  const stats = {
    onlinePlayers: Array.from(rooms.values()).reduce((acc, room) => acc + room.players.length, 0),
    activeRooms: rooms.size,
    activeTournaments: tournaments.size,
    games: {
      morpion: Array.from(rooms.values()).filter(r => r.game === 'morpion').length,
      memory: Array.from(rooms.values()).filter(r => r.game === 'memory').length,
      snake: Array.from(rooms.values()).filter(r => r.game === 'snake').length
    },
    timestamp: new Date()
  };
  
  io.emit('global-stats-update', stats);
}

function startTournament(tournamentId) {
  const tournament = tournaments.get(tournamentId);
  if (tournament) {
    console.log(`🏆 Démarrage du tournoi: ${tournament.name}`);
    
    // Simuler le début du tournoi
    setTimeout(() => {
      tournament.status = 'active';
      tournaments.set(tournamentId, tournament);
      io.emit('tournament-started', tournament);
    }, 3000);
  }
}

// Initialiser les données
initializeData();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 GameHub Server démarré sur le port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
});
