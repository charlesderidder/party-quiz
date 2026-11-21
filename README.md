# 🎉 Homey Party Quiz — Homey SDK v3 App

Een complete, productieklare **Kahoot-stijl groepsquiz** als Homey-app (SDK v3), geoptimaliseerd voor
**Homey Self-Hosted Server (SHS)** op Proxmox / Linux / Docker / Synology.

Vier interfaces, realtime Socket.io, Web Push (VAPID), een officiële Dashboard Widget en
25 Homey Flow-kaarten (10 ALS · 7 EN · 5 DAN).

---

## 1. Mappenstructuur

```
homey-party-quiz/
├── app.js                            # Homey.App: Express + Socket.io server, Flow-registratie
├── api.js                            # Homey Web API (SDK v3) endpoints
├── app.json                          # Gecompileerd manifest (npm run build:manifest)
├── package.json
├── standalone-runner.js              # Draai de app lokaal zonder Homey (dev/preview)
├── .homeycompose/
│   ├── app.json                      # Basis-manifest (sdk 3, compatibility >=12.0.0)
│   └── flow/
│       ├── triggers/                 # 10 ALS-kaarten
│       │   ├── quiz_started.json
│       │   ├── question_asked.json
│       │   ├── question_time_up.json
│       │   ├── player_answered_correct.json
│       │   ├── player_answered_wrong.json
│       │   ├── player_rank_up.json
│       │   ├── player_entered_top3.json
│       │   ├── player_left_top3.json
│       │   ├── player_is_first.json
│       │   └── player_won.json
│       ├── conditions/               # 7 EN-kaarten
│       │   ├── is_player_winner.json
│       │   ├── is_last_answer_correct.json
│       │   ├── is_last_answer_wrong.json
│       │   ├── did_player_rank_up.json
│       │   ├── is_player_in_top3.json
│       │   ├── is_player_outside_top3.json
│       │   └── is_player_first.json
│       └── actions/                  # 5 DAN-kaarten
│           ├── start_quiz.json
│           ├── next_question.json
│           ├── give_bonus_points.json
│           ├── send_push_all.json
│           └── send_push_player.json
├── lib/
│   ├── QuizEngine.js                 # State machine, puntentelling, ranking, Flow-triggers
│   ├── PushManager.js                # VAPID-keys in Homey.settings + Web Push verzenden
│   └── FileImporter.js               # .xlsx / .csv / .json parser + voorbeeldgeneratoren
├── widgets/quiz-status/              # Officiële Homey Dashboard Widget
│   ├── widget.compose.json
│   ├── api.js
│   └── public/{index.html,icon.svg}
├── public/
│   ├── index.html                    # Overzicht / hub
│   ├── sw.js                         # Service Worker (Web Push)
│   ├── css/homey-style.css           # Homey design system (glassmorphism)
│   ├── host/{index.html,host.js}     # 📺 TV-scherm
│   ├── play/{index.html,play.js}     # 📱 Spelersscherm
│   └── admin/{index.html,admin.js}   # ⚙️ Beheer & quiz-editor
├── settings/index.html               # Homey App Settings-pagina
├── userdata/quizzes.json             # Startquizzen (NL)
├── locales/{nl,en}.json
├── scripts/build-manifest.js         # .homeycompose + widgets → app.json
└── scripts/e2e-test.js               # 44 end-to-end integratietests
```

---

## 2. Snel starten (lokaal, zonder Homey)

```bash
npm install
npm start                 # → http://localhost:3456
```

| URL | Functie |
| --- | --- |
| `http://<ip>:3456/host` | TV / hoofdschema (QR-lobby) |
| `http://<ip>:3456/play` | Spelersscherm (mobiel) |
| `http://<ip>:3456/admin` | Beheer & quiz-editor |
| `http://<ip>:3456/settings` | App-instellingen |
| `http://<ip>:3456/widget` | Dashboard widget (browserpreview) |

> 💡 Klik op `/host` op **🤖 +4 Demo Spelers** en daarna **🤖 Laat Demo-Spelers Antwoorden**
> om direct het volledige spel, het podium en alle Flow-triggers te zien zonder telefoons.

---

## 3. Installatie op Homey Self-Hosted Server (SHS)

```bash
# 1. Homey CLI (eenmalig)
npm install -g homey

# 2. Inloggen
homey login

# 3. In de app-map
cd homey-party-quiz
npm install
npm run build:manifest      # genereert app.json uit .homeycompose + widgets

# 4a. Draaien in dev-modus (live logs, ideaal voor SHS)
homey app run --remote

# 4b. Of definitief installeren
homey app install
```

De Homey-app start na `onInit()` automatisch de webserver op **poort 3456** (`0.0.0.0`).

### Poort / URL aanpassen
- Poort: `PORT`-omgevingsvariabele of via **Instellingen → Webserver poort**.
- Publieke URL (reverse proxy): **`/admin` → tab “HTTPS, Reverse Proxy & Web Push”** of `/settings`.

---

## 4. HTTPS + reverse proxy (verplicht voor Web Push op mobiel)

Browsers staan Service Workers en Web Push **alleen** toe via HTTPS (of `localhost`).
Voorbeeld met nginx:

```nginx
server {
    listen 443 ssl;
    server_name quiz.mijn-domein.nl;

    ssl_certificate     /etc/letsencrypt/live/quiz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/quiz/privkey.pem;

    location / {
        proxy_pass http://192.168.1.50:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # Socket.io websockets
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;  # → https in QR-code
    }
}
```

Vul daarna `https://quiz.mijn-domein.nl` in bij de instellingen. De QR-code op `/host`
gebruikt automatisch deze URL. **Zonder HTTPS blijft alles werken** (spel, scorebord,
ranglijst) en verschijnt de pushmelding als realtime in-app banner via Socket.io.

---

## 5. Puntentelling (vereiste #8)

```
0 ≤ t ≤ 1s        → 1000 punten  (volle score, altijd)
2s ≤ t ≤ 20s      → lineair aflopend naar 0
t ≥ 20s           → 0 punten
```

Formule in `QuizEngine.calculateTimeScore()`:

```js
score = Math.round(maxPoints * (1 - (t - 1) / (maxTime - 1)))
```

| t | 0,5s | 1s | 2s | 5s | 10s | 15s | 20s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| punten | 1000 | 1000 | 947 | 789 | 526 | 263 | 0 |

`maxTime` = de tijdslimiet per vraag (standaard 20s, instelbaar 5–90s per vraag).
Foute antwoorden leveren 0 punten op. De resterende score is live zichtbaar op `/host`
en `/play` (teller + decaying gauge).

---

## 6. Interfaces

### 📺 `/host`
- Groot auto-gegenereerd **QR-code** in de lobby (verwijst naar `/play` met juiste IP/domein).
- Live spelerslijst (Socket.io), kick-speler, quizkeuze-dropdown.
- Vraagweergave: afteltimer-balk, **live punten-teller die aftelt**, 4 gekleurde antwoordtegels
  met iconen (▲ ◆ ● ■), live antwoordteller.
- Na elke vraag: **geanimeerd Top 3-podium** + volledige ranglijst met **stijgers (▲) en dalers (▼)**.
- Subtiele **Web Audio API**-geluidjes (start, tik-tik in de laatste 5s, reveal, winnaarfanfare)
  met aan/uit-knop. Live ticker met afgevuurde Homey Flow-triggers.

### 📱 `/play`
- Mobile-first login: unieke naam, avatar (8 emoji's), Homey-tegelkleur (6 kleuren).
- Web Push-toestemming + Service Worker-registratie (VAPID-key uit `/api/vapid-public-key`).
- **Sessieherstel**: `localStorage` + unieke `playerId`; bij refresh automatisch weer in het spel
  met behoud van score en positie.
- 4 grote Homey-tegel antwoordknoppen, directe visuele bevestiging (“beantwoord op 1.2s”).
- Na de ronde: goed/fout, verdiende punten, huidige plek (met ▲/▼), achterstand op #1 en de Top 3.
- Elke ronde automatisch een Web Push (of in-app banner): goed/fout, positie, punten en de Top 3.

### ⚙️ `/admin` (en Homey App Settings)
- Volledige **CRUD** quizeditor: quiz aanmaken/verwijderen, vragen toevoegen/verwijderen/herordenen.
- Per vraag: vraagtekst, tijdslimiet (5–90s), punten, 4 opties en het juiste antwoord.
- **Import** van `.xlsx`, `.csv` en `.json` met downloadbare voorbeeldbestanden per formaat.
- Instellingen voor publieke HTTPS-URL, VAPID-subject, VAPID-keys regenereren, testpush.
- “Test Homey Flow”-paneel: DAN-acties uitvoeren en EN-condities live evalueren.
- Live logboek van alle ALS-triggers met hun tokens.

---

## 7. Flow-kaarten (25)

**ALS (10)** — alle speler-triggers leveren `[speler_naam]`, `[score]`, `[positie]`,
`[vorige_positie]`, `[quiz_naam]`; vraag-triggers `[vraag_tekst]`, `[vraag_nummer]`.

| id | Kaart |
| --- | --- |
| `quiz_started` | Als een nieuwe quiz start |
| `question_asked` | Als een nieuwe vraag wordt gesteld |
| `question_time_up` | Als de tijd voor een vraag voorbij is |
| `player_answered_correct` | Als een speler een goed antwoord heeft gegeven |
| `player_answered_wrong` | Als een speler een fout antwoord heeft gegeven |
| `player_rank_up` | Als een speler is gestegen in positie |
| `player_entered_top3` | Als een speler in de top 3 zit |
| `player_left_top3` | Als een speler buiten de top 3 valt |
| `player_is_first` | Als een speler op de 1e plek staat |
| `player_won` | Als een speler heeft gewonnen |

**EN (7)** — met autocomplete-argument `player` (incl. “⚡ Speler uit ALS-kaart”):

`is_player_winner` · `is_last_answer_correct` · `is_last_answer_wrong` · `did_player_rank_up` ·
`is_player_in_top3` · `is_player_outside_top3` · `is_player_first`

**DAN (5)**:

`start_quiz` (dropdown met quizzen) · `next_question` · `give_bonus_points` (speler + aantal) ·
`send_push_all` (tekst) · `send_push_player` (speler + tekst)

### Voorbeeldflow
> **ALS** een speler in de top 3 zit → **EN** speler is niet de winnaar → **DAN** zet lampen groen
> → **DAN** verstuur web-push “🏆 {speler_naam} staat in de top 3!”

---

## 8. Dashboard Widget

`widgets/quiz-status` toont live: vraagnummer (bijv. 3/5), aantal spelers, de Top 3 met scores en
rangverschil, plus knoppen **➡️ Volgende vraag** en **📺 Open hostscherm**.

API (`widget.compose.json`):

| Functie | Methode | Pad |
| --- | --- | --- |
| `getStatus` | GET | `/` |
| `nextQuestion` | POST | `/next` |
| `startDefaultQuiz` | POST | `/start` |

---

## 9. API-overzicht (webserver)

```
GET  /api/state                       live gamestate + quizzen + URL's
GET  /api/qr[?url=…]                  QR-code als data-URL
GET  /api/vapid-public-key            VAPID public key
POST /api/push/subscribe              pushabonnement opslaan
POST /api/push/test                   testpush (speler of iedereen)
POST /api/push/regenerate-vapid       nieuwe VAPID-keys
GET  /api/quizzes                     alle quizzen
POST /api/quizzes                     quiz opslaan (nieuw of bestaand)
DELETE /api/quizzes/:id               quiz verwijderen
POST /api/import                      .xlsx/.csv/.json upload (multipart)
GET  /api/samples/{xlsx|csv|json}     voorbeeldbestand downloaden
GET  /api/settings  ·  POST /api/settings
POST /api/control/{select-quiz|start|next|bonus}
POST /api/flow/evaluate-condition      EN-conditie testen
GET  /api/widget/status · POST /api/widget/next
```

Socket.io-events: `quiz_state`, `timer_tick`, `flow_event`, `push_notification`,
`player_join`, `submit_answer`, `host_start_quiz`, `host_next_step`, `host_select_quiz`,
`host_kick_player`.

---

## 10. Opslag

| Data | Locatie |
| --- | --- |
| Quizzen & vragen | `/userdata/quizzes.json` + `Homey.settings['quizzes']` |
| VAPID-keys | `Homey.settings['vapidKeys']` (automatisch gegenereerd bij 1e start) |
| Pushabonnementen | `Homey.settings['pushSubscriptions']` |
| Server/HTTPS-instellingen | `Homey.settings['serverConfig']` |

Het bestand `userdata/homey-settings.json` bevat lokale instellingen, waaronder VAPID-sleutels
en pushabonnementen, en wordt daarom niet in Git opgenomen. `userdata/quizzes.json` bevat de
startquizzen en kan tijdens lokaal gebruik worden aangepast; controleer wijzigingen voordat je ze publiceert.

---

## 11. Tests

```bash
npm start                      # in terminal 1
node scripts/e2e-test.js       # in terminal 2
```

44 integratietests dekken: Socket.io-verbinding, joinen, tijdscores (1000 → 0), dubbele
antwoorden weigeren, live antwoordteller, reveal, podium/rankdelta's, alle Flow-triggers,
EN-condities, bonuspunten, einde quiz + `player_won`, CRUD, import van alle 3 formaten,
instellingen/QR-URL, VAPID en sessieherstel.
