// pdf.js's worker, behind the same Map methods the page has (see polyfill.js). Modules run in the order they are imported.
import './polyfill.js';
import '/vendor/pdfjs/build/pdf.worker.min.mjs';
