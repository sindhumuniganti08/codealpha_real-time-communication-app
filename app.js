// App State
let currentUser = null;
let token = null;
let activeRoomId = null;
let e2eSecretKey = 'pulse-secure-key';
let socket = null;

// Media Streams
let localStream = null;
let screenStream = null;
let isAudioMuted = false;
let isVideoCameraOff = false;
let isScreenSharing = false;

// WebRTC Peers: targetSocketId -> RTCPeerConnection
const peers = {};
const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Collaborative Whiteboard State
let canvas = null;
let ctx = null;
let drawing = false;
let brushColor = '#6366f1';
let brushSize = 5;
let lastX = 0;
let lastY = 0;

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupCanvasListeners();
});

// --- AUTHENTICATION & VIEWS ---
function checkAuth() {
  token = localStorage.getItem('token');
  if (token) {
    fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => {
      if (!res.ok) throw new Error('Session expired');
      return res.json();
    })
    .then(user => {
      currentUser = user;
      setupUserLobby();
    })
    .catch(err => {
      console.warn(err);
      handleLogout();
    });
  } else {
    showScreen('auth-screen');
  }
}

function showScreen(screenId) {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('app-dashboard').classList.add('hidden');
  document.getElementById(screenId).classList.remove('hidden');
}

function switchAuthTab(tab) {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const authError = document.getElementById('auth-error');

  authError.classList.add('hidden');

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
  } else {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
    tabLogin.classList.remove('active');
    tabRegister.classList.add('active');
  }
}

function handleAuthSubmit(event, action) {
  event.preventDefault();
  const authError = document.getElementById('auth-error');
  authError.classList.add('hidden');

  let body = {};
  let endpoint = '';

  if (action === 'login') {
    body = {
      username: document.getElementById('login-username').value,
      password: document.getElementById('login-password').value
    };
    endpoint = '/api/auth/login';
  } else {
    body = {
      username: document.getElementById('register-username').value,
      password: document.getElementById('register-password').value,
      bio: document.getElementById('register-bio').value
    };
    endpoint = '/api/auth/register';
  }

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(res => {
    if (!res.ok) {
      return res.json().then(data => { throw new Error(data.error || 'Auth failed'); });
    }
    return res.json();
  })
  .then(data => {
    localStorage.setItem('token', data.token);
    token = data.token;
    currentUser = data.user;
    
    document.getElementById('login-form').reset();
    document.getElementById('register-form').reset();
    
    setupUserLobby();
    showToast('Success', `Signed in as ${currentUser.username}`, 'success');
  })
  .catch(err => {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
  });
}

function setupUserLobby() {
  showScreen('lobby-screen');
  document.getElementById('lobby-user-avatar').src = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.username)}&background=6366f1&color=fff`;
  document.getElementById('lobby-user-name').textContent = currentUser.username;
}

function handleLogout() {
  localStorage.removeItem('token');
  currentUser = null;
  token = null;
  showScreen('auth-screen');
}

// --- DATA ENCRYPTION (E2E Client-side XOR) ---
function encryptMessage(text, key) {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return btoa(result); // Base64 encode the ciphertext
}

function decryptMessage(ciphertext, key) {
  try {
    let decoded = atob(ciphertext);
    let result = "";
    for (let i = 0; i < decoded.length; i++) {
      result += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  } catch (err) {
    return "[Decryption Error]";
  }
}

// --- JOIN ROOM & SIGNALING SETUP ---
async function handleJoinRoom(event) {
  event.preventDefault();
  const roomId = document.getElementById('room-id-input').value.trim();
  e2eSecretKey = document.getElementById('chat-secret-key').value.trim();
  
  if (!roomId || !e2eSecretKey) return;

  activeRoomId = roomId;
  document.getElementById('current-room-name').textContent = roomId;
  
  // Show Main App View
  showScreen('app-dashboard');

  // Trigger Local Media Streams
  await startLocalMedia();

  // Connect WebSockets Signaling Server
  connectSignalingServer();
}

function connectSignalingServer() {
  socket = io();

  // Inform signaling server we are entering
  socket.emit('join-room', { roomId: activeRoomId, username: currentUser.username });

  // Event: Room members listing
  socket.on('room-users', ({ users }) => {
    users.forEach(peer => {
      // Connect to each existing user
      initiatePeerConnection(peer.socketId, peer.username, true);
    });
  });

  // Event: A new user enters the room
  socket.on('user-joined', ({ socketId, username }) => {
    showToast('User Joined', `${username} joined the meeting`, 'info');
    // Prepare connection, wait for offer
    initiatePeerConnection(socketId, username, false);
  });

  // Event: Receive signaling data
  socket.on('signal', async ({ senderSocketId, signalData }) => {
    const pc = peers[senderSocketId];
    if (!pc) return;

    if (signalData.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
      if (signalData.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', {
          targetSocketId: senderSocketId,
          signalData: { sdp: pc.localDescription }
        });
      }
    } else if (signalData.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      } catch (err) {
        console.error('Error adding ICE candidate:', err);
      }
    }
  });

  // Event: Drawing Sync
  socket.on('draw', (drawData) => {
    drawCanvasLine(drawData.x0, drawData.y0, drawData.x1, drawData.y1, drawData.color, drawData.size, false);
  });

  // Event: Clear whiteboard
  socket.on('clear-whiteboard', () => {
    clearCanvasLocally();
  });

  // Event: Encrypted Chat message broadcast
  socket.on('chat-message', (encryptedMsg) => {
    // Show Cipher Log
    logCiphertextToMonitor(encryptedMsg.sender, encryptedMsg.text);

    // Decrypt E2E message
    const decryptedText = decryptMessage(encryptedMsg.text, e2eSecretKey);
    appendChatMessage(encryptedMsg.sender, decryptedText, false);
  });

  // Event: File share broadcast
  socket.on('receive-file', (fileData) => {
    appendFileToContainer(fileData);
    showToast('File Shared', `${fileData.sender} shared "${fileData.name}"`, 'success');
  });

  // Event: Peer disconnected
  socket.on('user-left', ({ socketId, username }) => {
    showToast('User Left', `${username} left the meeting`, 'warning');
    closePeerConnection(socketId);
  });
}

// --- WEBRTC MEDIA HANDLING ---
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    document.getElementById('local-video').srcObject = localStream;
  } catch (err) {
    console.error('Camera/Mic permission error:', err);
    showToast('Media Warning', 'Cannot access webcam/microphone. Proceeding as audio-only/listen-only.', 'warning');
    // Fallback stream
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      localStream = new MediaStream();
    }
  }
}

function initiatePeerConnection(targetSocketId, targetUsername, isInitiator) {
  const pc = new RTCPeerConnection(iceServers);
  peers[targetSocketId] = pc;

  // Add tracks
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  // Exchange ICE Candidates
  pc.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.emit('signal', {
        targetSocketId,
        signalData: { candidate: event.candidate }
      });
    }
  };

  // Add Remote streams to UI
  pc.ontrack = (event) => {
    let remoteVideo = document.getElementById(`video-${targetSocketId}`);
    if (!remoteVideo) {
      const container = document.createElement('div');
      container.className = 'video-container';
      container.id = `video-container-${targetSocketId}`;

      remoteVideo = document.createElement('video');
      remoteVideo.id = `video-${targetSocketId}`;
      remoteVideo.autoplay = true;
      remoteVideo.playsinline = true;
      remoteVideo.srcObject = event.streams[0];

      const overlay = document.createElement('div');
      overlay.className = 'video-overlay-tag';
      overlay.textContent = targetUsername;

      container.appendChild(remoteVideo);
      container.appendChild(overlay);
      document.getElementById('video-grid').appendChild(container);
    }
  };

  // Negotiate Session Description (SDP Offer/Answer)
  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', {
          targetSocketId,
          signalData: { sdp: pc.localDescription }
        });
      } catch (err) {
        console.error('Negotiation needed error:', err);
      }
    };
  }
}

function closePeerConnection(socketId) {
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  const el = document.getElementById(`video-container-${socketId}`);
  if (el) el.remove();
}

// --- CONTROLS DOCK DYNAMICS ---
function toggleAudioStream() {
  isAudioMuted = !isAudioMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isAudioMuted;
  });
  
  const micBtn = document.getElementById('btn-toggle-audio');
  const iconMic = document.getElementById('icon-mic');
  
  if (isAudioMuted) {
    micBtn.classList.add('muted');
    micBtn.querySelector('.btn-lbl').textContent = 'Unmute';
    iconMic.innerHTML = `<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17l-1.98-1.98V5c0-1.66-1.34-3-3-3S7 3.34 7 5v3.17L4.41 5.59 3 7l7 7v.17c0 1.66 1.34 3 3 3 1.11 0 2.08-.61 2.6-1.5l1.23 1.23C15.82 17.59 14.5 18 13 18.28V21h-2v-2.72C7.72 17.8 5 14.99 5 11.58h1.7c0 3.01 2.54 5.1 5.3 5.1 1.55 0 2.94-.66 3.9-1.72l-1.92-1.92zm-5.98-7.8l6.39 6.39.01-.76c0-1.66-1.34-3-3-3s-3 1.34-3 3v-.63z"/>`;
  } else {
    micBtn.classList.remove('muted');
    micBtn.querySelector('.btn-lbl').textContent = 'Mute';
    iconMic.innerHTML = `<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>`;
  }
}

function toggleVideoStream() {
  isVideoCameraOff = !isVideoCameraOff;
  localStream.getVideoTracks().forEach(track => {
    track.enabled = !isVideoCameraOff;
  });
  
  const camBtn = document.getElementById('btn-toggle-video');
  const iconCam = document.getElementById('icon-camera');
  
  if (isVideoCameraOff) {
    camBtn.classList.add('muted');
    camBtn.querySelector('.btn-lbl').textContent = 'Camera On';
    iconCam.innerHTML = `<path d="M18 10.48V6c0-1.1-.9-2-2-2H6.83L20 17.17l-2-6.69zM2.81 3.19L1.39 4.61 4.78 8H4c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h12c.34 0 .65-.09.93-.24l2.46 2.46 1.41-1.41L2.81 3.19zM6 16H6V10h1.78l6 6H6zm12-5.5l4-4v11l-4-4v-3z"/>`;
  } else {
    camBtn.classList.remove('muted');
    camBtn.querySelector('.btn-lbl').textContent = 'Camera Off';
    iconCam.innerHTML = `<path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4zM14 16H6v-8h8v8z"/>`;
  }
}

async function toggleScreenShareStream() {
  const shareBtn = document.getElementById('btn-screen-share');
  
  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      isScreenSharing = true;
      shareBtn.classList.add('sharing');
      
      const screenVideoTrack = screenStream.getVideoTracks()[0];
      
      // Update local preview
      const localVideo = document.getElementById('local-video');
      localVideo.srcObject = screenStream;

      // Relay screen track to remote peers
      Object.values(peers).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenVideoTrack);
      });

      // Handle screen sharing track stoppage
      screenVideoTrack.onended = () => {
        stopScreenShare();
      };
      
      showToast('Screen Share', 'Sharing screen streams...', 'success');
    } catch (err) {
      console.error('Screen sharing error:', err);
      showToast('Error', 'Screen share was cancelled', 'danger');
    }
  } else {
    stopScreenShare();
  }
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  
  const shareBtn = document.getElementById('btn-screen-share');
  shareBtn.classList.remove('sharing');
  
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  isScreenSharing = false;

  // Restore camera preview locally
  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = localStream;

  // Re-relay camera track to remote peers
  const camVideoTrack = localStream.getVideoTracks()[0];
  Object.values(peers).forEach(pc => {
    const sender = pc.getSenders().find(s => s.track.kind === 'video');
    if (sender) sender.replaceTrack(camVideoTrack);
  });
}

function toggleWhiteboardPanel() {
  const whiteboardPanel = document.getElementById('whiteboard-workspace-panel');
  whiteboardPanel.classList.toggle('hidden');
  
  // Resize Canvas to fit viewport correctly
  if (!whiteboardPanel.classList.contains('hidden')) {
    resizeCanvasElement();
  }
}

function leaveSession() {
  // Stop all media tracks
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
  }
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
  }
  
  // Close WebRTC calls
  Object.keys(peers).forEach(closePeerConnection);

  if (socket) {
    socket.close();
    socket = null;
  }

  showToast('Meeting Info', 'Session ended.', 'info');
  setupUserLobby();
}

// --- COLLABORATIVE WHITEBOARD ---
function setupCanvasListeners() {
  canvas = document.getElementById('whiteboard-canvas');
  ctx = canvas.getContext('2d');

  document.getElementById('brush-color').addEventListener('change', (e) => brushColor = e.target.value);
  document.getElementById('brush-size').addEventListener('change', (e) => brushSize = e.target.value);

  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mousemove', drawLine);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseout', stopDrawing);

  window.addEventListener('resize', resizeCanvasElement);
}

function resizeCanvasElement() {
  const wrapper = canvas.parentElement;
  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;
}

function startDrawing(e) {
  drawing = true;
  const rect = canvas.getBoundingClientRect();
  lastX = e.clientX - rect.left;
  lastY = e.clientY - rect.top;
}

function drawLine(e) {
  if (!drawing) return;
  const rect = canvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  // Draw locally
  drawCanvasLine(lastX, lastY, currentX, currentY, brushColor, brushSize, true);

  lastX = currentX;
  lastY = currentY;
}

function stopDrawing() {
  drawing = false;
}

function drawCanvasLine(x0, y0, x1, y1, color, size, shouldEmit = true) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.closePath();

  if (shouldEmit && socket) {
    socket.emit('draw', { x0, y0, x1, y1, color, size });
  }
}

function clearWhiteboardLocalAndRemote() {
  clearCanvasLocally();
  if (socket) {
    socket.emit('clear-whiteboard');
  }
}

function clearCanvasLocally() {
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// --- SECURE CHAT (E2E) ---
function handleSendChat(event) {
  event.preventDefault();
  const input = document.getElementById('chat-new-msg');
  const text = input.value.trim();
  if (!text) return;

  // Encrypt client-side
  const encryptedText = encryptMessage(text, e2eSecretKey);

  // Broadcast encrypted text over Socket.io
  if (socket) {
    socket.emit('chat-message', {
      sender: currentUser.username,
      text: encryptedText
    });
  }

  // Log cipher details locally
  logCiphertextToMonitor('You', encryptedText);

  // Append decrypted locally
  appendChatMessage('You', text, true);
  input.value = '';
}

function appendChatMessage(sender, text, isSelf) {
  const container = document.getElementById('chat-messages-container');
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${isSelf ? 'chat-bubble-self' : ''}`;
  bubble.innerHTML = `
    <span class="chat-sender">${escapeHTML(sender)}</span>
    <span class="chat-text">${escapeHTML(text)}</span>
    <span class="chat-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function logCiphertextToMonitor(sender, ciphertext) {
  const monitor = document.getElementById('network-cipher-log');
  const line = document.createElement('div');
  line.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
  line.style.padding = '4px 0';
  line.innerHTML = `<span style="color:var(--primary)">[Encrypted Packet]</span> from ${escapeHTML(sender)}: <strong style="word-break:break-all;color:var(--warning)">${ciphertext}</strong>`;
  monitor.appendChild(line);
  monitor.scrollTop = monitor.scrollHeight;
}

// --- FILE SHARING ---
function handleShareFile(inputElement) {
  const file = inputElement.files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    showToast('File Error', 'File size exceeds 5MB limit', 'danger');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const fileData = {
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: reader.result,
      sender: currentUser.username
    };

    // Emit file details to other users
    if (socket) {
      socket.emit('share-file', fileData);
    }

    // Append to local list
    appendFileToContainer(fileData);
    showToast('File Shared', 'File shared in meeting room!', 'success');
  };
  
  reader.readAsDataURL(file);
  // Reset input
  inputElement.value = '';
}

function appendFileToContainer(fileData) {
  const container = document.getElementById('shared-files-container');
  
  // Clear placeholder if first file
  const placeholder = container.querySelector('.text-small');
  if (placeholder) placeholder.remove();

  const el = document.createElement('div');
  el.className = 'file-item glass-panel';
  
  const sizeKb = Math.round(fileData.size / 1024);
  
  el.innerHTML = `
    <div class="file-item-info">
      <span class="file-name">${escapeHTML(fileData.name)}</span>
      <span class="file-meta">${sizeKb} KB • Share by ${escapeHTML(fileData.sender)}</span>
    </div>
    <a href="${fileData.dataUrl}" download="${escapeHTML(fileData.name)}" class="btn btn-secondary text-small">Download</a>
  `;
  container.appendChild(el);
}

// --- SIDEBAR TAB CONTROLS ---
function switchSidebarTab(tab) {
  const chatTab = document.getElementById('sidebar-tab-chat');
  const filesTab = document.getElementById('sidebar-tab-files');
  const chatContent = document.getElementById('sidebar-chat-content');
  const filesContent = document.getElementById('sidebar-files-content');

  if (tab === 'chat') {
    chatTab.classList.add('active');
    filesTab.classList.remove('active');
    chatContent.classList.remove('hidden');
    filesContent.classList.add('hidden');
  } else {
    chatTab.classList.remove('active');
    filesTab.classList.add('active');
    chatContent.classList.add('hidden');
    filesContent.classList.remove('hidden');
  }
}

// --- TOAST UTILITIES ---
function showToast(title, message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-header-info">
      <span class="toast-title">${escapeHTML(title)}</span>
      <button class="toast-close" onclick="this.parentElement.parentElement.remove()">&times;</button>
    </div>
    <span class="toast-message">${escapeHTML(message)}</span>
  `;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, 6000);
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}
