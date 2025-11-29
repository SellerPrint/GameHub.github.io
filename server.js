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

// Données en mémoire SIMPLIFIÉES
const users = new Map();
const games = new Map(); // Remplace les rooms
const leaderboard = new Map();
const waitingPlayers = new Map(); // Joueurs en attente par jeu

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

// API Routes SIMPLIFIÉES
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

app.get('/api/leaderboard', (req, res) => {
  const data = leaderboard.get('all') || [];
  res.json(data);
});

app.get('/api/stats', (req, res) => {
  const stats = {
    onlinePlayers: Array.from(games.values()).reduce((acc, game) => acc + game.players.length, 0),
    activeGames: games.size,
    waitingPlayers: Array.from(waitingPlayers.values()).length
  };
  res.json(stats);
});

// WebSocket Events SIMPLIFIÉS
io.on('connection', (socket) => {
  console.log('🔗 Nouveau joueur connecté:', socket.id);

  // REJOINDRE UNE PARTIE DE MORPION
  socket.on('join-morpion', (data) => {
    const { playerName } = data;
    
    // Vérifier s'il y a un joueur en attente
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
      
      // Retirer le joueur en attente
      waitingPlayers.delete('morpion');
      
      // Faire rejoindre les deux joueurs à la room
      socket.join(gameId);
      io.to(waitingPlayer.socketId).join(gameId);
      
      console.log(`🎮 Partie créée: ${playerName} vs ${waitingPlayer.playerName}`);

      // Notifier les DEUX joueurs
      io.to(gameId).emit('game-start', {
        gameId: gameId,
        players: game.players,
        currentPlayer: 'X',
        message: 'Partie commencée!'
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

  // FAIRE UN MOUVEMENT AU MORPION
  socket.on('morpion-move', (data) => {
    const { gameId, move } = data;
    const game = games.get(gameId);
    
    if (!game) {
      socket.emit('error', { message: 'Partie introuvable' });
      return;
    }

    // Vérifier que c'est le bon joueur
    const currentPlayer = game.players.find(p => p.id === socket.id);
    if (!currentPlayer) {
      socket.emit('error', { message: 'Vous n\'êtes pas dans cette partie' });
      return;
    }

    // Vérifier que c'est son tour
    if (currentPlayer.symbol !== game.currentPlayer) {
      socket.emit('error', { message: 'Ce n\'est pas votre tour !' });
      return;
    }

    // Vérifier que la case est vide
    if (game.board[move] !== '') {
      socket.emit('error', { message: 'Cette case est déjà occupée' });
      return;
    }

    // Effectuer le mouvement
    game.board[move] = currentPlayer.symbol;
    
    // Vérifier s'il y a un gagnant
    const winner = checkMorpionWinner(game.board);
    const isBoardFull = game.board.every(cell => cell !== '');
    
    // Changer le joueur courant
    game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
    games.set(gameId, game);
    
    // Transmettre le mouvement à tous les joueurs
    io.to(gameId).emit('morpion-update', {
      move,
      symbol: currentPlayer.symbol,
      playerName: currentPlayer.name,
      winner: winner,
      gameOver: winner || isBoardFull,
      board: game.board,
      currentPlayer: game.currentPlayer
    });

    // Mettre à jour les stats du gagnant
    if (winner && users.has(currentPlayer.name)) {
      const user = users.get(currentPlayer.name);
      user.stats.wins++;
      user.stats.totalScore += 10;
      user.stats.totalGames++;
      users.set(currentPlayer.name, user);
      updateLeaderboard();
    }

    // Si partie terminée, réinitialiser après un délai
    if (winner || isBoardFull) {
      setTimeout(() => {
        if (games.has(gameId)) {
          const endedGame = games.get(gameId);
          endedGame.board = Array(9).fill('');
          endedGame.currentPlayer = 'X';
          games.set(gameId, endedGame);
          
          io.to(gameId).emit('morpion-reset', {
            message: 'Nouvelle partie !',
            board: endedGame.board,
            currentPlayer: endedGame.currentPlayer
          });
        }
      }, 3000);
    }
  });

  // CHAT DANS LA PARTIE
  socket.on('game-chat', (data) => {
    const { gameId, message } = data;
    const game = games.get(gameId);
    
    if (game) {
      const player = game.players.find(p => p.id === socket.id);
      if (player) {
        io.to(gameId).emit('game-chat', {
          message,
          playerName: player.name,
          timestamp: new Date()
        });
      }
    }
  });

  // QUITTER UNE PARTIE
  socket.on('leave-game', (data) => {
    const { gameId } = data;
    const game = games.get(gameId);
    
    if (game) {
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const playerName = game.players[playerIndex].name;
        
        // Notifier l'autre joueur
        const otherPlayer = game.players.find(p => p.id !== socket.id);
        if (otherPlayer) {
          io.to(otherPlayer.id).emit('player-left', {
            message: `${playerName} a quitté la partie`
          });
        }
        
        // Supprimer la partie
        games.delete(gameId);
        console.log(`👋 ${playerName} a quitté la partie ${gameId}`);
      }
    }
  });

  // GESTION DÉCONNEXION
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
          io.to(otherPlayer.id).emit('player-left', {
            message: `${playerName} s'est déconnecté`
          });
        }
        
        games.delete(gameId);
        console.log(`💥 Partie ${gameId} annulée (déconnexion)`);
      }
    });
  });
});

// Logique de victoire au morpion
function checkMorpionWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Lignes
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Colonnes
    [0, 4, 8], [2, 4, 6] // Diagonales
  ];

  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

// Initialiser les données
initializeData();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🎮 Morpion Multiplayer Server démarré sur le port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`✅ Système simplifié - 1v1 direct sans salles complexes`);
});
