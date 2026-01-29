

Here is a professional `README.md` file for your project.

Save this file as **`README.md`** in the same folder as your HTML, CSS, and JS files.

```markdown
# 🎵 BeatBites Restaurant Jukebox System

A modern, interactive web-based jukebox system designed for restaurants and cafes. This application allows customers at different tables to request songs (via a virtual tablet/phone interface), while the DJ manages the playback queue.

Built with **Vanilla JavaScript, HTML5, and CSS3**, requiring no external frameworks or backend databases for the demo version.

---

## ✨ Features

-   **Role-Based Access:**
    -   **Customer:** Select table (1-15), search for songs, and view request cooldown timers.
    -   **DJ:** View the queue, manage "Now Playing," and play the next song.
    -   **Super Admin:** Change DJ PIN, clear the entire queue, remove bad requests, and generate QR codes.
-   **Smart Song Search:** Integrates with the **iTunes Search API** to fetch real album art, titles, and artists. Includes support for international music (e.g., Bollywood).
-   **Traffic Management:** Enforces a **5-minute cooldown** per table to prevent spamming.
-   **Real-time Updates:** Uses LocalStorage events to sync data between tabs (e.g., updating the DJ screen when a customer adds a song).
-   **Responsive Design:** Works perfectly on desktops, tablets, and mobile phones.

---

## 📂 Project Structure

```text
beatbites-jukebox/
├── index.html       # Main HTML structure
├── style.css        # All styling and animations
├── script.js        # Logic, API calls, and state management
└── README.md        # This file
```

---

## 🚀 Installation & Setup

1.  **Download:** Ensure you have the three files (`index.html`, `style.css`, `script.js`) in the same folder.
2.  **Open:** Double-click `index.html` to open it in your default web browser.
3.  **Live Server (Recommended):** For the API to work best, open the file using a local server.
    *   *VS Code Users:* Install the "Live Server" extension, right-click `index.html`, and select "Open with Live Server".

---

## 🔑 Default Credentials

| Role       | PIN / Access          | Notes                              |
| ---------- | --------------------- | ---------------------------------- |
| **DJ**     | `1234`                | Can be changed in Super Admin      |
| **Admin**  | `9999`                | Hardcoded (Access link in header)  |
| **Customer | No Login (Table #)    | Select table via buttons 1-15      |

---

## 📖 How to Use

### 1. Customer Mode
1.  Click **"Customer"** on the home screen.
2.  Select your **Table Number** from the grid (1-15).
3.  In the search bar, type a song name (e.g., "Shape of You" or "Kala Chashma").
4.  Click a suggestion from the dropdown.
5.  **Note:** You must wait **5 minutes** before suggesting another song.

### 2. DJ Mode
1.  Click **"DJ"** on the home screen.
2.  Enter the PIN (`1234`).
3.  View the **"Now Playing"** section.
4.  See the **Up Next Queue**.
5.  Click **"▶ Play Next"** to load the first song from the queue into the "Now Playing" slot.

### 3. Super Admin Mode
1.  Click the **"👑 Super Admin"** link in the top right corner.
2.  Enter the Master PIN (`9999`).
3.  **Manage Queue:** Click "Remove" on specific songs or "Clear Entire Queue" to reset everything.
4.  **Security:** Enter a new 4-digit PIN and click "Update PIN" to change DJ access.
5.  **QR Code:** Display the QR code for customers to scan (points to the Table Selection screen).

---

## ⚠️ Important Limitations

This project uses **LocalStorage** to simulate a database.

1.  **Cross-Device Sync:** Because there is no backend server, **data does not sync across different devices**.
    *   *Scenario:* If a customer uses **Phone A** and the DJ uses **Computer B**, the DJ will **not** see the customer's song.
    *   *Workaround:* To test the full experience, open the site in **two different tabs or windows on the same browser**. The tabs will talk to each other.
2.  **Internet Connection Required:** The iTunes Search API requires an active internet connection to fetch song suggestions.

---

## 🛠️ Troubleshooting

**"I can't see song suggestions while typing."**
*   Check your internet connection.
*   Open the browser Console (F12 -> Console). If you see "CORS" errors, try running the app via a "Live Server" instead of just opening the file directly.
*   Ensure `script.js` is correctly linked in the HTML footer.

**"DJ PIN isn't working."**
*   Login as Super Admin (PIN: `9999`) and reset the PIN to `1234`.

---

## 🎨 Technologies Used

*   **HTML5** (Semantic Structure)
*   **CSS3** (Flexbox, Grid, Variables, Keyframe Animations)
*   **JavaScript (ES6+)** (Async/Await, Fetch API, LocalStorage)
*   **iTunes Search API** (Song Metadata)

---

## 📄 License

This project is open source and available for educational purposes.
```
