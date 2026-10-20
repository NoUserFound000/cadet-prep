# Cadet Prep

An offline flashcard app (spaced repetition) for Cathay cadet pilot prep. It runs in any browser and can be installed to the home screen on iPhone, iPad, Mac and Windows.

- Works offline after the first visit.
- Progress is stored on each device. Use Settings → Export backup to move it between devices.
- Card decks are not in this repo. Import them under Decks.
- Library: import PDFs (books, question banks) and read them in the app. With GitHub sync on, they're stored in the private cards repo and every device can download them for offline reading.
- PDF rendering uses [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0), vendored in `vendor/pdfjs`.
- Search: PDFs with a text layer are searchable on import. Scanned PDFs get "Scan text", which recognises the words on this device with [tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0, vendored in `vendor/tesseract`). The text syncs, so other devices can search without downloading the PDF.
