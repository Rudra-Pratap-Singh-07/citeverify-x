import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('public', { recursive: true });
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.js', 'public/pdf.worker.min.js');
