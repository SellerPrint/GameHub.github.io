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

// Données en mémoire avec discussions séparées
const users = new Map();
const games = new Map();
const waitingPlayers = new Map();
const privateChats = new Map(); // Nouvelles discussions privées

// Structure: privateChats.set(user1-user2, [messages])

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

// WebSocket Events avec discussions privées
io.on('connection', (socket) => {
  console.log('🔗 Joueur connecté:', socket.id);

  // Stocker l'username avec la socket
  socket.on('user-connected', (userData) => {
    socket.username = userData.username;
    console.log(`👤 ${userData.username} connecté (${socket.id})`);
  });

  // REJOINDRE UNE PARTIE DE MORPION
  socket.on('join-morpion', (data) => {
    const { playerName } = data;
    socket.username = playerName;
    
    const waitingPlayer = waitingPlayers.get('morpion');
    
    if (waitingPlayer && waitingPlayer.socketId !== socket.id) {
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
      
      console.log(`🎮 Partie créée: ${playerName} vs ${waitingPlayer.playerName}`);

      io.to(gameId).emit('game-start', {
        gameId: gameId,
        players: game.players,
        currentPlayer: 'X',
        message: 'Partie commencée!'
      });
      
    } else {
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

  // MOUVEMENT MORPION
  socket.on('morpion-move', (data) => {
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

    game.board[move] = currentPlayer.symbol;
    
    const winner = checkWinner(game.board);
    const isDraw = !winner && game.board.every(cell => cell !== '');
    
    game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
    games.set(gameId, game);
    
    io.to(gameId).emit('morpion-update', {
      move,
      symbol: currentPlayer.symbol,
      playerName: currentPlayer.name,
      winner: winner,
      gameOver: winner || isDraw,
      board: game.board,
      currentPlayer: game.currentPlayer
    });

    if (winner && users.has(currentPlayer.name)) {
      const user = users.get(currentPlayer.name);
      user.stats.wins++;
      user.stats.totalScore += 10;
      user.stats.totalGames++;
      users.set(currentPlayer.name, user);
    }

    if (winner || isDraw) {
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

  // CHAT DE PARTIE (existant)
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

  // NOUVEAU : CHAT PRIVÉ entre utilisateurs
  socket.on('private-message', (data) => {
    const { toUsername, message } = data;
    const fromUsername = socket.username;
    
    if (!fromUsername || !toUsername) return;

    // Créer une clé unique pour la conversation (toujours dans le même ordre)
    const chatKey = [fromUsername, toUsername].sort().join('-');
    
    // Initialiser la conversation si elle n'existe pas
    if (!privateChats.has(chatKey)) {
      privateChats.set(chatKey, []);
    }
    
    const chatMessage = {
      from: fromUsername,
      to: toUsername,
      message: message,
      timestamp: new Date(),
      read: false
    };
    
    // Ajouter le message à l'historique
    privateChats.get(chatKey).push(chatMessage);
    
    // Envoyer le message à l'expéditeur et au destinataire
    socket.emit('private-message-received', chatMessage);
    
    // Trouver le socket du destinataire
    const recipientSocket = Array.from(io.sockets.sockets.values())
      .find(s => s.username === toUsername);
    
    if (recipientSocket) {
      recipientSocket.emit('private-message-received', chatMessage);
    }
  });

  // NOUVEAU : Récupérer l'historique d'une conversation privée
  socket.on('get-chat-history', (data) => {
    const { otherUser } = data;
    const currentUser = socket.username;
    
    if (!currentUser || !otherUser) return;
    
    const chatKey = [currentUser, otherUser].sort().join('-');
    const history = privateChats.get(chatKey) || [];
    
    socket.emit('chat-history', {
      otherUser: otherUser,
      messages: history
    });
  });

  // NOUVEAU : Lister les utilisateurs en ligne
  socket.on('get-online-users', () => {
    const onlineUsers = Array.from(io.sockets.sockets.values())
      .map(s => s.username)
      .filter(username => username && username !== socket.username)
      .filter((username, index, arr) => arr.indexOf(username) === index); // Doublons
    
    socket.emit('online-users', onlineUsers);
  });

  // DÉCONNEXION
  socket.on('disconnect', () => {
    console.log('👋 Joueur déconnecté:', socket.id);
    
    if (waitingPlayers.get('morpion')?.socketId === socket.id) {
      waitingPlayers.delete('morpion');
    }
    
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
      }
    });

    // Notifier que l'utilisateur est hors ligne
    if (socket.username) {
      socket.broadcast.emit('user-offline', socket.username);
    }
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
  console.log(`💬 Système de chat privé activé !`);
});
