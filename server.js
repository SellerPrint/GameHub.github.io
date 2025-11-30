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

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Données
const users = new Map();
const games = new Map();
const waitingPlayers = new Map();

// Initialisation
function initializeData() {
  users.set('admin', {
    id: '1',
    username: 'admin',
    password: bcrypt.hashSync('admin123', 12),
    email: 'admin@gamehub.com',
    stats: { totalGames: 0, wins: 0, totalScore: 0, level: 1 },
    createdAt: new Date()
  });
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

app.get('/api/stats', (req, res) => {
  const stats = {
    onlinePlayers: Array.from(games.values()).reduce((acc, game) => acc + game.players.length, 0),
    activeGames: games.size,
    waitingPlayers: Array.from(waitingPlayers.values()).length
  };
  res.json(stats);
});

// WebSocket Events - MULTIJOUEUR FONCTIONNEL
io.on('connection', (socket) => {
  console.log('🔗 Joueur connecté:', socket.id);

  // REJOINDRE LE JEU MULTIJOUEUR
  socket.on('join-morpion-multi', (data) => {
    const { playerName } = data;
    socket.username = playerName;
    
    const waitingPlayer = waitingPlayers.get('morpion');
    
    if (waitingPlayer && waitingPlayer.socketId !== socket.id) {
      // Créer une nouvelle partie avec les deux joueurs
      const gameId = `morpion-${Date.now()}`;
      const game = {
        id: gameId,
        game: 'morpion',
        players: [
          {
            id: waitingPlayer.socketId,
            name: waitingPlayer.playerName,
            symbol: 'X'
          },
          {
            id: socket.id,
            name: playerName,
            symbol: 'O'
          }
        ],
        status: 'playing',
        board: Array(9).fill(''),
        currentPlayer: 'X',
        createdAt: new Date()
      };

      games.set(gameId, game);
      waitingPlayers.delete('morpion');
      
      socket.join(gameId);
      io.to(waitingPlayer.socketId).join(gameId);
      
      console.log(`🎮 Partie multijoueur créée: ${playerName} vs ${waitingPlayer.playerName}`);

      // Notifier les DEUX joueurs que la partie commence
      io.to(gameId).emit('game-started', {
        gameId: gameId,
        players: game.players,
        currentPlayer: 'X',
        board: game.board,
        message: 'Partie multijoueur commencée!'
      });
      
    } else {
      // Aucun joueur en attente, mettre ce joueur en attente
      waitingPlayers.set('morpion', {
        socketId: socket.id,
        playerName: playerName,
        joinedAt: new Date()
      });
      
      console.log(`⏳ ${playerName} en attente d'un adversaire...`);
      
      socket.emit('waiting-for-player', {
        message: 'En attente d\'un adversaire...'
      });
    }
  });

  // FAIRE UN MOUVEMENT EN MULTIJOUEUR
  socket.on('morpion-move-multi', (data) => {
    const { gameId, move } = data;
    const game = games.get(gameId);
    
    if (!game) {
      socket.emit('error', { message: 'Partie introuvable' });
      return;
    }

    const currentPlayer = game.players.find(p => p.id === socket.id);
    if (!currentPlayer) {
      socket.emit('error', { message: 'Vous n\'êtes pas dans cette partie' });
      return;
    }

    if (game.currentPlayer !== currentPlayer.symbol) {
      socket.emit('not-your-turn', { message: 'Ce n\'est pas votre tour !' });
      return;
    }

    if (game.board[move] !== '') {
      socket.emit('invalid-move', { message: 'Case déjà occupée' });
      return;
    }

    // Effectuer le mouvement
    game.board[move] = currentPlayer.symbol;
    
    // Vérifier victoire
    const winner = checkWinner(game.board);
    const isDraw = !winner && game.board.every(cell => cell !== '');
    
    // Mettre à jour le tour
    game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
    games.set(gameId, game);
    
    // Émettre le mouvement à tous les joueurs
    io.to(gameId).emit('move-made-multi', {
      move,
      symbol: currentPlayer.symbol,
      playerName: currentPlayer.name,
      board: game.board,
      currentPlayer: game.currentPlayer,
      winner,
      isDraw
    });

    // Mettre à jour les stats du gagnant
    if (winner && users.has(currentPlayer.name)) {
      const user = users.get(currentPlayer.name);
      user.stats.wins++;
      user.stats.totalScore += 10;
      user.stats.totalGames++;
      users.set(currentPlayer.name, user);
    }

    // Réinitialiser si partie terminée
    if (winner || isDraw) {
      setTimeout(() => {
        if (games.has(gameId)) {
          games[gameId].board = Array(9).fill('');
          games[gameId].currentPlayer = 'X';
          io.to(gameId).emit('game-reset-multi', { 
            board: games[gameId].board,
            currentPlayer: 'X'
          });
        }
      }, 3000);
    }
  });

  // CHAT MULTIJOUEUR
  socket.on('send-message-multi', (data) => {
    const { gameId, message } = data;
    const game = games.get(gameId);
    if (game && game.players[socket.id]) {
      const player = game.players.find(p => p.id === socket.id);
      io.to(gameId).emit('new-message-multi', {
        player: player.name,
        message: message,
        timestamp: new Date()
      });
    }
  });

  // DÉCONNEXION
  socket.on('disconnect', () => {
    console.log('👋 Joueur déconnecté:', socket.id);
    
    // Retirer des joueurs en attente
    if (waitingPlayers.get('morpion')?.socketId === socket.id) {
      waitingPlayers.delete('morpion');
    }
    
    // Retirer des parties en cours
    games.forEach((game, gameId) => {
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const playerName = game.players[playerIndex].name;
        const otherPlayer = game.players.find(p => p.id !== socket.id);
        
        if (otherPlayer) {
          io.to(otherPlayer.id).emit('opponent-left', {
            message: `${playerName} s'est déconnecté`
          });
        }
        
        games.delete(gameId);
      }
    });
  });
});

function checkWinner(board) {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];

  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

// Initialiser les données
initializeData();

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 GameHub Server sur le port ${PORT}`);
  console.log(`📍 http://0.0.0.0:${PORT}`);
  console.log(`✅ Multijoueur morpion ACTIVÉ et FONCTIONNEL !`);
});
