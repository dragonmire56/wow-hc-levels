# WoW Hardcore Party Tracker (GitHub Pages)

A tiny static dashboard that tracks Classic Hardcore character levels (1–60) for you + friends and publishes it on GitHub Pages.  
It pulls data from the Blizzard WoW Profile API on a schedule using GitHub Actions, then serves a simple `index.html` + JSON snapshot.

## What it shows
- Character name, realm, class, level
- **XP ring** around the level (progress to next level)
- **Levels gained in the last 7 days** (rolling window)
- “Stale” indicator if the snapshot hasn’t updated recently

## How it works
- **GitHub Action** runs on a cron schedule (and manually via `workflow_dispatch`)
- Action runs `scripts/update-levels.mjs`, which:
  - fetches character profile data from Blizzard API
  - writes `docs/levels.json` (current snapshot)
  - writes `docs/history.json` (daily level history to compute 7-day gain)
- **GitHub Pages** serves everything from the `/docs` folder

## Setup

### 1) Create Blizzard API credentials
Create a Battle.net/Blizzard API client and copy:
- Client ID
- Client Secret

### 2) Add GitHub secrets
Repo → **Settings → Secrets and variables → Actions** → add:
- `BNET_CLIENT_ID`
- `BNET_CLIENT_SECRET`

### 3) Configure your characters
Edit `characters.json`:

```json
{
  "region": "us",
  "locale": "en_US",
  "namespaces": ["profile-classic1x-us", "profile-classic-us"],
  "characters": [
    { "name": "yourchar", "realm": "defias-pillager" }
  ]
}

