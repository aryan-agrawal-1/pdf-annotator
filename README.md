# PDF Annotation

A small local desktop app for opening a PDF, highlighting selected text, and jumping back to saved highlights.

## Development

```sh
npm install
npm run dev:web
```

The web build uses IndexedDB for local document and highlight storage.

## Desktop App

This project is configured for Tauri.

```sh
npm run dev
npm run build
```

Tauri requires Rust/Cargo to be installed on the machine before desktop builds can run.
