require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cookieParser = require('cookie-parser');
const { parse } = require('url');
const scdl = require('soundcloud-downloader').default;
const fs = require('fs');
const sanitize = require('sanitize-filename');
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const adminPassword = 'hiphop';

let submissions = [];
let votingEnabled = false;
let leaderboardVisible = false;
let userHearts = {};
let userHasSubmitted = {};

function log(message) {
    console.log(`[INFO] ${message}`);
}

function checkAdminPassword(req, res, next) {
    const password = req.query.password;
    if (password === adminPassword) {
        next();
    } else {
        res.status(403).send('Forbidden: Invalid password');
    }
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

const sessionParser = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set this to true if using HTTPS
});

app.get('/admin-panel.html', (req, res) => {
    res.redirect('/admin.html');
});

app.get('/admin', checkAdminPassword, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-panel.html'));
});

app.use(sessionParser);
app.use(passport.initialize());
app.use(passport.session());
app.use(cookieParser());

app.get('/auth/discord', passport.authenticate('discord'));
app.get('/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => { res.redirect('/'); }
);

app.get('/base-url', (req, res) => {
    const baseURL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    res.json({ baseURL });
});

app.get('/logout', (req, res, next) => {
    req.logout(err => {
        if (err) { return next(err); }
        res.redirect('/');
    });
});

app.get('/user', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    res.json(req.user);
});

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Serve files from the upload directory
app.use('/uploads', express.static(uploadDir));

app.use(express.static(path.join(__dirname, 'public')));

server.on('upgrade', (request, socket, head) => {
    sessionParser(request, {}, () => {
        if (!request.session.passport || !request.session.passport.user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, ws => {
            ws.user = request.session.passport.user;
            ws.userId = ws.user.id;
            if (!userHearts[ws.userId]) {
                userHearts[ws.userId] = 0; // Initialize user hearts to 0 if not set
            }
            wss.emit('connection', ws, request);
        });
    });
});

wss.on('connection', (ws) => {
    log('WebSocket connected');

    // Send current status to newly connected client
    if (ws.user) {
        // Initialize `hasSubmitted` for the connected user if not already set
        if (userHasSubmitted[ws.userId] === undefined) {
            userHasSubmitted[ws.userId] = false;
        }

        ws.send(JSON.stringify({ type: 'user', user: ws.user, hearts: userHearts[ws.userId], hasSubmitted: userHasSubmitted[ws.userId] }));
        ws.send(JSON.stringify({ type: 'initHearts', hearts: userHearts[ws.userId] }));
        ws.send(JSON.stringify({ type: 'updateSubmissions', submissions }));
        ws.send(JSON.stringify({ type: 'toggleVoting', votingEnabled }));
        if (leaderboardVisible) {
            ws.send(JSON.stringify({ type: 'showLeaderboard', submissions }));
        }
    }

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            log(`Received message: ${message}`);

            if (leaderboardVisible && data.type !== 'reset') {
                log('Leaderboard is visible, ignoring further actions.');
                return;
            }

            if (data.type === 'submit' && !votingEnabled && ws.user) {
                const soundcloudUrl = data.link;

                // Prevent user from submitting more than once
                if (userHasSubmitted[ws.userId]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You have already submitted a song.' }));
                    return;
                }

                userHasSubmitted[ws.userId] = true;

                // Retrieve track info from SoundCloud
                let trackInfo;
                try {
                    trackInfo = await scdl.getInfo(soundcloudUrl);
                } catch (error) {
                    log(`Error fetching track info: ${error}`);
                    ws.send(JSON.stringify({ type: 'error', message: `Error fetching track info: ${error}` }));
                    return;
                }

                const sanitizedTitle = sanitize(trackInfo.title);
                const audioPath = path.join(uploadDir, `${sanitizedTitle}.mp3`);

                // Download the audio file
                await scdl.download(soundcloudUrl).then(stream => new Promise((resolve, reject) => {
                    const writeStream = fs.createWriteStream(audioPath);
                    stream.pipe(writeStream);
                    stream.on('end', resolve);
                    stream.on('error', reject);
                }));

                submissions.push({
                    id: sanitizedTitle, // It will be used to identify the submission for removal
                    link: soundcloudUrl,
                    hearts: 0,
                    user: ws.user,
                    audio: `/uploads/${sanitizedTitle}.mp3`,
                    trackId: trackInfo.id, // Store the track ID
                });
                broadcast({ type: 'updateSubmissions', submissions });
            }

            if (data.type === 'toggleVoting') {
                votingEnabled = !votingEnabled;
                if (votingEnabled) {
                    Object.keys(userHearts).forEach(userId => {
                        userHearts[userId] = 10;
                    });
                }
                broadcast({ type: 'toggleVoting', votingEnabled });
                broadcast({ type: 'initHearts', hearts: userHearts[ws.userId] });
            }

            if (data.type === 'heart' && votingEnabled && !leaderboardVisible) {
                if (userHearts[ws.userId] > 0) {
                    const submission = submissions[data.index];
                    if (submission) {
                        submission.hearts++;
                        userHearts[ws.userId]--;
                        ws.send(JSON.stringify({ type: 'updateHearts', hearts: userHearts[ws.userId] }));
                        broadcast({ type: 'updateSubmissions', submissions });
                    }
                }
            }

            if (data.type === 'finalize') {
                leaderboardVisible = true;
                broadcast({ type: 'showLeaderboard', submissions });
                votingEnabled = false;
                broadcast({ type: 'toggleVoting', votingEnabled });
            }

            if (data.type === 'reset') {
                submissions = [];
                votingEnabled = false;
                leaderboardVisible = false;
                userHearts = {};  // Reset user hearts
                userHasSubmitted = {};  // Reset user submissions
                broadcast({ type: 'reset' });
            }

            if (data.type === 'removeSubmission') {
                log(`Processing removeSubmission for ID: ${data.id}`);
                const index = submissions.findIndex(s => s.id === data.id);
                if (index >= 0) {
                    log(`Found submission at index ${index}, removing it.`);
                    submissions.splice(index, 1);
                    broadcast({ type: 'updateSubmissions', submissions });
                } else {
                    log(`Submission with ID '${data.id}' not found.`);
                }
            }
        } catch (error) {
            log(`Error processing message: ${error}`);
        }
    });
});

function broadcast(data) {
    console.log('Broadcasting data');
    console.log(JSON.stringify(data));
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

server.listen(PORT, () => {
    log(`Server is listening on port ${PORT}`);
});
