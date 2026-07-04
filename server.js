const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'communication_app_super_secret_key_7777';

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// --- AUTH API ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, bio } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const existingUser = await db.findOne('users', u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(username)}&background=random&color=fff&size=128`;
    
    const newUser = await db.insert('users', {
      username,
      password: hashedPassword,
      avatar,
      bio: bio || 'Available for meetings!'
    });

    const token = jwt.sign({ id: newUser.id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: newUser.id, username: newUser.username, avatar: newUser.avatar } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await db.findOne('users', u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Access token required' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.findOne('users', u => u.id === req.user.id);
    if (!user) return res.status(444).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, avatar: user.avatar });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SOCKET.IO REAL-TIME signaling & collaboration ---
const rooms = new Map(); // roomId -> Set of socketIds

io.on('connection', (socket) => {
  let currentRoomId = null;
  let clientUsername = 'Anonymous';

  socket.on('join-room', ({ roomId, username }) => {
    currentRoomId = roomId;
    clientUsername = username;
    
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }

    // Get list of existing members
    const existingSockets = Array.from(rooms.get(roomId));
    
    // Add current socket
    rooms.get(roomId).add(socket.id);

    // Tell the new user about all existing members in the room
    socket.emit('room-users', {
      users: existingSockets.map(sid => ({
        socketId: sid,
        username: io.sockets.sockets.get(sid)?.username || 'User'
      }))
    });

    // Store username on the socket object
    socket.username = username;

    // Notify other peers in the room that a new user joined
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      username: username
    });
  });

  // Relay WebRTC signaling payload between peers
  socket.on('signal', ({ targetSocketId, signalData }) => {
    io.to(targetSocketId).emit('signal', {
      senderSocketId: socket.id,
      signalData
    });
  });

  // Whiteboard drawing synchronizer
  socket.on('draw', (drawData) => {
    if (currentRoomId) {
      socket.to(currentRoomId).emit('draw', drawData);
    }
  });

  // Whiteboard clear synchronizer
  socket.on('clear-whiteboard', () => {
    if (currentRoomId) {
      socket.to(currentRoomId).emit('clear-whiteboard');
    }
  });

  // Real-time Chat message broadcaster
  socket.on('chat-message', (encryptedMsg) => {
    if (currentRoomId) {
      // encryptedMsg: { sender: string, text: string }
      socket.to(currentRoomId).emit('chat-message', encryptedMsg);
    }
  });

  // Real-time File transfer broadcaster
  socket.on('share-file', (fileData) => {
    if (currentRoomId) {
      // fileData: { name: string, type: string, size: number, dataUrl: string, sender: string }
      socket.to(currentRoomId).emit('receive-file', fileData);
    }
  });

  // Disconnection handler
  socket.on('disconnect', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      rooms.get(currentRoomId).delete(socket.id);
      if (rooms.get(currentRoomId).size === 0) {
        rooms.delete(currentRoomId);
      } else {
        // Inform other room members of the disconnection
        socket.to(currentRoomId).emit('user-left', {
          socketId: socket.id,
          username: clientUsername
        });
      }
    }
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`Real-Time Communication App server running at http://localhost:${PORT}`);
});
