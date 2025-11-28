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
const activePlayers = new Set();

// Initialisation des données
function initializeData() {
  users.set('admin', {
    id: '1',
    username: 'admin',
    password: bcrypt.hashSync('admin123', 12),
    email: 'admin@gamehub.com',
    stats: { totalGames: 0, wins: 0, totalScore: 0, level: 1 },
    createdAt: new Date()
  });
  updateLeaderboard();
}

// Mettre à jour le classement
function updateLeaderboard() {
  const allPlayers = Array.from(users.values())
    .map(user => ({
      username: user.username,
      score: user.stats.totalScore,
      avatar: user.username.charAt(0).toUpperCase(),
      level: user.stats.level
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  leaderboard.set('all', allPlayers);
  io.emit('leaderboard-update', allPlayers);
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
    updateLeaderboard();
    
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

// API pour les salles
app.get('/api/rooms/:game', (req, res) => {
  const game = req.params.game;
  const availableRooms = Array.from(rooms.values())
    .filter(room => room.game === game && room.players.length < 2)
    .map(room => ({
      id: room.id,
      players: room.players.length,
      status: room.status,
      game: room.game
    }));
  res.json(availableRooms);
});

app.get('/api/leaderboard/:game?', (req, res) => {
  const game = req.params.game || 'all';
  let data = leaderboard.get(game) || [];
  
  if (data.length === 0) {
    data = [
      { username: 'ProGamer', score: 1250 + Math.floor(Math.random() * 500), avatar: 'P' },
      { username: 'MasterPlayer', score: 1100 + Math.floor(Math.random() * 400), avatar: 'M' },
      { username: 'GameChanger', score: 980 + Math.floor(Math.random() * 300), avatar: 'G' },
      { username: 'SkillShot', score: 720 + Math.floor(Math.random() * 200), avatar: 'S' },
      { username: 'EliteGamer', score: 680 + Math.floor(Math.random() * 150), avatar: 'E' },
      { username: 'VictoryRoyale', score: 540 + Math.floor(Math.random() * 100), avatar: 'V' },
      { username: 'NoobSlayer', score: 420 + Math.floor(Math.random() * 80), avatar: 'N' }
    ].sort((a, b) => b.score - a.score);
  }
  
  res.json(data);
});

app.get('/api/stats', (req, res) => {
  const stats = {
    onlinePlayers: activePlayers.size,
    activeRooms: rooms.size,
    activeTournaments: tournaments.size,
    games: {
      morpion: Array.from(rooms.values()).filter(r => r.game === 'morpion').length,
      memory: Array.from(rooms.values()).filter(r => r.game === 'memory').length,
      snake: Array.from(rooms.values()).filter(r => r.game === 'snake').length
    },
    simulatedPlayers: {
      morpion: Math.floor(Math.random() * 50) + 20,
      memory: Math.floor(Math.random() * 30) + 10,
      snake: Math.floor(Math.random() * 40) + 15
    }
  };
  res.json(stats);
});

// Mettre à jour les stats globales
function updateGlobalStats() {
  const stats = {
    onlinePlayers: activePlayers.size,
    activeRooms: rooms.size,
    activeTournaments: tournaments.size,
    games: {
      morpion: Array.from(rooms.values()).filter(r => r.game === 'morpion').length,
      memory: Array.from(rooms.values()).filter(r => r.game === 'memory').length,
      snake: Array.from(rooms.values()).filter(r => r.game === 'snake').length
    },
    simulatedPlayers: {
      morpion: Math.floor(Math.random() * 50) + 20,
      memory: Math.floor(Math.random() * 30) + 10,
      snake: Math.floor(Math.random() * 40) + 15
    },
    timestamp: new Date()
  };
  io.emit('global-stats-update', stats);
}

// WebSocket Events - VRAI MULTIJOUEUR
io.on('connection', (socket) => {
  console.log('🔗 Nouveau joueur connecté:', socket.id);
  activePlayers.add(socket.id);
  updateGlobalStats();

  // Événement pour lister les salles
  socket.on('list-rooms', (data) => {
    const { game } = data;
    const availableRooms = Array.from(rooms.values())
      .filter(room => room.game === game && room.players.length < 2);
    socket.emit('rooms-list', availableRooms);
  });

  // REJOINDRE UNE SALLE - MULTIJOUEUR RÉEL
  socket.on('join-room', (data) => {
    const { game, playerName, roomId } = data;
    
    // Utiliser un ID de salle fixe pour que les joueurs se retrouvent
    const roomKey = roomId || `${game}-lobby`;
    
    let room = rooms.get(roomKey);
    if (!room) {
      room = {
        id: roomKey,
        game,
        players: [],
        status: 'waiting',
        createdAt: new Date(),
        board: Array(9).fill(''),
        currentPlayer: 'X'
      };
      rooms.set(roomKey, room);
    }

    if (room.players.length < 2) {
      // Vérifier si le joueur n'est pas déjà dans la salle
      const existingPlayer = room.players.find(p => p.id === socket.id);
      if (existingPlayer) {
        socket.emit('room-joined', {
          player: existingPlayer,
          room: room,
          players: room.players
        });
        return;
      }

      const player = {
        id: socket.id,
        name: playerName,
        symbol: room.players.length === 0 ? 'X' : 'O',
        joinedAt: new Date()
      };
      
      room.players.push(player);
      socket.join(roomKey);
      rooms.set(roomKey, room);

      console.log(`🎮 ${playerName} a rejoint ${roomKey} (${room.players.length}/2 joueurs)`);

      // Notifier TOUS les joueurs
      io.to(roomKey).emit('player-joined', {
        player,
        room: room,
        players: room.players
      });

      // Si 2 joueurs sont présents, démarrer la partie
      if (room.players.length === 2) {
        room.status = 'playing';
        rooms.set(roomKey, room);
        
        io.to(roomKey).emit('game-start', {
          message: 'Partie commencée!',
          players: room.players,
          currentPlayer: 'X',
          roomId: roomKey
        });
        console.log(`🚀 Partie démarrée dans ${roomKey}`);
      }

      updateGlobalStats();
    } else {
      socket.emit('room-full', { message: 'Salle pleine' });
    }
  });

  // MOUVEMENT DE JEU - GESTION RÉELLE MULTIJOUEUR
  socket.on('game-move', (data) => {
    const { game, move, roomId } = data;
    const room = rooms.get(roomId);
    
    if (room && room.players.length === 2 && room.status === 'playing') {
      // Vérifier que c'est le tour du bon joueur
      const currentPlayer = room.players.find(p => p.id === socket.id);
      if (!currentPlayer || currentPlayer.symbol !== room.currentPlayer) {
        socket.emit('not-your-turn', { message: "Ce n'est pas votre tour !" });
        return;
      }

      // Vérifier que la case est libre
      if (room.board[move] === '') {
        room.board[move] = currentPlayer.symbol;
        
        // Vérifier s'il y a un gagnant
        const winner = checkMorpionWinner(room.board);
        const isBoardFull = room.board.every(cell => cell !== '');
        
        // Changer le joueur courant
        room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
        rooms.set(roomId, room);
        
        // Transmettre le mouvement à TOUS les joueurs
        io.to(roomId).emit('game-state-update', {
          board: room.board,
          currentPlayer: room.currentPlayer,
          move: move,
          symbol: currentPlayer.symbol,
          playerName: currentPlayer.name,
          winner: winner,
          gameOver: winner || isBoardFull,
          room: room
        });

        console.log(`🎯 Mouvement ${move} par ${currentPlayer.name} dans ${roomId}`);

        // Mettre à jour les stats du gagnant
        if (winner) {
          const winningPlayer = room.players.find(p => p.symbol === winner);
          if (winningPlayer && users.has(winningPlayer.name)) {
            const user = users.get(winningPlayer.name);
            user.stats.wins++;
            user.stats.totalScore += 10;
            user.stats.totalGames++;
            users.set(winningPlayer.name, user);
            updateLeaderboard();
            console.log(`🏆 ${winningPlayer.name} a gagné dans ${roomId}`);
          }
        }

        // Si partie terminée, réinitialiser après un délai
        if (winner || isBoardFull) {
          room.status = 'finished';
          setTimeout(() => {
            if (rooms.has(roomId)) {
              const endedRoom = rooms.get(roomId);
              endedRoom.board = Array(9).fill('');
              endedRoom.status = 'playing';
              endedRoom.currentPlayer = 'X';
              rooms.set(roomId, endedRoom);
              
              io.to(roomId).emit('game-reset', {
                message: 'Nouvelle partie !',
                board: endedRoom.board,
                currentPlayer: endedRoom.currentPlayer
              });
              console.log(`🔄 Nouvelle partie dans ${roomId}`);
            }
          }, 3000);
        }
      }
    }
  });

  socket.on('chat-message', (data) => {
    const { message, roomId } = data;
    const room = rooms.get(roomId);
    
    if (room) {
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        io.to(roomId).emit('chat-message', {
          message,
          playerName: player.name,
          timestamp: new Date(),
          roomId: roomId
        });
      }
    }
  });

  socket.on('create-tournament', (data) => {
    const tournament = {
      id: 'tournament-' + Date.now(),
      ...data,
      status: 'registration',
      participants: [],
      createdAt: new Date(),
      bracket: null
    };
    
    tournaments.set(tournament.id, tournament);
    io.emit('tournament-created', tournament);
    updateGlobalStats();
  });

  socket.on('join-tournament', (data) => {
    const { tournamentId, playerName } = data;
    const tournament = tournaments.get(tournamentId);
    
    if (tournament && tournament.status === 'registration') {
      if (!tournament.participants.includes(playerName)) {
        tournament.participants.push(playerName);
        tournaments.set(tournamentId, tournament);
        
        io.emit('tournament-updated', tournament);
        
        if (tournament.participants.length >= tournament.maxPlayers) {
          tournament.status = 'active';
          startTournament(tournamentId);
        }
        
        updateGlobalStats();
      }
    }
  });

  socket.on('disconnect', () => {
    // Retirer le joueur des salles
    rooms.forEach((room, roomId) => {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const playerName = room.players[playerIndex].name;
        room.players.splice(playerIndex, 1);
        
        // Notifier les autres joueurs
        if (room.players.length > 0) {
          io.to(roomId).emit('player-left', {
            playerName,
            players: room.players,
            message: `${playerName} a quitté la partie`
          });
          
          // Réinitialiser la partie si un joueur quitte
          room.board = Array(9).fill('');
          room.status = 'waiting';
          room.currentPlayer = 'X';
          rooms.set(roomId, room);
          
        } else {
          // Supprimer la salle si vide
          rooms.delete(roomId);
        }
        
        console.log(`👋 ${playerName} a quitté ${roomId}`);
      }
    });
    
    activePlayers.delete(socket.id);
    updateGlobalStats();
  });
});

// Logique de victoire au morpion
function checkMorpionWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

function startTournament(tournamentId) {
  const tournament = tournaments.get(tournamentId);
  if (tournament) {
    console.log(`🏆 Démarrage du tournoi: ${tournament.name}`);
    tournament.bracket = generateBracket(tournament.participants);
    tournaments.set(tournamentId, tournament);
    io.emit('tournament-started', tournament);
  }
}

function generateBracket(participants) {
  const bracket = [];
  let currentRound = participants.map(p => ({ player: p, winner: null }));
  
  while (currentRound.length > 1) {
    bracket.push(currentRound);
    const nextRound = [];
    
    for (let i = 0; i < currentRound.length; i += 2) {
      if (i + 1 < currentRound.length) {
        nextRound.push({
          match: [currentRound[i], currentRound[i + 1]],
          winner: null
        });
      }
    }
    
    currentRound = nextRound;
  }
  
  bracket.push(currentRound);
  return bracket;
}

// Mettre à jour périodiquement les stats
setInterval(() => {
  updateGlobalStats();
}, 10000);

// Initialiser les données
initializeData();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🎮 GameHub Server démarré sur le port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🎯 MULTIJOUEUR RÉEL ACTIVÉ - Les joueurs jouent VRAIMENT ensemble!`);
});
