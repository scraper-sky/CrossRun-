# CrossRun

A timed crossword roguelite. One clock for the whole run: two minutes to start,
finishing a crossword gives time back, and the clock drains faster every level.

## Layout

| Path | What it is |
|---|---|
| `crossrun.jsx` | The game shell: crossword run, clock, saves, menus, game over. |
| `cardrun.jsx` | The card run mode: a five-wide well where full rows and stacks score as poker hands. |
| `lexicon.json` | Packed word list, one string per word length, common words first. |
| `generate-puzzles.mjs` | Offline pipeline: fills grids, writes and verifies clues with Claude, emits `bundle.json`. |
| `bundle.json` | Pre-verified puzzles the game plays from. Regenerate to add content. |
| `assets/wood/` | The pieces of the wood UI kit the game uses (licensed, do not redistribute). |
| `dev-server.mjs` | Local dev harness: serves the game with in-browser JSX, proxies the API with your key. |
| `src/main.jsx`, `build.mjs`, `www/` | Production web build for Capacitor. |
| `ios/` | The Xcode project Capacitor generated. |

## Develop

```
ANTHROPIC_API_KEY=sk-ant-... node dev-server.mjs   # then open http://localhost:8787
```

The key is only needed for live clue writing when a level can't be served from
`bundle.json`. Without it the game still runs on the bundle and fallback clues.

## Content

```
ANTHROPIC_API_KEY=sk-ant-... node generate-puzzles.mjs --count 10000 --verify --concurrency 6 --out bundle.json
```

Clues and grids are checkpointed next to the output. If a run dies, rerun the
same command with `--resume`. To get fresh grids but keep every clue already
paid for, delete `bundle.grids.json` and run with `--resume`.

`--dry` builds grids only, with no API calls.

## Global leaderboard

`server/` is a small Node service that keeps each player's best score per
mode. Deploy it on Railway: New Project > Deploy from GitHub repo, set the
root directory to `server`, add the Postgres plugin (Railway fills in
`DATABASE_URL`), and copy the public URL it gives you.

Then tell the app where it lives by adding the URL to `expo-app/eas.json`
under the production profile:

```
"env": { "EXPO_PUBLIC_CROSSRUN_API": "https://your-service.up.railway.app" }
```

Without that variable the Global tab is hidden and the app stays offline.
Locally, `node server/index.mjs` runs an in-memory copy on port 8790 and
the dev server page points at it automatically.

Players pick a name the first time they open the Global tab. Scores are
tied to a random device id stored in the save, so a name can be changed
without losing rank.

## Git and the wood kit

The wood UI kit in `wood_ui_itch/` and the pieces copied into `assets/wood/`
are licensed for use in this app only and must not be redistributed, so they
are ignored by git and never pushed. A fresh clone needs those two folders
copied in by hand before `npm run build` or the Expo sync will work.

## Store submission material

`store/listing.md` has the App Store name, subtitle, description, keywords,
category, price and privacy answers to paste into App Store Connect.
`store/privacy.html` is the privacy policy to host at a public URL.
`store/screenshots/` holds 6.9-inch iPhone screenshots (1320 x 2868) captured
from the iPhone 16 Pro Max simulator.

## iOS via Expo and EAS (recommended)

`expo-app/` is a thin Expo shell that renders the game in a web view (an Expo
DOM component) and stores saves with AsyncStorage. Builds run on Expo's
servers, so the Mac needs no particular Xcode version.

```
cd expo-app
npm run build:ios      # syncs the game in, then: eas build -p ios --profile production
npm run submit:ios     # eas submit -p ios --latest
```

The first build asks for your Apple login so EAS can create the signing
certificate and provisioning profile. Say yes to everything it offers to
generate. The build takes 10 to 20 minutes; the submit step pushes it to
TestFlight. Version and build number live in `expo-app/app.json`; build
numbers auto-increment on EAS.

To try the wrapper locally in the simulator (works with Xcode 16):

```
cd expo-app && npm run sync && npx expo run:ios --configuration Release
```

## iOS via Capacitor (needs Xcode 26 locally)

```
npm run ios        # build www/, sync into ios/, open Xcode
```

The packaged app is fully offline: it plays from `bundle.json` and never calls
the API, so no key ships inside it.

First time in Xcode: select the App target, set your Team under Signing &
Capabilities, and pick a unique Bundle Identifier if `com.jerryxiao.crossrun`
is taken. Then Product > Archive, Distribute App > TestFlight, and add testers
in App Store Connect.

Simulator without signing:

```
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
```

`CROSSRUN_AUTOSTART=1 npm run build` makes a build that jumps straight into a
run on launch, handy for screenshots. Don't ship that one.
