const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Stockage en mémoire (simple)
const activeRooms = new Map();

// Socket.io pour le multijoueur
io.on('connection', (socket) => {
  console.log('🔗 Joueur connecté:', socket.id);

  socket.on('join-room', (data) => {
    const { game, playerName } = data;
    const roomId = `room-${game}-${socket.id}`;
    
    socket.join(roomId);
    activeRooms.set(socket.id, { roomId, game, playerName });
    
    socket.emit('room-joined', { 
      roomId, 
      message: `Bienvenue dans ${game}, ${playerName}!` 
    });
    
    console.log(`🎮 ${playerName} a rejoint ${game}`);
  });

  socket.on('game-move', (data) => {
    const { game, move, roomId } = data;
    socket.to(roomId).emit('opponent-move', { move });
  });

  socket.on('chat-message', (data) => {
    const { message, roomId } = data;
    const playerData = activeRooms.get(socket.id);
    
    io.to(roomId).emit('chat-message', {
      playerName: playerData?.playerName || 'Joueur',
      message: message,
      timestamp: new Date()
    });
  });

  socket.on('disconnect', () => {
    console.log('🔌 Joueur déconnecté:', socket.id);
    activeRooms.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur GameHub démarré sur le port ${PORT}`);
});