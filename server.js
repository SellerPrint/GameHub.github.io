import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Configuration CORS pour Socket.io
const io = new Server(server, {
  cors: {
    origin: ["https://votre-app.render.com", "http://localhost:10000"],
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route pour health check (obligatoire sur Render)
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Route principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Données SIMPLES
const players = {};
const games = {};

io.on('connection', (socket) => {
  console.log('🔗 Joueur connecté:', socket.id);
  
  // REJOINDRE LE JEU
  socket.on('join-game', (data) => {
    const { playerName } = data;
    
    players[socket.id] = {
      id: socket.id,
      name: playerName,
      symbol: null
    };

    console.log(`🎮 ${playerName} veut jouer`);

    // Chercher une partie en attente
    const availableGame = Object.values(games).find(game => 
      game.status === 'waiting' && 
      Object.keys(game.players).length === 1
    );

    if (availableGame) {
      // Rejoindre une partie existante
      joinExistingGame(socket, availableGame, playerName);
    } else {
      // Créer une nouvelle partie
      createNewGame(socket, playerName);
    }
  });

  // FAIRE UN MOUVEMENT
  socket.on('make-move', (data) => {
    const { gameId, cellIndex } = data;
    const game = games[gameId];
    
    if (!game) {
      socket.emit('error', { message: 'Partie introuvable' });
      return;
    }

    const player = game.players[socket.id];
    if (!player) {
      socket.emit('error', { message: 'Vous n\'êtes pas dans cette partie' });
      return;
    }

    // Vérifier que c'est son tour
    if (game.currentPlayer !== player.symbol) {
      socket.emit('not-your-turn', { message: 'Ce n\'est pas votre tour !' });
      return;
    }

    // Vérifier que la case est vide
    if (game.board[cellIndex] !== '') {
      socket.emit('invalid-move', { message: 'Case déjà occupée' });
      return;
    }

    // Faire le mouvement
    game.board[cellIndex] = player.symbol;
    
    // Vérifier victoire
    const winner = checkWinner(game.board);
    const isDraw = !winner && game.board.every(cell => cell !== '');
    
    // Mettre à jour le tour
    game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
    
    // Émettre le mouvement à tous les joueurs
    io.to(gameId).emit('move-made', {
      cellIndex,
      symbol: player.symbol,
      board: game.board,
      currentPlayer: game.currentPlayer,
      winner,
      isDraw
    });

    // Réinitialiser si partie terminée
    if (winner || isDraw) {
      setTimeout(() => {
        if (games[gameId]) {
          games[gameId].board = ['', '', '', '', '', '', '', '', ''];
          games[gameId].currentPlayer = 'X';
          io.to(gameId).emit('game-reset', { 
            board: games[gameId].board,
            currentPlayer: 'X'
          });
        }
      }, 3000);
    }
  });

  // CHAT
  socket.on('send-message', (data) => {
    const { gameId, message } = data;
    const game = games[gameId];
    if (game && game.players[socket.id]) {
      io.to(gameId).emit('new-message', {
        player: players[socket.id].name,
        message: message
      });
    }
  });

  // DÉCONNEXION
  socket.on('disconnect', () => {
    console.log('👋 Joueur déconnecté:', socket.id);
    
    // Retirer des parties
    Object.keys(games).forEach(gameId => {
      const game = games[gameId];
      if (game && game.players[socket.id]) {
        const otherPlayerId = Object.keys(game.players).find(id => id !== socket.id);
        if (otherPlayerId) {
          io.to(otherPlayerId).emit('opponent-left');
        }
        delete games[gameId];
        console.log(`🗑️ Partie ${gameId} supprimée`);
      }
    });
    
    delete players[socket.id];
  });
});

function createNewGame(socket, playerName) {
  const gameId = 'game-' + Date.now();
  
  games[gameId] = {
    id: gameId,
    players: {
      [socket.id]: { symbol: 'X' }
    },
    board: ['', '', '', '', '', '', '', '', ''],
    currentPlayer: 'X',
    status: 'waiting'
  };

  socket.join(gameId);
  players[socket.id].symbol = 'X';
  
  socket.emit('waiting-for-player', { 
    gameId: gameId,
    message: 'En attente d\'un adversaire...'
  });
  
  console.log(`🆕 Nouvelle partie créée: ${gameId} par ${playerName}`);
}

function joinExistingGame(socket, game, playerName) {
  const gameId = game.id;
  
  game.players[socket.id] = { symbol: 'O' };
  game.status = 'playing';
  
  socket.join(gameId);
  players[socket.id].symbol = 'O';
  
  // Notifier les DEUX joueurs
  const playerIds = Object.keys(game.players);
  const player1 = players[playerIds[0]];
  const player2 = players[playerIds[1]];
  
  io.to(gameId).emit('game-started', {
    gameId: gameId,
    players: {
      player1: { name: player1.name, symbol: 'X' },
      player2: { name: player2.name, symbol: 'O' }
    },
    currentPlayer: 'X',
    board: game.board
  });
  
  console.log(`🎯 Partie commencée: ${player1.name} vs ${player2.name}`);
}

function checkWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // lignes
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // colonnes
    [0, 4, 8], [2, 4, 6] // diagonales
  ];

  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

// Port pour Render (obligatoire)
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Serveur Morpion sur le port ${PORT}`);
  console.log(`📍 http://0.0.0.0:${PORT}`);
});
