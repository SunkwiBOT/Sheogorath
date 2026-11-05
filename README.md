
# Sheogorath Discord Bot

Sheogorath is a multi-guild Discord bot built around an Elder Scrolls Mad God persona. It combines AI chat and image generation (Grok/xAI), a YouTube music player with a channel of its own, and a UFC fight-night suite.

Each Discord server the bot serves gets its own entry in `config/guilds.json`, with a `features` list deciding what actually runs there — so the main hall and the community server share one process without sharing surfaces.

## What does it do?

- **AI Chat**: Talk to Sheogorath in character using Grok (xAI). The persona keeps per-user notes and long-term memories across conversations, and can act on the server through embedded action tags (warn, timeout, delete, remember). He answers on a mention or on his name anywhere, and unprompted in the help channel.
- **Image Generation**: `/imagine` conjures images through Grok, with the Mad God riffing on your prompt first.
- **Music Streaming**: Play YouTube music in voice channels — URL or search phrase — with a queue, saved playlists, autoplay, and a radio list loaded from `radio.csv`.
- **Music Player Channel**: A channel only Sheogorath can write in, holding one message he keeps editing: the picture of the song that's playing, how far in it is, the volume, autoplay and the queue, with buttons underneath to stop, pause, skip, change the volume, add a song, queue from the radio, clear the line or take one song out of it. Nothing new is posted per song, and anything else that lands in the channel is deleted. It replaced the companion web page, which was shut down on 2026-11-03.
- **UFC Pick'em**: Each card is posted in fight week for everyone to call the winners, each fight locked as it starts, and scored from ESPN's results into a season table. The best picker each week wears a title.
- **UFC Results**: Every fight on every UFC card and Contender Series night, posted in a channel of its own as it ends: how it ended, the judges' scorecards, both fighters' stats side by side, and the whole card in one message once the main event is done.
- **UFC Reminders**: A DM to everyone in a chosen role half an hour before each UFC card starts.
- **Events**: Anyone can put an event on the server calendar with `/event` or by telling Sheogorath, and whoever added it (or an Owner) can move it or take it off, with no config edit and no deploy. Fifteen minutes before any scheduled event, the people who clicked Interested are pinged and a thread is opened for it.
- **WoW Forever**: Members link their Battle.net account with `/wow link`, signing in on Battle.net's own page, and `/wow friends` lists everyone's BattleTag so the server can add each other in one go. Their characters' levels are followed every ten minutes for a race to 60: each milestone is posted, the first to 60 takes a title, and `/wow race` shows the standings.
- **Drops**: Twitch and Kick drops for the games the server plays, posted as each campaign appears with its rewards, watch times and end date. Anyone can follow another game with `/drops add`.
- **Clips**: Post a gameplay clip in the clips channel and Sheogorath watches it and posts it back with himself doing commentary over it, in his own voice. Any clip anywhere can also be put through the **Wabbajack** from the Apps menu, and comes back as something else.
- **Playtest**: A pinned post with an **I agree** button. Pressing it gives the Tester role, which opens the testers' channel, and records who agreed, and when, in a private channel. In the testers' channel, download buttons hand each tester a short-lived link to the newest build.
- **Moderation**: Discord native AutoMod rules, an Ollama-backed filter for sexual ASCII/Unicode text art that keyword rules can't catch, and Sheogorath himself acting as a moderator — everything he decides to do passes through a permission gate that either performs it, holds it for a Sheriff to approve, or refuses it.
- **Instagram Mirroring**: Reels posted in chat are downloaded and re-uploaded natively, compressed to the guild's boost-tier attachment limit.
- **X/Twitter Mirroring**: Video from posted X links is downloaded with yt-dlp and re-uploaded the same way. Text and photo posts are left to Discord's own embed.
- **TikTok Mirroring**: Video from posted TikTok links (including app share links) is downloaded with yt-dlp as H.264, which every Discord client can play, and re-uploaded the same way.
- **Reddit Mirroring**: Reddit-hosted video from posted Reddit links (including app share links and v.redd.it) is re-uploaded the same way. Text, image and link posts are left alone, so a post linking to YouTube keeps YouTube's embed.

## Getting Started

### Dependencies

- Node.js (v18+ recommended)
- Ollama, if the `textImageMod` feature is enabled

### Setup

1. Clone the repo and install dependencies:
	```sh
	npm install
	```
2. Copy `.env.example` to `.env` and fill in your credentials. `.env` holds **credentials only** — guild, channel and role IDs live in `config/guilds.json`.
3. Start the bot:
	```sh
	npm run start
	```

## Available Commands

Commands are loaded from `src/commands/*.js`. Two things decide whether a command is usable in a given guild, both driven by `src/utils/permissions.js`:

- **Feature gate** — commands mapped in `COMMAND_FEATURES` are only *registered* in guilds whose `config/guilds.json` entry lists that feature. Unmapped commands register everywhere.
- **Permission tier** — Owner (bot admin), Sheriff (staff), or Discord's own Administrator permission. Admins pass every staff check.

### 🤖 AI & Chat
- `/ai <prompt>` - Chat with the AI bot
- `/ask <question>` - Ask a real question and get a straight answer (no Sheogorath persona)
- `/imagine <prompt>` - Command the Mad God to conjure an image from the chaos of your imagination
- `/fact-check [messages]` - Fact-check the last few messages in this channel (default: 5, max: 20)
- `/settledebate` - Sheogorath reads the last 20 messages, checks the claims on the web and rules on who is right (needs the `ai` feature)

### 🎵 Music
*Requires the `music` feature, and bot admin — music controls are admin-only, including the now-playing buttons. The music player channel's buttons also answer the roles in `roles.musicPlayer`.*

A guild with `channels.musicPlayer` set gets the music player channel (`src/music/panel.js`): the player message is posted there once, and its ID kept in `data/music-player.json` so a restart edits the same one. Add song and Radio join the voice channel he is already in, else the presser's, else `channels.defaultVoice`. A guild without it gets a now-playing card in `channels.music` for each song instead.

Every YouTube call runs yt-dlp with Node as its JavaScript runtime, which YouTube's player needs. When YouTube decides the server is a bot ("Sign in to confirm you're not a bot"), songs end two seconds in and the player says why; after three in a row it stops and keeps the rest of the queue for **Play**. The cure is a Netscape-format cookies export from a browser signed in to YouTube (a spare account is safest), saved as `www.youtube.com_cookies.txt` in the bot folder. It is read on the next song, with no restart.

- `/play <query>` - Play a YouTube song by URL or search phrase
- `/pause` - Pause the current song
- `/resume` - Resume the paused song
- `/skip` - Skip the current song
- `/stop` - Stop music playback and clear the queue
- `/queue` - View the current music queue
- `/nowplaying` - Show what's currently playing
- `/clear` - Clear all songs from the queue (keeps the current song playing)
- `/remove <position>` - Remove a song from the queue
- `/autoplay` - Toggle autoplay — automatically play similar songs when the queue is empty
- `/radio [filter] [limit]` - Queue songs from the radio playlist (default: 25, max: 100)
- `/playlist save|load|list|delete <name>` - Manage custom playlists (`list` takes no name)

### 🥊 UFC Pick'em
*Requires the `pickem` feature and a channel: `ufc.pickem.channel`, or `ufc.channel` when that is unset.*

- `/pickem standings [season] [series]` - The season table (this year and UFC by default; `series:Contender Series` for that table)
- `/pickem open` - Open picks for the next card now instead of waiting for fight week *(bot admin)*

Everything else happens on the card itself. On the Monday of fight week, alongside the Discord event, the card is posted in pick'em's channel with a button per block of bouts: main card, prelims, early prelims. A card already open when that channel changes moves to the new one before its first bout, picks and all, and leaves a pointer where it was. A button opens a private panel with a row per bout; one click picks a fighter, a second takes it back. Nobody sees anyone else's picks until they lock.

Each fight locks when it starts, as ESPN marks it under way, so a pick on the main event can be changed right up until the main event begins. Once a card is under way, a pick is checked against a fresh look at ESPN rather than the last two-minute poll; if ESPN can't be reached, a fight is taken to start with its block. The first lock opens a thread on the card, and each lock posts how the room split on that fight. Results arrive in that thread as ESPN marks each bout final, with who called it; nobody is pinged. When the last bout is in, the card is scored — a point per winner called, nothing for a draw or no contest — and the reply names the week's best, who takes the weekly title (`ufc.pickem.title`, default *Oracle of the Octagon*) from whoever held it, along with a line from Sheogorath. That line is the only model call pick'em makes, about a tenth of a cent a week.

Contender Series nights are played where `ufc.pickem.contender` is `true` (it is, in the main hall). They run the same way, each fight locking as it starts, but are scored into a Contender Series table of their own with its own title (`ufc.pickem.contenderTitle`, default *Talent Scout*), so five fights on a Tuesday cannot decide the UFC season. Their Standings button shows that table. A bout scratched before it happens leaves the card and its picks go with it; a replacement opponent is a new fight to call. A bout ESPN still lists with a fighter TBA is left off until both are named, and a card with nothing but TBAs waits for the next sync rather than opening empty. Cards and picks live in guild state, so a restart loses nothing, and results are checked every two minutes only while a card is under way.

### 🏆 UFC Results
*Requires `ufc.results.channel`.*

Every card on ESPN's UFC calendar is followed: numbered events, Fight Nights and Contender Series nights alike. As ESPN marks each bout final, it is posted in that channel with everything ESPN has on it:

- **The headline**, as plain text so a notification says who won. On a title fight it says whether the belt stayed or changed hands.
- **How it ended**: *KO/TKO (punches) in round 2 at 3:19*, *Submission (rear naked choke)*, *Decision (split) after 3 rounds*, with the **judges' scorecards** on any decision or draw, read winner first.
- **The billing**: division, main event, title fight, and the odds each fighter went in at, with a note when the underdog won.
- **Both fighters' numbers side by side**, winner first: significant strikes and accuracy, head/body/leg, total strikes, takedowns, knockdowns, submission attempts and control time, then each one's record after the fight, age, height, reach, stance and country.
- **The officials**: the referee, and the judges when it went to the cards.

While a fight is on, it has a **live card** of its own: the round and the clock as ESPN has them (it counts the walkouts as under way), the fight's numbers so far and the tale of the tape, redrawn every thirty seconds, which is as often as FightCenter moves. ESPN runs a little behind the broadcast, so it is for anyone following without the stream. It is posted silently and deleted once the result is out, so the result still notifies and the channel ends the night with the same posts as before. A fight that starts and ends between two looks never gets one.

When the last bout is in, the whole card follows as one message, main card first and each block with its main event on top, decisions with their scorecards: the record of the night, for anyone who missed it. Nothing pings, and there is no model call.

Results are checked once a minute from five minutes before the first bout, and FightCenter is read every thirty seconds for the live cards; neither happens outside a fight night. The scoreboard says who won; everything else comes from ESPN's FightCenter feed, and a result it has not caught up on, or a decision still without its scorecards, waits up to three minutes. If FightCenter is down, results go out plainer rather than not at all. Records and belt holders are read before the card starts, every few hours through fight week, because ESPN may update them mid-card; a fighter ESPN lists at 0-0-0 is left without one. ESPN's scorecards are not tied to a named judge, so the judges are listed but not matched to a card. What has been told lives in guild state, so a restart mid-card repeats nothing and catches up on anything that landed while the bot was down. ESPN carries the fights, not Dana White's contract calls, so Contender Series contracts are not announced.

### ⏰ UFC Reminders
*Requires a `ufc.dmRole`.*

Everyone holding `ufc.dmRole` gets a DM `ufc.dmMinutes` (default 30) before each card's first bout: the main card, when the prelims and main card start in their own time, where it's on, and a link to the server's event for it. Contender Series nights are left out unless `ufc.dmContender` is `true` (it is, in the main hall). Cards are looked for every few hours through fight week and checked each minute, with one fresh ESPN read when the DMs are due, so a card that moves is followed. A card is marked sent before the first DM goes, so a restart never DMs anyone twice, and one after the card has started sends nothing. Members with DMs closed are skipped.

### 📜 Whispers read aloud
*Requires a `dmRelay.channel`.*

Anyone who DMs Sheogorath has the message posted in `dmRelay.channel`, quoted under their server name, with a line from him mocking them for it; he tells them in the DM that the hall has heard it. Only members of a guild with `dmRelay` set are relayed, never the bot's owner (errors reach them by DM), and at most once a minute per person. Text only: an attachment is mentioned, not reposted. Nobody is pinged.

### 🎬 Clips
*Requires the `clips` feature and ffmpeg. Commentary also needs `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.*

- **Mad God commentary** (Apps menu on a message with a video) - He watches the clip and posts it back with himself talking over it
- **Wabbajack** (Apps menu on a message with a video) - The clip comes back as something else, at random

Every clip posted in `clips.channel` gets commentary on its own, unless `clips.commentary` is `false`: 👀 goes on the clip while he watches, and the narrated version arrives as a reply a minute or less later. The Apps menu does the same for a clip anywhere else, or does one again.

Both work on any video Discord holds as a file: an upload, or the copy he mirrored from an Instagram, X, TikTok or Reddit link. The menu used on the link itself finds that copy, and anything he posts is credited to whoever posted the link, never to him, including when the menu is used on his own commentary or Wabbajack output. A link he didn't mirror (a YouTube link, a GIF site, a text post) has no file to work on. Outside the clips channel he isn't told it's a game: he works out whether it is, and someone who shared a stranger's reel isn't cast as the person in it.

He can't watch video, so he's shown four to eight stills, bunched toward the end, because a clip is saved after the moment happens. Each is labelled with the second it was taken at, and he's told how to read a shooter's screen (red means hit, a call-for-help screen means down, a kill feed means a hit landed). He writes timed lines, each is spoken in his ElevenLabs voice, and ffmpeg lays them onto the clip at their times. The game's sound is pushed down whenever he talks and comes back up when he stops. If he has more to say than the clip has length, the last frame holds while he finishes. `clips.game` and `clips.about` tell him what he's watching in that channel. Each clip costs one Grok call with the stills, metered like every other, and a few hundred ElevenLabs characters, capped at 6,000 a day (about twenty clips) because the speech-only key can't read the plan's quota.

The Wabbajack is ffmpeg alone, with no model and no cost: one of ten effects on the last 40 seconds, never the same one twice running on one person's clips. *Skooma Dreams*, *The Greymarch*, *Mania*, *Dementia*, *Cooked by Mehrunes Dagon*, *Time, Wound Back*, *Cyrodilic Brandy*, *Arena, 1994*, *Molag Bal's Tantrum* and *Cheese for Everyone*. Nobody is pinged by either.

Clips are worked on one at a time, at most five waiting, re-encoded to H.264 under the guild's boost-tier upload cap (on the server's NVIDIA encoder when it has one), and posted as a reply to the clip. A second click on a clip already being done is told so.

### 🗓️ Events
*Requires the `events` feature and a `gameNews.eventsChannel`.*

- `/event add <name> <when> [hours] [voice] [where] [game] [about]` - Put an event on the calendar
- `/event edit <event> [name] [when] [hours] [voice] [where] [about]` - Change one; only what you give changes
- `/event remove <event>` - Take one off
- `/event list` - What's coming up

`when` reads the way people say it: `Friday 8pm`, `tomorrow 7:30pm`, `tonight 9`, `next monday 9am`, `Dec 11 1pm PT`, `10/15 11am`, `2026-12-11 13:00 UTC`, `in 2 hours`, or an ISO time with its offset. A time without a named zone is in the guild's `timeZone` (default `America/Chicago`). It always needs a time of day, and the reply shows the result as a Discord timestamp, so a misreading is visible at once. `where` naming a voice channel makes it a voice event; `game` picks one of the `gameNews.steamApps` for the cover art.

Sheogorath can do all of it too, with `[ACTION:event:name|when|hours|where]` or `[ACTION:event:name|cancel]` — "Sheo, put movie night on Friday at 8 in Watch Party", "the wipe moved to 17:00 UTC". He is told the current time and the calendar in his knowledge block, so "Friday" means the right Friday and he can answer "when does PoE2 launch?" from the calendar itself. He posts the result underneath as a Discord timestamp, the same as the command.

Anyone may add an event. Moving or removing one is for whoever added it and an Owner; the launches listed in `gameNews.events` belong to no one, so only an Owner changes them. Events added in Discord, and changes to listed ones, live in guild state as an override laid over config, so the config file never needs editing for a date again. An edit brings back an event somebody deleted by hand in Discord; a removed config launch stays removed.

Fifteen minutes before **any** scheduled event in the server — these, the UFC cards, and ones made by hand in Discord — the people who clicked Interested are pinged by name in the events channel, with a link, and a thread is opened for the evening. Nobody interested means no post, and a UFC card gets no thread because pick'em runs its own. Each event is reminded once.

### 🎁 Drops
*Requires the `drops` feature and a `gameNews` block.*

- `/drops list` - The games we follow, and which have drops on now
- `/drops add <game>` - Follow a game for drops, named as Twitch or Kick has it (it suggests the games with campaigns on)
- `/drops remove <game>` - Stop following one you added

The games followed are the `gameNews.steamApps`, any named in `gameNews.drops.games` (for a game not on Steam, like *World of Warcraft: Forever*), and any added with `/drops add`. Anyone may add a game; whoever added it, or an Owner, may take it off, and only an Owner can take off one from config. What is added or removed in Discord lives in guild state, laid over config like the calendar's changes, so the list never needs a deploy.

Every half hour, with the game news, both sites are read. Each new campaign for a followed game is posted once in `gameNews.drops.channel` (the news channel when unset), with what's new for one game on one site in a single post: when it ends, which channels it's limited to, each reward and the watch time or subs it takes, quickest first, and links to the campaign and to where the game's account is linked. `gameNews.drops.pingRole` pings a role with it; unset, nobody is pinged. A campaign already running is posted the first time it is seen, including straight after `/drops add`, because a running campaign is exactly what's worth knowing. Sheogorath is told what's on as of the last check, so "any drops for Rust?" gets a true answer.

A game matches when every word of its name appears, in order, in the site's name for the game: *Rust* matches *Rust Console Edition* but not *Rusty Lake*, and *Dawn of War IV* matches *Warhammer 40,000: Dawn of War IV*. Follow *RuneScape* and *Old School RuneScape*'s drops come with it. Where two followed games both match, the one naming more words has it: with *Path of Exile* and *Path of Exile 2* both followed, a Path of Exile 2 campaign is posted and listed under that alone.

Neither site offers drops through its official API. Twitch's come from [drops.sunkwi.com](https://drops.sunkwi.com/docs), a community mirror of the campaign list, and Kick's from the endpoint kick.com's own drops page reads. Neither needs a key, and both are undocumented, so either may change or vanish: a site that can't be read is logged and skipped, the other still posts, and `/drops list` says which one is missing.

### ⚔️ WoW Forever
*Requires the `wow` feature, `PUBLIC_URL`, `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`.*

- `/wow link` - Sign in with Battle.net to link your account, or to refresh your characters
- `/wow whois [who]` - Someone's BattleTag and WoW Forever characters (you by default)
- `/wow friends [post]` - Everyone in the server who has linked, with their BattleTag and highest character; `post:True` puts it in the channel instead of showing just you
- `/wow race [post]` - The race to 60: everyone who has linked, by their highest character, with the first to 60 crowned
- `/wow unlink` - Forget your Battle.net account

Linking works like `/wardogs link` did with Steam (`src/services/battlenet.js`). The command hands a one-time link, good for ten minutes, to `/wow/login` on the bot's web server, which sends the browser on to Battle.net's own sign-in and consent page; the bot never sees a password. Battle.net sends it back to `/wow/callback` with a code, which is traded for a token. The bot asks Battle.net for the BattleTag and the account's WoW Forever characters, keeps those in `data/battlenet.json`, and drops the token: it lasts a day and cannot be renewed, so nothing holds one. Characters refresh when someone links again, which is one click once Battle.net remembers them. One Battle.net account belongs to one member; whoever signed in with it last has it.

Everyone in the server can see a linked member's BattleTag, and `/wow link` says so before they sign in. Replies are seen only by whoever asked, unless `/wow friends` is told to post. Members who have left are not listed.

**Forever's characters.** At launch (2026-11-04) Blizzard had not published the API namespace that WoW Forever's characters live under, so each link tries `BLIZZARD_FOREVER_NAMESPACE` when it is set, else a few likely names, and the log says which answered (`[Battle.net] profile-forever-us answered with 2 character(s).`). When none does, the BattleTag is still linked and `/wow whois` says characters are not readable yet. Once Blizzard names the namespace, set it in `.env`, and anyone who runs `/wow link` again gets their characters. Classic Era's `profile-classic1x` is not guessed, because those are another game's characters. On launch night the first real link was answered by `profile-forever-us`, the first name tried.

**The race to 60** (`src/services/wowRace.js`). Every ten minutes each linked character's level is read from its public character profile with the bot's own app token, so nobody has to link again for their level to move; a member's place is their highest character, up to ten followed each. In a guild with `wow.channel` set, each time a member's best character passes 10, 20, 30, 40 or 50 it is posted there with a line from Sheogorath, picked from a list with no model call. The first member seen at 60 is posted with his verdict (one model call, about a tenth of a cent, once) and takes `wow.title`, default *The Mad God's Champion*, through the same title executor pick'em uses; everyone after is posted with the place they finished. Nobody is pinged but the first to 60. What someone had already reached when the board first saw them is not announced, so linking at 34 brings no posts for 10, 20 and 30, though linking at 60 can still finish the race. What has been announced lives in guild state, so a restart repeats nothing, and levels only ever go up.

Forever characters have a first name and a surname and no realm. Each comes from the account profile with its own public profile link (`/profile/wow/character/{name}-{surname}`), which the race reads; characters linked before launch were kept without one and are replaced by their owner's next `/wow link`. Blizzard answers that link with 404 for characters it doesn't publish: on 2026-11-05 a level 11 character was read and level 1 ones were not, so as on retail, a character seems to be followed from level 10 (`[WowRace] Blizzard answers Forever character lookups: read 1 of 4.`). Below that, a level only moves when its owner runs `/wow link` again. A character made after linking joins the race on the member's next `/wow link`, which keeps every level already found.

**Setting it up.** Make a client at [develop.battle.net](https://develop.battle.net/access/clients) with its Redirect URL exactly `<PUBLIC_URL>/wow/callback`, and put its ID and secret in `.env`. `PUBLIC_URL` is the web server's public HTTPS address: the same Tailscale Funnel the WARDOGS sign-in used, and `WARDOGS_PUBLIC_URL` is read when it is unset. The web server starts whenever a guild has `wow` on.

### 🔒 Playtest agreement
*Requires a `playtest` block.*

For a game that isn't out yet: a post with the terms (keep it to the test group) and an **I agree, let me in** button. Pressing it gives `playtest.role`, which should be the only way into `playtest.channel`, and writes who agreed, with their Discord ID and the time, in `playtest.log`, a private channel. Grime & Punishment's own NDA signatures, sent by the game through a webhook, land in the same channel, so both records of a tester sit together. The button only gives the role: taking a tester out is done by taking it off.

`node scripts/post-playtest.js <guildId> --apply` posts the button in `playtest.post` and pins it. Once is enough; the button keeps working across restarts. `playtest.game` names the game in the post.

**Downloads** (`playtest.downloads`): `--downloads` posts a button per build in `playtest.downloads.channel`, the testers' channel. Pressing one checks the presser holds the role and answers, to them alone, with the link to the asset of that name on the `repo`'s release `tag`, and the file's `how` (where to put it and how to start it). For Grime & Punishment that is the public builds repo the game updates itself from: each build re-makes the release under the same tag, so the link never changes, always gets the newest build, and needs no key. GitHub's public API gives the file's size and age for the answer; if it doesn't answer, the link is handed out without them, and while a new build is going up (a few seconds with no release) the presser is asked to try again in a minute. Each download is recorded in `playtest.log`. Sheogorath only needs to be in the testers' channel to post the buttons; they keep working after he is taken out of it, which keeps him out of the testers' talk.

**Feedback form** (`playtest.feedback`): `--feedback` posts a **Give feedback** button in `playtest.feedback.channel`. It opens the questions in `pages` as Discord forms, five to a form (Discord's limit), for anyone holding the role or one of `uncounted`. Each page's answers are posted in `answers`, a private channel, as soon as that page is sent, the later pages as replies to the first, and a `file` question's upload (the host's playstats.txt) is copied into the post, since Discord's link to an upload lapses. A question is `{id, label, type, options?, required?, description?, placeholder?}`, `type` being choice, multi, short, long or file; labels are cut to 45 characters and anything past Discord's limits is dropped, so round 2's changes are an edit to the config and a restart. If Discord ever refuses a form because of its upload question, that page is shown without it.

### 🧼 Patch notes
*Requires a `changelog` block.*

Once a day, at `changelog.hour` in the guild's time zone (18:00 by default), a **Patch notes** post in `changelog.channel` listing every change in the builds since the last one. Each build is published to the public `repo`'s release `tag` (Grime & Punishment's builds repo, the one the game updates itself from) with its changes as "- " lines in the notes; the release is replaced at every build, so Sheogorath checks its build.txt every two minutes and keeps each new build's lines until the day's post. Brackets naming the team ("(Fisher: ...)") are left out, a post too long for one embed ends with "...and N more changes", and a day with no game changes posts nothing. In an `autoPublish` channel the post is published to every server following it. The first run starts from the build that is up and posts nothing older. `node scripts/post-changelog.js <guildId>` shows what the next post will say; `--seed <file>` (with the bot stopped) sets what has gathered.

### 🛡️ Moderation
- `/sheo status` - What Sheogorath is allowed to do unsupervised, what he has done in the last hour, and how many approval cards are waiting *(Owners only)*
- `/sheo mode <shadow|assist|enforce>` - Change how much he may do without asking. Persisted to `config/guilds.json`, so it survives a restart
- `/sheo unleash` - Clear the hourly action brake early
- `/mod warn|kick|ban|timeout <user> ...` - Moderation actions *(requires the `moderation` feature and Administrator)*
- `/stats` - Show bot statistics *(requires the `moderation` feature and Administrator)*
- `/automod status` - View current AutoMod status *(requires the `automod` feature and Administrator)*
- `/automod words <on|off> [words]` - Toggle the blocked words filter. Pass `words` as a comma-separated list to set the terms it blocks; omit it to keep the current list. The filter stays off until the server has at least one term.
- `/automod antispam <on|off>` - Toggle the mention spam filter

### 🎧 Voice log
*Requires the `voiceLog` feature. Staff only (the `staff` or `admin` role, or Administrator).*

- `/vclog now` - Who is in voice right now, by channel, and since when
- `/vclog recent [hours]` - Every join, leave and move in the last 24 hours (up to a week), by day
- `/vclog user <user> [days]` - One person's time in voice: each stay, the channels they went through, and the total (default 7 days, up to 90)
- `/vclog top [days]` - Everyone ranked by time in voice

Every join, leave and move between voice channels is written to `data/voice-log/<guildId>.jsonl` and kept for `voiceLog.keepDays` (default 90). Mutes, deafens, streams and cameras are not logged, and neither are bots. With `voiceLog.channel` set, each one is also posted there as it happens, a few seconds' worth to a message, so a room emptying at the end of the night is one post. Replies to `/vclog` are seen only by whoever asked. Times show in each reader's own time zone.

Who is in voice now, and since when, is kept in `data/voice-log/open.json` so a restart doesn't lose it. Discord says nothing about what happened while the bot was down, so at startup it compares: anyone who left in the meantime is logged as leaving at the last time the bot was known to be running (it notes that every five minutes), and anyone who joined is logged as joining at startup. Both are marked approximate, shown with a `~`.

### 📊 Utility
- `/health` - Check bot health and service status

### The help channel

`channels.help` is the one place he answers without being called by name —
anything said there is his to pick up. Replies are debounced by four seconds and
keyed per person, so someone typing "hey", then "quick question", then the actual
question gets one answer covering all three rather than three answers to the
first. Naming him directly skips the wait and cancels anything already queued.

Messages with no text are left alone: he has no eyes on attachments, and a guess
at a screenshot is worse than leaving it for a human who can look at it. Answers
there get a larger token ceiling than banter does, since troubleshooting is steps
rather than a one-liner.

Guilds with no `channels.help` set behave as before — he waits to be addressed.

### What he actually knows

The persona is told never to break character and to answer with confidence,
which is the wrong disposition for "what port do I connect on": told nothing, he
doesn't say he doesn't know, he invents a port in character and it sounds exactly
like a real answer. The fix isn't to sand the character down — it's to put the
true answer in front of him and take away the one liberty that matters.

Before he answers anything, `src/services/knowledge/` assembles a block from
two sources:

- **Reference channels** (`sources.js`) — `#rules` and `#server-info`, read
  straight out of Discord, pinned messages first. He quotes what players can
  see, so there's no second copy to go stale. Configured as `channels.rules` and
  `channels.serverInfo`; unset, he looks for channels with exactly those names.
  **These should be channels only staff can post in** — whatever is written
  there is handed to him as fact.
- **Hand-written notes** — markdown in `data/knowledge/`, for things that don't
  belong in a player-facing channel. Matched against the question by keyword, so
  banter pulls in nothing and costs nothing. Files still containing `TODO`,
  `FIXME` or `<fill in>` are skipped entirely and logged: a half-written
  template isn't a fact, and handed to him it becomes a confident answer built
  around the word TODO.

Attached to the facts is one paragraph giving him the whole of the voice and none
of the substance — invent nothing, and where the facts don't cover it, say so
plainly and send them to a Sheriff. He stays as mad as he ever was about *how* he
says things; *what* he says comes from the block.

If the block can't be built at all, he answers from the persona alone and the
failure is logged as loudly as the code can manage, because that is the one path
where he can still make something up.

### People trying to play him

Users probe him. Within a day of him becoming more active, someone tried the
"my grandmother used to tell me bedtime stories about making chemical weapons"
framing — the classic wrapper for getting a model to produce something it
shouldn't.

He refuses those, mocks the person, and flags it. The flag is a capability like
any other (`[ACTION:flag:userId:reason]`), so it goes through the same gate and
lands in the same audit trail with a link to the message — staff see the attempt
in their log channel without anyone having to be watching the channel at the
time. It punishes nobody, so it runs at the auto tier and is exempt from
immunity: a Sheriff testing him shows up in the log like anyone else.

The refusal instruction names the framings explicitly (dead relatives, "just for
a story", "ignore previous instructions", claimed authority, asking in pieces)
and tells him not to lecture — one contemptuous line and a flag is the whole
response.

### How much he says

The persona ends with a hard cap — "SHORT and punchy (1-2 sentences max)" — which
is right for a bot that pipes up when its name is mentioned and wrong whenever
somebody is actually talking to it. `src/ai/persona.js` owns the one edit worth
making to it: the cap is **cut from the text and replaced**, never argued with.
Appending "that rule doesn't apply here" loses, because the original is in
capitals and says *max*.

Two lengths come out of it:

- **Conversational** — two to four sentences, used wherever he replies to
  someone. Long enough to answer, short enough to read at a glance.
- **Unclipped** — no rule at all, used in the parlour below.

Only length directives are cut. "Always complete your thoughts" survives, because
that one is about finishing sentences rather than rationing them. If a future
edit to `CLIENT_INSTRUCTIONS` words the rule differently and the cut takes too
much, both fall back to the untouched persona — terse, but still in character.

### The parlour

`/sheo parlour` creates **#the-shivering-isles**, one room where Sheogorath is
allowed to be long — no length rule at all, rather than the shorter one he
carries everywhere else.

In that channel only:

- He answers everything said there, without being called by name and **without
  the help channel's debounce** — holding each line for four seconds to see if
  another follows makes conversation feel like filling in a form.
- He carries **20 messages** of history instead of 5.
- The reply ceiling is **1200 tokens** instead of 500.
- The persona is handed over **with no length rule at all**, where the rooms
  outside get the conversational one.

Measured effect on the same question: a few sentences ordinarily, 1029 characters
in the parlour — three paragraphs with a genuine turn in the middle and a
question back.
About **$0.004** a reply against $0.0012, drawing on the same monthly ceiling as
everything else.

Nothing else changes there. The permission gate, the facts layer and the budget
all apply exactly as they do everywhere else, and the parlour prompt says so
explicitly: a longer leash is not permission to invent.

### Spend

Every reply costs money, and until there was a ceiling there was nothing bounding
it: the slash-command cooldown never covered the message path, each reply is two
billed requests, and the help channel answers everything. The moderation limits
below do **not** help here — they cap *actions*, and a reply that does nothing at
all still costs a full request.

`src/ai/budget.js` meters it. The figures are not estimated from a pricing table
that would go stale: xAI returns `usage.cost_in_usd_ticks` on every response —
the amount actually billed, after prompt-caching discounts and including tool
costs, at 1 USD = 10^10 ticks — and this just adds it up. Metering happens in
`httpsPost`, the one place every xAI request passes through, so a call added
later is budgeted without anyone remembering to budget it.

- **`AI_MONTHLY_BUDGET_USD`** in `.env` (default 20) is a hard monthly ceiling
  across every guild, because spend is a property of the API key, not of a guild.
- The owner (`ADMIN_USER_ID`) is DMed once each at **50%, 80% and 95%**, and
  nobody else is told. At **100%** he stops answering — in character, with no API call made — until the
  month turns or the ceiling goes up.
- The ledger lives in `data/ai-spend.json`, kept the way every data file is
  (see [Data files](#data-files)), so a crash can't leave a truncated file that
  reads as $0 spent. It has to be on disk: a monthly ceiling held in memory
  resets on every restart, and this bot restarts on every deploy.
- Twelve months of history are kept, so "is $20 the right number" stays
  answerable.
- `/sheo status` shows the month to date, today's calls, and a progress bar.

Two smaller savings: a **6-second per-user cooldown** on the AI message path
(longer than a follow-up takes to type, shorter than a Grok round-trip, so real
conversation never notices while a script hammering the channel does), and the
background memory-extraction call is **skipped in `#help`** — it was a second
billed request on every message, in the channel least likely to contain a
personal fact worth keeping.

### Sheogorath as a moderator

The AI can act on the server through action tags embedded in its replies — warn,
timeout, kick, ban, delete, notes, memories, titles and more. What
it *asks* for and what *happens* are separate steps: every tag goes through
`src/ai/capabilities.js`, which reaches one of four verdicts.

| Verdict | What happens |
| --- | --- |
| `execute` | Performed now, and recorded |
| `propose` | An Approve/Deny card in the staff channel; nothing moves until an approver clicks |
| `shadow` | Recorded as what *would* have happened; nothing is performed |
| `deny` | Refused, and the refusal recorded |

The rules that get you there, in order:

- **Staff and Owners are untouchable.** No tier, no requester, no mode can act on them. Neither can bots, or Sheogorath himself.
- **Ordinary members can only get him to act on themselves.** An action aimed at anyone other than the author of the message he is replying to degrades to an approval card unless a Sheriff asked for it. This is what contains prompt injection: the worst a member can talk him into is a card in the staff channel.
- **Bans always ask**, whoever is asking, and so do kicks unless an Owner asked.
- **Timeouts over 10 minutes ask.** Up to ten he may give himself.
- **Rate limits per capability, and a guild-wide brake** at 20 actions/hour. Both degrade to approval cards rather than refusing outright, so a busy hour costs staff a click rather than losing the action. The brake announces itself in the staff channel once when it trips.

Modes are per guild, set as `ai.mode` in `config/guilds.json` or with `/sheo mode`:

- `shadow` — acts on nothing, records every decision. **The default for a guild that hasn't set one**, so a new deployment watches before it acts.
- `assist` — everything becomes an approval card.
- `enforce` — the auto tier runs; the propose tier still asks.

Every decision — performed, proposed, refused, or shadowed — is appended to
`logs/ai-actions.jsonl` with the verdict and the reason for it. Executions and
refusals also mirror to the guild's `channels.modApprovals`, falling back to
`channels.commandLog`. **A guild with neither cannot approve anything**, so a
held action there is refused outright and reported as a refusal — he never tells
anyone a request is pending when there is nobody to consider it.

### He is not the same thing in every server

The powers he describes are assembled per guild, from that guild's own entry, so
what he offers people is what the gate will actually let him deliver:

- Powers needing a feature the guild doesn't run are gone. No `events`, no calendar.
- Powers the guild hasn't granted in `ai.powers` are gone. Omit the key for all of them; list capability names to narrow him — `["note", "memory", "clearnotes", "flag"]` leaves him a mascot who remembers you and punishes nobody.
- Powers that can only ever be proposed are gone where there is no staff channel to propose in.
- The tiers are named as that guild names them. `ai.titles` sets the words; a guild with no `roles.staff` never hears about Sheriffs at all, because it has none — the approver there is the Owner.
- `ai.standing` is one sentence about what he *is* there, handed to him verbatim: the figurehead of the main hall, the host of the community room.

`/sheo status` shows the resulting list for the guild it is run in, including
what has been withheld.

## Configuration

### Credentials — `.env`

See `.env.example` for the annotated list. In short: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` and `ADMIN_USER_ID` for Discord; `GROK_API_KEY` plus `CLIENT_NAME`, `CLIENT_INSTRUCTIONS` and `CLIENT_MODEL` for the AI persona; `OLLAMA_URL` / `OLLAMA_MOD_MODEL` for the text-image filter; `CONTROL_API_PORT` / `CONTROL_API_HOST` for the sign-in web server; `PUBLIC_URL`, `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` for `/wow`; `ERROR_CHANNEL_ID` (without it, or once that channel is gone, errors go to `ADMIN_USER_ID` by DM) and `LOG_LEVEL` optionally.

### Per-guild settings — `config/guilds.json`

One entry per Discord server, holding that guild's `features` list, channel IDs, role IDs (`admin`, `staff`, and so on), the AI moderator's `ai.mode` / `ai.powers` / `ai.titles` / `ai.standing`, and each feature's own settings. Copy the placeholder entry to onboard a second guild.

`playtest` (`role`, `channel`, `log`, `post`, `game`, `downloads`) sets up the playtest agreement and download buttons; see *Playtest agreement*.

`channels.modApprovals` is where Sheogorath posts what he wants permission to do and what he did on his own; it falls back to `channels.commandLog` when unset, so a guild with one private staff channel doesn't need a second.

Available features: `ai`, `music`, `moderation`, `automod`, `textImageMod`, `instagram`, `twitter`, `tiktok`, `reddit`, `pickem`, `events`, `ledger`, `wardogs`, `wow`, `clips`, `drops`, `voiceLog`.

`timeZone` (an IANA name, default `America/Chicago`) is where a guild's people live: what "Friday 8pm" means in `/event` and in chat, and the clock Sheogorath is told the time by.

### Data files

What the bot keeps between restarts lives in `data/`: `state.json` (the pick'em season, notes and titles, calendar changes, what the UFC feeds have posted), `memories.json`, `ai-spend.json` and `ledger.json`. None of it exists anywhere else, so every one of them goes through `src/storage/jsonFile.js`:

- **Writes never happen in place.** Each goes to a temp file that is flushed and renamed over the real one, so a crash or a power cut leaves the old file or the new one, never half of either.
- **A file that won't parse is never read as empty.** It is moved aside as `<name>.corrupt-<time>`, where nothing writes over it, and replaced with the last good copy the bot had read, or failing that the newest backup. The owner gets a DM saying which. Before this, one bad read (a typo in a hand edit, say) looked like "nothing stored yet", and the next chat message wrote an empty file over everything.
- **One backup a day** goes to `data/backups/` before the first write of the day, and two weeks of them are kept.

A missing file is still just an empty one, which is how a fresh install starts. Stop the bot before editing any of these by hand.

## Deploying

After pulling on the server, and before restarting:

```sh
npm run check && sudo systemctl restart sheogorath
```

`npm run check` looks for merge-conflict markers, compiles every script, checks that every relative `require()` names a file that exists, and parses every JSON file, all without running anything. If it fails, the old process keeps running and nothing is lost. A conflict marker that reached the server on 2026-09-26 left the bot crashing on startup and restarting every ten seconds.

## Contributing

We welcome suggestions, improvements, and new features! Open a pull request or issue to get started.
