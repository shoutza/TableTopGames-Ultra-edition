# Open TableTopGames

1. Download and extract the project ZIP, or open your existing project folder.
2. Install [Node.js LTS](https://nodejs.org/en/download) once, using the default installer options, if you do not already have Node.js 22.18 or newer.
3. **Windows:** double-click **Start-TableTopGames.bat**. **Mac:** double-click **Start-TableTopGames.command**.

The launcher handles setup and opens the studio in your browser. The first launch needs internet to install dependencies; later launches reuse them. No terminal commands or API key are required to play with offline contestants.

Keep the launcher window open while playing. **Press Ctrl+C in that window to save and stop.** Opening the launcher again reopens the running studio. If the usual port is busy, it uses another local port automatically.

## Optional AI contestants

The first launch creates a `.env` settings file beside the launcher. Add your key after `OPENAI_API_KEY=` and leave `TTG_CONTESTANT_PROVIDER=auto`. Stop the studio with Ctrl+C and launch again to apply your changes. Keep `.env` private.

## Your saved games

Saves live in the `data` folder beside the launcher, unless you changed `TTG_DATA_DIR`. Starting the studio never clears your saves or overwrites existing settings. When downloading an update into a new folder, copy your `data` folder and `.env` file across before launching.

## If it does not open

- **Node.js missing or too old:** install Node.js LTS, then reopen the launcher.
- **Setup failed:** check your internet connection and try again. The launcher keeps the error visible.
- **Browser did not open:** open the address printed in the launcher window.
- **Mac says permission denied after extracting a ZIP:** open Terminal in the project folder and run `bash Start-TableTopGames.command` once. A Git checkout preserves its executable permission.
- **Linux or terminal users:** run `npm start` from the project folder. Use `npm start -- --no-browser` to open the address yourself.
