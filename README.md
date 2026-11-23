# 🎉 Party Quiz — Homey SDK v3 App

Een complete, productieklare **interactieve groepsquiz** als Homey-app (SDK v3), geoptimaliseerd voor
**Homey Self-Hosted Server (SHS)** op Proxmox / Linux / Docker / Synology.

Vier interfaces, realtime Socket.io, Web Push (VAPID) en
24 Homey Flow-kaarten (11 ALS · 8 EN · 5 DAN).

---

## 1. Mappenstructuur

```
homey-party-quiz/
├── app.js                            # Homey.App: Express + Socket.io server, Flow-registratie
├── api.js                            # Homey Web API (SDK v3) endpoints
├── app.json                          # Gecompileerd manifest (npm run build:manifest)
├── package.json
├── assets/images/                    # Appafbeeldingen voor installatie en appoverzicht
├── standalone-runner.js              # Draai de app lokaal zonder Homey (dev/preview)
├── .homeycompose/
│   ├── app.json                      # Basis-manifest (sdk 3, compatibility >=12.3.0)
│   └── flow/
│       ├── triggers/                 # 11 ALS-kaarten
│       │   ├── quiz_started.json
│       │   ├── quiz_finished.json
│       │   ├── question_asked.json
│       │   ├── question_time_up.json
│       │   ├── player_answered_correct.json
│       │   ├── player_answered_wrong.json
│       │   ├── player_rank_up.json
│       │   ├── player_entered_top3.json
│       │   ├── player_left_top3.json
│       │   ├── player_is_first.json
│       │   └── player_won.json
│       ├── conditions/               # 8 EN-kaarten
│       │   ├── is_player_winner.json
│       │   ├── is_last_answer_correct.json
│       │   ├── is_last_answer_wrong.json
│       │   ├── is_last_answer_missing.json
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
├── scripts/build-manifest.js         # .homeycompose → app.json
└── scripts/e2e-test.js               # end-to-end integratietests
```

---

## 2. Snel starten (lokaal, zonder Homey)

```bash
npm install
npm start                 # → http://localhost:3456
```

Bij zelfstandig gebruik is beheer pas toegankelijk nadat bij de eerste start de
omgevingsvariabele `PARTY_QUIZ_ADMIN_PASSWORD` is ingesteld op een uniek wachtwoord van
minimaal 12 tekens. In PowerShell:

```powershell
$env:PARTY_QUIZ_ADMIN_PASSWORD = Read-Host "Eerste beheerderswachtwoord"
npm start
```

De variabele wordt alleen gebruikt als nog geen wachtwoord is opgeslagen. Verwijder haar
na de eerste start uit de omgeving; wijzig het wachtwoord daarna via `/settings`.

| URL | Functie |
| --- | --- |
| `http://<ip>:3456/` | Welkomstpagina voor spelers |
| `http://<ip>:3456/host` | TV / hoofdschema (QR-lobby) |
| `http://<ip>:3456/play` | Spelersscherm (mobiel) |
| `http://<ip>:3456/admin` | Beheer & quiz-editor |
| `http://<ip>:3456/settings` | App-instellingen |

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
npm run build:manifest      # genereert app.json uit .homeycompose

# 4a. Draaien in dev-modus (live logs, ideaal voor SHS)
homey app run --remote

# 4b. Of definitief installeren
homey app install
```

De Homey-app start na `onInit()` automatisch de webserver op **poort 3456** (`0.0.0.0`).

### Poort / URL aanpassen
- Poort: `PORT`-omgevingsvariabele of via **Instellingen → Webserver poort**.
- Publieke URL (reverse proxy): **`/admin` → tab “HTTPS, Reverse Proxy & Web Push”** of `/settings`.
- De knop **Configureren** in Homey opent dezelfde instellingen via de Homey App API.
- Kies de **standaardquiz** in de appinstellingen. De keuze wordt bij opstarten geladen
  en direct toegepast als de quiz in de lobby staat; een lopende quiz blijft ongewijzigd.

---

### Beheerdersbeveiliging

Stel bij Homey-installatie direct een beheerderswachtwoord in via **Configureren** in
de appinstellingen. Totdat dit is gebeurd is webbeheer uitgeschakeld. De eerste
configuratie via de Homey API is bereikbaar voor Homey-gebruikers en apps met toegang
tot deze app; beperk die toegang en stel het wachtwoord meteen in. Daarna is ook voor
de Homey-beheer-API het beheerderswachtwoord vereist. In de Homey-instellingen vul je
het huidige wachtwoord in en kies je **Instellingen ontgrendelen**.

Spelers gebruiken `/play` zonder beheerderswachtwoord; `/host`, `/admin`, `/settings`,
beheer-API's en spelbediening vereisen een beheerderssessie. Het wachtwoord wordt als
gezouten scrypt-hash opgeslagen. Aanmeldpogingen zijn beperkt; sessies vervallen na
acht uur en worden ingetrokken bij een wachtwoordwijziging. Via **Afmelden** beëindig
je de websessie. Spelersherstel gebruikt een afzonderlijk geheim in de browser.
Na het aanmelden bieden de tabbladen bovenaan snelle toegang tot de webpagina's; ze
zijn niet zichtbaar voor spelers zonder beheerderssessie. **Afmelden** staat in deze
navigatie en beëindigt de beheerderssessie; de spelersreset is daarvan onafhankelijk.

**Gebruik HTTPS voor aanmelden en beheer**, ook op het lokale netwerk. De ingebouwde
webserver spreekt HTTP; plaats hem achter een HTTPS-reverse-proxy en scherm de directe
HTTP-poort af voor onbevoegden. Zonder HTTPS kunnen wachtwoorden en sessies worden
afgeluisterd. Bescherm ook Homey-toegang en lokale opslag: Homey-beheerders en andere
processen met toegang tot de opslag blijven vertrouwd.

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
- Op grote schermen benut de lobby de beschikbare schermruimte voor QR-code en spelers.
- Live spelerslijst (Socket.io), kick-speler, quizkeuze-dropdown.
- **Verwijder alle spelers** verwijdert na bevestiging alle huidige spelers, hun scores
  en serverabonnementen voor push. Verwijderde spelers moeten zich opnieuw aanmelden.
- Vraagweergave: afteltimer-balk, **live punten-teller die aftelt**, 4 gekleurde antwoordtegels
  met iconen (▲ ◆ ● ■), live antwoordteller.
- Na elke vraag: **geanimeerd Top 3-podium** + volledige ranglijst met **stijgers (▲) en dalers (▼)**.
- Subtiele **Web Audio API**-geluidjes (start, tik-tik in de laatste 5s, reveal, winnaarfanfare)
  met aan/uit-knop.

### 📱 `/play`
- Mobile-first login: unieke naam, avatar (8 emoji's), Homey-tegelkleur (6 kleuren).
- Web Push-toestemming + Service Worker-registratie (VAPID-key uit `/api/vapid-public-key`).
- **Sessieherstel**: `localStorage` met een apart spelergeheim; bij refresh automatisch weer in het spel
  met behoud van score en positie zolang de app draait. Bij tijdelijk verbindingsverlies
  worden antwoorden pas weer aangeboden nadat de speler opnieuw is aangemeld.
- **Reset** beëindigt de spelerssessie, verwijdert het opgeslagen profiel en toont opnieuw
  het lege aanmeldscherm, ook in andere open tabbladen van die speler. Het pushabonnement
  wordt op de server ontkoppeld. De bestaande score blijft op het scorebord staan, maar
  is niet meer te herstellen. Andere browsergegevens en browsertoestemmingen blijven behouden.
  Een verbinding met de server is nodig om een bestaande sessie te beëindigen.
- Reset en spelers verwijderen vragen bevestiging op de pagina zelf en tonen een fout
  wanneer de quizserver niet bereikbaar is.
- 4 grote Homey-tegel antwoordknoppen, directe visuele bevestiging (“beantwoord op 1.2s”).
- Na de ronde: goed/fout, verdiende punten, huidige plek (met ▲/▼), achterstand op #1,
  de Top 3 en de volledige ranglijst. Na de laatste vraag toont de host de eindstand;
  zodra die is geopend, zien spelers hun eindpositie en volledige eindranglijst.
- **Test / Activeer Web Push** in de lobby registreert push en verstuurt een testmelding
  uitsluitend naar die speler. Fouten en geweigerde toestemming worden getoond. Push
  vereist HTTPS, een ondersteunde browser en toestemming; op iOS is een aan het
  beginscherm toegevoegde webapp vereist. Succes betekent dat de pushdienst de melding
  heeft aangenomen, niet dat het toestel haar gegarandeerd heeft getoond.
- Bij de uitslag hoort de eerste speler met een juist antwoord een geluidje op de telefoon.
  De volgorde wordt bepaald door ontvangst op de server. Houd de spelerspagina open en het
  telefoongeluid aan; browser- en toestelinstellingen kunnen geluid blokkeren.
- Elke ronde automatisch een Web Push (of in-app banner): goed/fout, positie, punten en de Top 3.

### ⚙️ `/admin` (en Homey App Settings)
- Volledige **CRUD** quizeditor: quiz aanmaken/verwijderen, vragen toevoegen/verwijderen/herordenen.
- Per vraag: vraagtekst, tijdslimiet (5–90s), punten, 4 opties en het juiste antwoord.
- **Import** van `.xlsx`, `.csv` en `.json` met downloadbare voorbeeldbestanden per formaat.
- **Back-up:** download alle opgeslagen quizzen als JSON en zet ze terug als nieuwe kopieën.
  Niet-opgeslagen wijzigingen, spelers, scores en instellingen zitten niet in de back-up.
  Back-upbestanden mogen maximaal 10 MB groot zijn.
- Instellingen voor publieke HTTPS-URL, VAPID-subject, VAPID-keys regenereren, testpush.

---

## 7. Flow-kaarten (24)

**ALS (11)** — alle speler-triggers leveren `[speler_naam]`, `[score]`, `[positie]`,
`[vorige_positie]`, `[quiz_naam]`; vraag-triggers `[vraag_tekst]`, `[vraag_nummer]`.

| id | Kaart |
| --- | --- |
| `quiz_started` | Als een nieuwe quiz start |
| `quiz_finished` | Als de eindstand wordt geopend, ook zonder spelers |
| `question_asked` | Als een nieuwe vraag wordt gesteld |
| `question_time_up` | Als de tijd voor een vraag voorbij is |
| `player_answered_correct` | Als een speler een goed antwoord heeft gegeven |
| `player_answered_wrong` | Als een speler een fout antwoord heeft gegeven |
| `player_rank_up` | Als een speler is gestegen in positie |
| `player_entered_top3` | Als een speler in de top 3 zit |
| `player_left_top3` | Als een speler buiten de top 3 valt |
| `player_is_first` | Als een speler op de 1e plek staat |
| `player_won` | Als een speler heeft gewonnen |

**EN (8)** — met autocomplete-argument `player` (incl. “⚡ Speler uit ALS-kaart”):

`is_player_winner` · `is_last_answer_correct` · `is_last_answer_wrong` · `did_player_rank_up` ·
`is_last_answer_missing` · `is_player_in_top3` · `is_player_outside_top3` · `is_player_first`

`is_last_answer_missing` controleert de huidige of laatst afgesloten vraag en is in de lobby
onwaar. Kies een speler of gebruik een spelergebonden ALS-kaart als trigger-context.

**DAN (5)**:

`start_quiz` (dropdown met quizzen) · `next_question` · `give_bonus_points` (speler + aantal) ·
`send_push_all` (tekst) · `send_push_player` (speler + tekst)

### Voorbeeldflow
> **ALS** een speler in de top 3 zit → **EN** speler is niet de winnaar → **DAN** zet lampen groen
> → **DAN** verstuur web-push “🏆 {speler_naam} staat in de top 3!”

---

## 8. API-overzicht (webserver)

```
GET  /api/state                       live gamestate + quizzen + URL's
GET  /api/qr[?url=…]                  QR-code als data-URL
GET  /api/vapid-public-key            VAPID public key
POST /api/push/subscribe              pushabonnement opslaan
POST /api/push/player-test            eigen testpush met spelergeheim
POST /api/player/reset                eigen spelerssessie beëindigen
POST /api/login · POST /api/logout    beheerderssessie starten/beëindigen
POST /api/push/test                   testpush (speler of iedereen)
POST /api/push/regenerate-vapid       nieuwe VAPID-keys
GET  /api/quizzes                     alle quizzen
POST /api/quizzes                     quiz opslaan (nieuw of bestaand)
DELETE /api/quizzes/:id               quiz verwijderen
POST /api/import                      .xlsx/.csv/.json upload (multipart)
GET  /api/backup                      back-up van alle opgeslagen quizzen
POST /api/backup/restore              back-up terugzetten als nieuwe kopieën
GET  /api/samples/{xlsx|csv|json}     voorbeeldbestand downloaden
GET  /api/settings  ·  POST /api/settings · POST /api/settings/password
POST /api/control/{select-quiz|start|next|bonus}
POST /api/flow/evaluate-condition      EN-conditie testen
GET  /api/flow/history                 beheerderslogboek
```

Socket.io-events: `quiz_state`, `timer_tick`, `flow_event`, `push_notification`,
`player_join`, `submit_answer`, `host_start_quiz`, `host_next_step`, `host_select_quiz`,
`host_kick_player`, `host_clear_players`, `player_removed`, `player_reset`, `player_session_ended`.

Alleen status, QR, de publieke VAPID-sleutel en de spelers-API's voor
push en sessiebeëindiging zijn publiek. Overige web-API's en host-events vereisen een beheerderssessie.
Pushregistratie en de eigen testpush vereisen het spelergeheim; registratie accepteert uitsluitend ondersteunde
HTTPS-pushproviders. De Homey-beheer-API verwacht `adminPassword` in de POST-body.

---

## 9. Opslag

| Data | Locatie |
| --- | --- |
| Quizzen & vragen | `/userdata/quizzes.json` + `Homey.settings['quizzes']` |
| VAPID-keys | `Homey.settings['vapidKeys']` (automatisch gegenereerd bij 1e start) |
| Pushabonnementen | `Homey.settings['pushSubscriptions']` |
| Server/HTTPS-instellingen | `Homey.settings['serverConfig']` |
| Beheerderswachtwoord | `Homey.settings['adminPasswordHash']` (gezouten hash) |

Het bestand `userdata/homey-settings.json` bevat lokale instellingen, waaronder VAPID-sleutels
en pushabonnementen, en wordt daarom niet in Git of het Homey-installatiepakket opgenomen. `userdata/quizzes.json` bevat de
startquizzen en kan tijdens lokaal gebruik worden aangepast; controleer wijzigingen voordat je ze publiceert.

---

## 10. Tests

```bash
node --test scripts/player-sound-test.js scripts/security-test.js scripts/settings-test.js scripts/quiz-engine-test.js
npm start                      # in terminal 1
node scripts/e2e-test.js       # in terminal 2, met PARTY_QUIZ_TEST_PASSWORD
```

De integratietest past quizzen, instellingen en pushabonnementen aan; draai hem alleen tegen
een aparte testinstantie, niet tegen een Homey met echte gebruikersgegevens.

De integratietests dekken: Socket.io-verbinding, joinen, tijdscores (1000 → 0), dubbele
antwoorden weigeren, live antwoordteller, reveal, podium/rankdelta's, alle Flow-triggers,
EN-condities, bonuspunten, einde quiz + `player_won`, CRUD, import van alle 3 formaten,
instellingen/QR-URL, VAPID en sessieherstel.
