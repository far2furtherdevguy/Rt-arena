# RT Arena

A free online 3D party game: up to 8 players shove each other off a shrinking platform. Bots fill empty slots up to 6 players, so a match is always playable. Built with **Babylon.js** (3D), **Capacitor** (Android APK) and a tiny **Node.js WebSocket server**. It needs **no 3D model files**: everything is drawn from simple shapes in code.

```
.github/workflows/android.yml   builds the APK on GitHub (no PC needed)
client/                         the game (Vite + Babylon.js + Capacitor)
  index.html  package.json  vite.config.js  capacitor.config.json
  src/main.js
server/                         the multiplayer server (Node 20+, one dependency: ws)
  index.js  app.js  sim.js  package.json
  test/sim.test.js  test/e2e.test.js
```

## Setup (about 15 minutes, works from a phone)

### 1. Put the code on GitHub
Create a repository, then add every file above with the same folder paths
(on GitHub: **Add file > Create new file**, type the full path such as `client/src/main.js` in the name box, paste the contents, commit).
Keep the file contents exactly as given.

### 2. Start the backend (free, on Render)
1. Create a free account at **render.com** and connect your GitHub.
2. **New > Web Service** and pick your repository.
3. Fill in:
   - **Root Directory:** `server`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
   - **Health Check Path** (under Advanced): `/health`
4. Create it. After the deploy finishes, copy the address, like `https://rt-arena.onrender.com`.
5. Open `https://rt-arena.onrender.com/health` in a browser. It should say `ok`.

Your game address is the same URL with `wss://` in front: `wss://rt-arena.onrender.com`

Notes
- Render reads the port from the `PORT` variable. The server already uses it, so you set nothing.
- Free instances sleep after a while without players. The first connect can take up to a minute; the game retries automatically ("Waking up the server...").
- Free-tier rules change, so check Render's pricing page. Fly.io, Railway or any small VPS also work: run `npm install` then `npm start` inside `server/` and put HTTPS/WSS in front of it.

### 3. Tell the app where the server is
In your GitHub repository: **Settings > Secrets and variables > Actions > Variables tab > New repository variable**
- Name: `SERVER_URL`
- Value: `wss://rt-arena.onrender.com` (your address)

(If you skip this the app still builds. In the game, tap **Server** on the menu and type the address.)

### 4. Build the APK
1. Open the **Actions** tab, choose **Build RT Arena APK**, press **Run workflow**. (It also runs on every push to `main`.)
2. Wait about 6 to 10 minutes. Open the finished run and download the **RT-Arena-apk** artifact (a zip containing `RT-Arena.apk`).
3. Unzip, open `RT-Arena.apk` on your Android phone and allow "install unknown apps" when asked.

The workflow generates the Android project, app icon, splash screen, landscape lock and fullscreen mode by itself. Steps that are only cosmetic cannot fail the build, and downloads are retried. The server tests also run but never block the APK.

### 5. Play
- **Quick Play:** joins an open room (bots fill the room up to 6 players).
- **Create Private Room:** gives a 4-letter code. Friends enter it next to **Join**. Tap the room label in the game to share the code.
- **Controls:** a big joystick sits bottom-left (touch it, or touch anywhere on the left side and it moves under your thumb). Tap the large **DASH** button bottom-right to ram; its ring shows the cooldown. Keyboard: WASD or arrows, Space to dash. The Android back button leaves the match.
- Last player on the platform wins. After 8 seconds the ring shrinks.

## Do you need 3D models?
Not for this version. Players are spheres, the arena is a cylinder, and sounds are generated in code.
When you want nicer art later, use free low-poly packs:
- **kenney.nl** (CC0, huge free game asset packs)
- **quaternius.com** (CC0, low-poly characters and props)
- **poly.pizza** (free low-poly models, check each license)
- **Blender** (free) to make your own. Export as `.glb`.

Tips: keep each character under about 2,000 triangles, use one small texture or flat colours, and keep the total scene light. To load a `.glb`, add `@babylonjs/loaders` to `client/package.json`, put the file in `client/public/`, and load it with `SceneLoader.ImportMeshAsync`. Always check the license, and credit the author if it requires it.

## Phone performance
- The game is landscape-only and fullscreen. Graphics has 3 levels (menu link); if the frame rate stays low the game lowers it by itself.
- The screen stays awake during a match, the server sends about 20 updates a second, and the 3D scene is only a handful of simple shapes, so battery and data use stay low.
- To change the number of bots, edit `fillTo` in `server/sim.js`.

## Troubleshooting
- **"Cannot reach the server":** open `https://YOUR-SERVICE.onrender.com/health` in a browser. If it does not say `ok`, check the Render logs. Make sure the address in the app starts with `wss://`.
- **Workflow red at "Build APK":** open the failed step, find the first line starting with `error:` or `FAILURE:` and send it to me.
- **Lag:** pick a Render region near your players. In the menu, set Graphics to Low on older phones.
- **Change the app name or id:** edit `client/capacitor.config.json`.

## Run on a computer (optional)
```
cd server && npm install && npm start
cd client && npm install && npm run dev
```
Open `http://localhost:5173/?server=ws://localhost:2567` (or your PC's address from a phone on the same Wi-Fi).

## How it works
The server is authoritative: clients only send their stick direction and dash presses (20 times a second). The server simulates at 30 Hz, handles bots, collisions, the shrinking ring and rounds, and broadcasts snapshots. The client smooths them with interpolation. Names are cleaned, messages are size- and rate-limited, and dead connections are dropped by heartbeat. Add a profanity filter and reporting before opening to the public.

## Roadmap ideas
Race and wrestling mini-games, a level editor that saves rules as small JSON files, a 4v4 football mode, crews/territory points, cosmetics.
