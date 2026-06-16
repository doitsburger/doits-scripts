# Doits Scripts – Torn Userscripts

A small collection of quality-of-life userscripts for torn.com, designed to be lightweight, practical, and easy to use.

All scripts support auto-updates via GitHub.

---

## 📦 Requirements

You will need one of the following:

**Option 1: Desktop / Mobile Browser**  
- [Tampermonkey](https://www.tampermonkey.net/) (recommended)  
- or [Violentmonkey](https://violentmonkey.github.io/)

**Option 2: Torn PDA (Mobile App)**  
- [Torn PDA app](https://tornpda.com/) (Android / iOS)

---

## 📥 Installation

### 🔹 Browser (Tampermonkey / Violentmonkey)
1. Install Tampermonkey  
2. Click one of the install links below  
3. Confirm installation in the userscript manager  

Updates are handled automatically.

### 🔹 Torn PDA (Mobile App)
1. Open Torn PDA  
2. Go to **Settings** → **Userscripts**  
3. Tap **➕ Add Userscript**  
4. Select **“Remote Load / Update”**  
5. Paste the **RAW install link** for the script  
6. Save and enable the script  

⚠️ Make sure you use the `raw.githubusercontent.com` link, not the GitHub page link.

---

## 🔧 Available Scripts

### 🛰️ Doitsburger’s FF Scouter
Scouts and displays Fair Fight (FF) information in a quick, readable format to assist with decision-making during fights.

**🔑 API Requirements (Important)**  
Before using this script, you must:  
- Register a Torn Limited API key at [https://ffscouter.com](https://ffscouter.com)  
- Register a "Public" Torn API key (for gathering non-FFscouter data, such as player stats, battle stats, or other Torn information used by the userscript)  
- Use both API keys when prompted by the userscript  

💡 **Why two keys?**  
The first key (from ffscouter.com) handles FF‑specific data. The second key (a regular Torn API key) is required to retrieve all other non‑FFscouter data that the script needs to function fully.

**Install (Browser / Torn PDA):**  
`https://raw.githubusercontent.com/doitsburger/doits-scripts/main/ff-scouter/doitsburgers-ff-scouter.user.js`

👉 After installing the userscript, you will be prompted to enter both API keys the first time you visit a Torn profile page.  
This step is required for the script to function correctly.

**👥 Attribution & Credits**  
Attribution:  
This script is not solely original work.  
It is based on and inspired by the original FF Scouter userscripts created by members of the Torn community.  
Original authors: **rDacted, Weav3r, GFOUR**  
This version includes modifications, maintenance, and enhancements by doitsburger.  
Full credit and respect to the original authors.

---

### 🎯 Doitsburger’s FF Target Finder
Quick target finder. Fetches random targets from FFScouter based on your Fair Fight (FF) range, inactivity, and faction filters.

**🔑 API Requirement (Important)**  
Before using this script, you must:  
- If you are already using the FF Scouter you can use the same API KEY  
- Or register a Torn Limited API key at [https://ffscouter.com](https://ffscouter.com)  
- Use the same API key when prompted by the userscript  

**Install (Browser / Torn PDA):**  
`https://raw.githubusercontent.com/doitsburger/doits-scripts/refs/heads/main/ff-target-finder/DOITSBURGER's%20FF%20TARGET%20FINDER.js`

👉 After installing the userscript, you will be prompted to enter this API key the first time you use the script.  
This step is required for the script to function correctly.

**👥 Attribution & Credits**  
Attribution:  
This script is not solely original work.  
It is based on and inspired by the original FF Scouter userscripts created by members of the Torn community.  
Original authors: **FFScouter**  
This version includes modifications, maintenance, and enhancements by doitsburger.  
Full credit and respect to the original authors.

---

### ✈️ 1 Travel Tracker (Premium Standalone UI)
Real‑time travel tracking for faction members. Fetches travel data directly from the Torn API and displays flight progress, ETA windows, and honour‑bar destination backgrounds in a sleek, interactive panel. Clickable member and faction links, filtering by outbound/return, and a subtle alert when a faction member is travelling to your same destination.

**🔑 API Requirement**  
You must register a standard Torn API key with **public access** (and faction permission). The script will prompt you for this key the first time you try to watch a faction.

**Install (Browser / Torn PDA):**  
`https://raw.githubusercontent.com/doitsburger/doits-scripts/main/travel-tracker/1-travel-tracker.user.js`  
*(If the actual URL differs, please replace it with the correct raw link.)*

**👥 Attribution & Credits**  
Original work by **doitsburger**. No external dependencies – all processing runs client‑side.

---

### 🖼️ Background Image
Adds a simple custom background to Torn.com with a minimal emoji toggle button.  
Lightweight, clean, and works seamlessly on both browser and Torn PDA.

**Install (Browser / Torn PDA):**  
`https://raw.githubusercontent.com/doitsburger/doits-scripts/main/background-image/background`

---

## 🔄 Auto Updates
All scripts include automatic update support.

---

## 🛡️ Notes
- Scripts do not store API keys unless explicitly stated  
- FF Scouter API usage is handled via ffscouter.com  
- No data is sent to unrelated third-party services  
- Use at your own risk — Torn rules apply

---

## 🧑‍💻 Author & Maintainer
Maintained by **doitsburger**  
GitHub: [https://github.com/doitsburger](https://github.com/doitsburger)

---

## 📄 Licence & Credits
- Original FF Scouter concept and implementation by Torn community developers  
- Modifications, maintenance, and distribution by doitsburger  
- Provided for personal use — please respect original authorship and Torn rules
