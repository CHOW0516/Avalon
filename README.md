# Avalon Night

An online Avalon-style game for 5 to 10 friends, played on phones. Each player joins a room with a 4-letter code and can add their own photo.

## Run it on your computer

Needs Node.js 18 or newer.

```
npm install
npm start
```

Open http://localhost:3000. Phones on the same Wi-Fi can open `http://<your-computer-ip>:3000`.

Run the rule tests with `npm test`.

## Put it online with Render (free)

1. Put this folder in a GitHub repo.
2. Sign in at https://render.com and click **New → Web Service**.
3. Pick the repo. Use these settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Click **Create Web Service**. After a minute you get a link like `https://avalon-night.onrender.com`. Share it with your friends.

On the free plan, the server sleeps after 15 minutes with no visitors. The first visit after that takes about 30 seconds to load. Open the link a minute before game night.

Rooms and photos are kept in memory only. They disappear if the server restarts or sleeps, so a game should not be left idle for long.

## How a game works

- One person creates a room and taps **Invite** to share the link. Everyone else joins with the code.
- The host picks optional roles (Percival, Morgana, Mordred, Oberon, Lady of the Lake) and starts.
- Tap **"Tap to see your secret role"** to see your role and what you know. Tap it again to hide it.
- The leader taps players to build the team. Everyone votes. Votes show once all are in.
- Team members play Success or Fail in secret. Only the number of Fails is shown.
- If a phone locks or reloads, it rejoins the same seat.

## Files

- `server.js`: web server, rooms, photos, live updates
- `game.js`: game rules (no networking)
- `public/`: the phone page (`index.html`, `app.js`, `style.css`)
- `test/game.test.js`: rule tests
