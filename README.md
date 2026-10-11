# loyaltycards

A small site that keeps loyalty cards behind a PIN. Enter the PIN, tap a card, and its barcode and number fill the screen for the till. The cards you opened most recently come first; that order is remembered separately on each phone or browser.

It is plain HTML, CSS and JavaScript with no build step, so GitHub Pages can serve it straight from this repo.

## How the PIN works

The cards are not readable anywhere in this repo. They live in `vault.js`, encrypted with a key made from the PIN (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM). The browser only gets the list after the right PIN is entered, and it forgets it again when you lock the site or leave it in the background for five minutes.

A short PIN keeps out anyone who stumbles on the page. It does not stop someone determined: `vault.js` is public, and every 4-digit PIN can be tried in under an hour on an ordinary computer. Use a longer PIN if that matters for these cards. The keypad takes whatever length you choose.

## Add, remove or change a card

You need Node 18 or newer. Nothing to install.

1. Unlock the list into a readable file:

   ```
   node tools/vault.mjs decrypt
   ```

2. Edit `cards.json`. Each card looks like this:

   ```json
   {
     "name": "Example Rewards",
     "format": "CODE128",
     "value": "1234567890",
     "number": "1234 567 890",
     "bg": "#0058A3",
     "fg": "#FFFFFF"
   }
   ```

   - `format` is the barcode type: `CODE128`, `EAN13`, `UPC`, `ITF`, `CODE39` or `QR`. A free scanner app will tell you which type a card uses. Use `NONE` for a card that only has a number to read out; set `value` to that number without spaces.
   - `value` is exactly what the barcode holds. `EAN13` needs all 13 digits and `UPC` all 12, including the last check digit, which is often not printed on the card.
   - `number` is what to show under the barcode, spaced however reads best. Leave it empty to show nothing.
   - `bg` and `fg` are the tile's colour and text colour.

3. Lock it again and publish:

   ```
   node tools/vault.mjs encrypt
   git add vault.js
   git commit -m "Update cards"
   git push
   ```

`cards.json` is git-ignored. Keep it that way, and delete it once you are done.

## Change the PIN

Run `decrypt` with the old PIN, then `encrypt` with the new one, and push `vault.js`.

## What is in here

| File | What it does |
| --- | --- |
| `index.html`, `app.css`, `app.js` | The site |
| `vault.js` | The encrypted card list |
| `tools/vault.mjs` | Locks and unlocks the card list |
| `sw.js`, `manifest.webmanifest`, `icons/` | Lets the site open with no signal and be added to a phone's home screen |
| `vendor/` | [JsBarcode](https://github.com/lindell/JsBarcode) and [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), both MIT licensed |
| `fonts/` | Bricolage Grotesque, SIL Open Font License |
