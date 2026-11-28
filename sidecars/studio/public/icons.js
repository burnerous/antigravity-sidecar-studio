(function (global) {
  'use strict';

  const SQUIRCLE_ICONS = new Set([
    'nav-produced',
    'hero-workspace',
    'dir',
    'dir-open',
    'docx',
    'xlsx',
    'pptx',
    'pdf',
    'markdown',
    'code-py',
    'code-html',
    'code-json',
    'code',
    'image',
    'video',
    'other',
  ]);

  const SPRITE_MARKUP = `
    <defs>
      <linearGradient id="wsg-amber" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFD166"/>
        <stop offset="100%" stop-color="#F57C00"/>
      </linearGradient>
      <linearGradient id="wsg-hero" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#38BDF8"/>
        <stop offset="52%" stop-color="#3B82F6"/>
        <stop offset="100%" stop-color="#1D4ED8"/>
      </linearGradient>
      <linearGradient id="wsg-folder-back" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38BDF8"/>
        <stop offset="100%" stop-color="#0284C7"/>
      </linearGradient>
      <linearGradient id="wsg-folder-front" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7DD3FC"/>
        <stop offset="100%" stop-color="#0A84FF"/>
      </linearGradient>
      <linearGradient id="wsg-folder-open" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#BAE6FD"/>
        <stop offset="100%" stop-color="#0EA5E9"/>
      </linearGradient>
      <linearGradient id="wsg-docx" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#60A5FA"/>
        <stop offset="100%" stop-color="#1D4ED8"/>
      </linearGradient>
      <linearGradient id="wsg-xlsx" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#4ADE80"/>
        <stop offset="100%" stop-color="#059669"/>
      </linearGradient>
      <linearGradient id="wsg-pptx" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFB347"/>
        <stop offset="100%" stop-color="#EA580C"/>
      </linearGradient>
      <linearGradient id="wsg-pdf" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FF6B6B"/>
        <stop offset="100%" stop-color="#DC2626"/>
      </linearGradient>
      <linearGradient id="wsg-notes-bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFFFFF"/>
        <stop offset="100%" stop-color="#E2E8F0"/>
      </linearGradient>
      <linearGradient id="wsg-notes-top" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FCD34D"/>
        <stop offset="100%" stop-color="#F59E0B"/>
      </linearGradient>
      <linearGradient id="wsg-py" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3B82F6"/>
        <stop offset="100%" stop-color="#1E3A8A"/>
      </linearGradient>
      <linearGradient id="wsg-html" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38BDF8"/>
        <stop offset="100%" stop-color="#0369A1"/>
      </linearGradient>
      <linearGradient id="wsg-json" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#818CF8"/>
        <stop offset="100%" stop-color="#4338CA"/>
      </linearGradient>
      <linearGradient id="wsg-code" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#475569"/>
        <stop offset="100%" stop-color="#0F172A"/>
      </linearGradient>
      <linearGradient id="wsg-image" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#A78BFA"/>
        <stop offset="100%" stop-color="#4F46E5"/>
      </linearGradient>
      <linearGradient id="wsg-video" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FB7185"/>
        <stop offset="100%" stop-color="#E11D48"/>
      </linearGradient>
      <linearGradient id="wsg-other" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#94A3B8"/>
        <stop offset="100%" stop-color="#475569"/>
      </linearGradient>
    </defs>

    <!-- Navigation & Header Icons -->
    <symbol id="wsi-nav-workbench" viewBox="0 0 24 24">
      <rect x="2.75" y="4" width="18.5" height="16" rx="3.5" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.65"/>
      <line x1="8.75" y1="4.2" x2="8.75" y2="19.8" stroke="currentColor" stroke-width="1.5"/>
      <line x1="5" y1="8.5" x2="6.7" y2="8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="5" y1="12" x2="6.7" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="11.5" y1="9" x2="18.2" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="11.5" y1="12.8" x2="16.4" y2="12.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-nav-trajectory" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9.2" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.65"/>
      <polygon points="15.7,8.3 13.4,13.4 8.3,15.7 10.6,10.6" fill="currentColor"/>
      <circle cx="12" cy="12" r="1.15" fill="var(--ws-bg, #0f1117)"/>
    </symbol>

    <symbol id="wsi-nav-produced" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-amber)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.34)" stroke-width="0.75"/>
      <path d="M12 5.4l1.45 4.1 4.1 1.45-4.1 1.45L12 16.5l-1.45-4.1-4.1-1.45 4.1-1.45z" fill="#FFFFFF"/>
      <circle cx="17.2" cy="6.9" r="1.05" fill="#FFFBEB"/>
    </symbol>

    <symbol id="wsi-hero-workspace" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-hero)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.36)" stroke-width="0.75"/>
      <rect x="5" y="6" width="5.2" height="12" rx="1.6" fill="rgba(255,255,255,0.28)"/>
      <rect x="11.5" y="6" width="7.5" height="12" rx="1.8" fill="#FFFFFF"/>
      <rect x="13" y="8.4" width="4.5" height="1.3" rx="0.65" fill="#2563EB"/>
      <rect x="13" y="11" width="3.8" height="1.1" rx="0.55" fill="#94A3B8"/>
      <rect x="13" y="13.4" width="4.5" height="2.6" rx="0.8" fill="#DBEAFE"/>
    </symbol>

    <!-- macOS / iOS Files Folders -->
    <symbol id="wsi-dir" viewBox="0 0 24 24">
      <path d="M2.2 6.6C2.2 5.27 3.27 4.2 4.6 4.2h4.15c.68 0 1.32.3 1.76.82l1.02 1.22h7.87c1.33 0 2.4 1.07 2.4 2.4v8.76c0 1.44-1.16 2.6-2.6 2.6H4.8c-1.44 0-2.6-1.16-2.6-2.6V6.6z" fill="url(#wsg-folder-back)"/>
      <rect x="2.2" y="8.1" width="19.6" height="11.7" rx="2.5" fill="url(#wsg-folder-front)"/>
      <line x1="3.4" y1="8.7" x2="20.6" y2="8.7" stroke="rgba(255,255,255,0.42)" stroke-width="0.75" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-dir-open" viewBox="0 0 24 24">
      <path d="M2.2 6.4C2.2 5.1 3.25 4.05 4.55 4.05h4.1c.66 0 1.29.29 1.72.8l.95 1.15h7.9c1.3 0 2.35 1.05 2.35 2.35v8.85c0 1.38-1.12 2.5-2.5 2.5H4.7c-1.38 0-2.5-1.12-2.5-2.5V6.4z" fill="url(#wsg-folder-back)"/>
      <path d="M2.7 10.6c.16-.95.98-1.65 1.95-1.65h14.7c.97 0 1.79.7 1.95 1.65l.92 5.8c.2 1.24-.76 2.35-2.01 2.35H3.79c-1.25 0-2.21-1.11-2.01-2.35l.92-5.8z" fill="url(#wsg-folder-open)"/>
      <line x1="4.4" y1="9.6" x2="19.6" y2="9.6" stroke="rgba(255,255,255,0.52)" stroke-width="0.75" stroke-linecap="round"/>
    </symbol>

    <!-- iOS Document & File Squircle Icons -->
    <symbol id="wsi-docx" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-docx)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <path d="M7.2 5.5h6.5l3.6 3.6v9.4a1.2 1.2 0 0 1-1.2 1.2H7.2A1.2 1.2 0 0 1 6 18.5V6.7a1.2 1.2 0 0 1 1.2-1.2z" fill="#FFFFFF"/>
      <path d="M13.7 5.5v2.7a.9.9 0 0 0 .9.9h2.7z" fill="#BFDBFE"/>
      <rect x="8.2" y="10.8" width="7" height="1.35" rx="0.68" fill="#2563EB"/>
      <rect x="8.2" y="13.4" width="7" height="1.35" rx="0.68" fill="#60A5FA"/>
      <rect x="8.2" y="16" width="4.8" height="1.35" rx="0.68" fill="#93C5FD"/>
    </symbol>

    <symbol id="wsi-xlsx" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-xlsx)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <rect x="6" y="13.2" width="3.1" height="5.2" rx="1" fill="#FFFFFF" fill-opacity="0.82"/>
      <rect x="10.45" y="9.2" width="3.1" height="9.2" rx="1" fill="#FFFFFF" fill-opacity="0.92"/>
      <rect x="14.9" y="5.8" width="3.1" height="12.6" rx="1" fill="#FFFFFF"/>
    </symbol>

    <symbol id="wsi-pptx" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-pptx)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <rect x="5.4" y="6.2" width="13.2" height="8.8" rx="1.6" fill="#FFFFFF"/>
      <rect x="7.4" y="8.4" width="5.2" height="1.4" rx="0.7" fill="#EA580C"/>
      <rect x="7.4" y="11.1" width="9.2" height="1.3" rx="0.65" fill="#FDBA74"/>
      <path d="M12 15v3.2M9.2 18.4h5.6" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-pdf" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-pdf)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <path d="M7.2 5.4h6.4l3.6 3.6v9.5a1.2 1.2 0 0 1-1.2 1.2H7.2A1.2 1.2 0 0 1 6 18.5V6.6a1.2 1.2 0 0 1 1.2-1.2z" fill="#FFFFFF"/>
      <path d="M13.6 5.4v2.7a.9.9 0 0 0 .9.9h2.7z" fill="#FECACA"/>
      <path d="M8.6 15.8c1.1-2.5 2.4-4.7 3.2-4.7.9 0 .9 2.6 2.8 3.6-1.4.4-4.2.9-6 1.1z" fill="none" stroke="#DC2626" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>

    <symbol id="wsi-markdown" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-notes-bg)"/>
      <path d="M1.5 7C1.5 3.96 3.96 1.5 7 1.5h10c3.04 0 5.5 2.46 5.5 5.5v1.2h-21V7z" fill="url(#wsg-notes-top)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(15,23,42,0.12)" stroke-width="0.75"/>
      <line x1="5.2" y1="11.6" x2="18.8" y2="11.6" stroke="#94A3B8" stroke-width="1.3" stroke-linecap="round"/>
      <line x1="5.2" y1="14.8" x2="18.8" y2="14.8" stroke="#94A3B8" stroke-width="1.3" stroke-linecap="round"/>
      <line x1="5.2" y1="18" x2="14.2" y2="18" stroke="#CBD5E1" stroke-width="1.3" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-code-py" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-py)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <path d="M11.9 5.6c-2.5 0-2.9 1.1-2.9 2.3v1.6h4.2v.6H7.6c-1.4 0-2.4 1-2.4 2.8 0 1.9.9 2.9 2.4 2.9h1.2v-1.7c0-1.4 1.1-2.5 2.5-2.5h3.2c1.1 0 1.9-.9 1.9-2V7.9c0-1.3-.9-2.3-4.5-2.3zm-1.6 1.2a.65.65 0 1 1 0 1.3.65.65 0 0 1 0-1.3z" fill="#FFFFFF"/>
      <path d="M12.1 18.4c2.5 0 2.9-1.1 2.9-2.3v-1.6h-4.2v-.6h5.6c1.4 0 2.4-1 2.4-2.8 0-1.9-.9-2.9-2.4-2.9h-1.2v1.7c0 1.4-1.1 2.5-2.5 2.5H9.5c-1.1 0-1.9.9-1.9 2v1.7c0 1.3.9 2.3 4.5 2.3zm1.6-1.2a.65.65 0 1 1 0-1.3.65.65 0 0 1 0 1.3z" fill="#FDE047"/>
    </symbol>

    <symbol id="wsi-code-html" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-html)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <circle cx="12" cy="12" r="6" fill="none" stroke="#FFFFFF" stroke-width="1.4"/>
      <ellipse cx="12" cy="12" rx="2.8" ry="6" fill="none" stroke="#FFFFFF" stroke-width="1.2"/>
      <line x1="6.3" y1="12" x2="17.7" y2="12" stroke="#FFFFFF" stroke-width="1.2"/>
    </symbol>

    <symbol id="wsi-code-json" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-json)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <path d="M9.6 6.8c-1.1 0-1.6.6-1.6 1.7v1.7c0 .8-.4 1.3-1.2 1.8.8.5 1.2 1 1.2 1.8v1.7c0 1.1.5 1.7 1.6 1.7" fill="none" stroke="#FFFFFF" stroke-width="1.65" stroke-linecap="round"/>
      <path d="M14.4 6.8c1.1 0 1.6.6 1.6 1.7v1.7c0 .8.4 1.3 1.2 1.8-.8.5-1.2 1-1.2 1.8v1.7c0 1.1-.5 1.7-1.6 1.7" fill="none" stroke="#FFFFFF" stroke-width="1.65" stroke-linecap="round"/>
      <circle cx="12" cy="12" r="1.2" fill="#E0E7FF"/>
    </symbol>

    <symbol id="wsi-code" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-code)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.26)" stroke-width="0.75"/>
      <path d="M6.8 8.7l3.4 3.3-3.4 3.3" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="12.2" y1="15.3" x2="17.2" y2="15.3" stroke="#93C5FD" stroke-width="1.8" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-image" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-image)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <circle cx="8.6" cy="8.7" r="1.8" fill="#FDE68A"/>
      <path d="M5.4 17.4l4.1-4.6 2.9 3 2.3-2.3 3.9 3.9z" fill="#FFFFFF" fill-opacity="0.95"/>
    </symbol>

    <symbol id="wsi-video" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-video)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <path d="M9 7.4c0-.77.84-1.25 1.5-.86l6.4 4.6c.6.4.6 1.32 0 1.72l-6.4 4.6c-.66.39-1.5-.09-1.5-.86V7.4z" fill="#FFFFFF"/>
    </symbol>

    <symbol id="wsi-other" viewBox="0 0 24 24">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="url(#wsg-other)"/>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.75"/>
      <path d="M7.5 5.6h6l3.3 3.3v9.5a1.1 1.1 0 0 1-1.1 1.1H7.5a1.1 1.1 0 0 1-1.1-1.1V6.7a1.1 1.1 0 0 1 1.1-1.1z" fill="#FFFFFF"/>
      <path d="M13.5 5.6v2.5a.8.8 0 0 0 .8.8h2.5z" fill="#CBD5E1"/>
    </symbol>

    <!-- SF Symbols Style Linear UI Icons -->
    <symbol id="wsi-ui-search" viewBox="0 0 24 24">
      <circle cx="10.6" cy="10.6" r="6.2" fill="none" stroke="currentColor" stroke-width="1.9"/>
      <line x1="15.2" y1="15.2" x2="20" y2="20" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-ui-eye" viewBox="0 0 24 24">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/>
    </symbol>

    <symbol id="wsi-ui-quote" viewBox="0 0 24 24">
      <path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16H9.8l-4.2 3.4c-.5.4-1.1.04-1.1-.6V6.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <line x1="8.2" y1="8.8" x2="15.8" y2="8.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="8.2" y1="11.8" x2="13.2" y2="11.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-ui-note" viewBox="0 0 24 24">
      <rect x="4.5" y="3.5" width="15" height="17" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <line x1="8" y1="8.5" x2="16" y2="8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <line x1="8" y1="12.2" x2="16" y2="12.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <line x1="8" y1="15.9" x2="12.5" y2="15.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-ui-send" viewBox="0 0 24 24">
      <path d="M20.5 4.2L3.8 10.7c-.8.3-.75 1.4.08 1.65l6.1 1.85 1.85 6.1c.25.83 1.35.88 1.65.08l6.5-16.7c.25-.64-.38-1.27-1.02-1.02z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>
      <line x1="10" y1="14.2" x2="19.6" y2="4.6" stroke="currentColor" stroke-width="1.65" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-ui-copy" viewBox="0 0 24 24">
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path d="M15.5 8.5V6.2A2.2 2.2 0 0 0 13.3 4H6.2A2.2 2.2 0 0 0 4 6.2v7.1a2.2 2.2 0 0 0 2.2 2.2h2.3" fill="none" stroke="currentColor" stroke-width="1.8"/>
    </symbol>

    <symbol id="wsi-ui-external" viewBox="0 0 24 24">
      <path d="M10.5 5.5H6.2A2.2 2.2 0 0 0 4 7.7v10.1A2.2 2.2 0 0 0 6.2 20h10.1a2.2 2.2 0 0 0 2.2-2.2v-4.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M14 4h6v6M20 4l-9.2 9.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>

    <symbol id="wsi-ui-list" viewBox="0 0 24 24">
      <line x1="8" y1="6.5" x2="19.5" y2="6.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="8" y1="12" x2="19.5" y2="12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="8" y1="17.5" x2="19.5" y2="17.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="4.6" cy="6.5" r="1.2" fill="currentColor"/>
      <circle cx="4.6" cy="12" r="1.2" fill="currentColor"/>
      <circle cx="4.6" cy="17.5" r="1.2" fill="currentColor"/>
    </symbol>

    <symbol id="wsi-ui-bolt" viewBox="0 0 24 24">
      <path d="M13.2 2.8L5.6 13.2h5.8l-1.1 8 8.1-10.7h-5.8z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    </symbol>

    <symbol id="wsi-ui-warn" viewBox="0 0 24 24">
      <path d="M10.4 4.3a1.85 1.85 0 0 1 3.2 0l7.4 12.8a1.85 1.85 0 0 1-1.6 2.78H4.6a1.85 1.85 0 0 1-1.6-2.78z" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>
      <line x1="12" y1="9.2" x2="12" y2="13.8" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>
      <circle cx="12" cy="16.6" r="1.05" fill="currentColor"/>
    </symbol>

    <symbol id="wsi-ui-expand" viewBox="0 0 24 24">
      <path d="M4.5 5.5c0-1.1.9-2 2-2H12v17H6.5a2 2 0 0 1-2-2V5.5zM19.5 5.5c0-1.1-.9-2-2-2H12v17h5.5a2 2 0 0 0 2-2V5.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>
    </symbol>

    <symbol id="wsi-ui-user" viewBox="0 0 24 24">
      <circle cx="12" cy="8.2" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path d="M5.2 19.6a6.8 6.8 0 0 1 13.6 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-ui-bot" viewBox="0 0 24 24">
      <rect x="4.2" y="6.8" width="15.6" height="12.2" rx="3.4" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <line x1="12" y1="3.4" x2="12" y2="6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <circle cx="9.2" cy="12.5" r="1.2" fill="currentColor"/>
      <circle cx="14.8" cy="12.5" r="1.2" fill="currentColor"/>
      <line x1="9.5" y1="15.8" x2="14.5" y2="15.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-ui-error" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.8" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </symbol>

    <symbol id="wsi-ui-tool" viewBox="0 0 24 24">
      <path d="M14.7 6.3a4.6 4.6 0 0 0-5.8 5.8l-4.6 4.6a1.7 1.7 0 0 0 2.4 2.4l4.6-4.6a4.6 4.6 0 0 0 5.8-5.8l-2.3 2.3-2.4-2.4z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>
    </symbol>

    <symbol id="wsi-ui-thinking" viewBox="0 0 24 24">
      <circle cx="12" cy="11.5" r="7.5" fill="none" stroke="currentColor" stroke-width="1.75"/>
      <path d="M9.5 11.2a2.5 2.5 0 0 1 5 0c0 1.4-1.5 2-2.5 2.7v1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <circle cx="12" cy="16.8" r="0.9" fill="currentColor"/>
    </symbol>

    <symbol id="wsi-ui-inbox" viewBox="0 0 24 24">
      <path d="M4.2 13.5l2.2-7A1.8 1.8 0 0 1 8.1 5.2h7.8a1.8 1.8 0 0 1 1.7 1.3l2.2 7v4a1.8 1.8 0 0 1-1.8 1.8H6a1.8 1.8 0 0 1-1.8-1.8z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>
      <path d="M4.2 13.5h4.3l1.3 2h4.4l1.3-2h4.3" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/>
    </symbol>

    <symbol id="wsi-ui-gear" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path d="M12 3.8v2M12 18.2v2M3.8 12h2M18.2 12h2M6.2 6.2l1.4 1.4M16.4 16.4l1.4 1.4M17.8 6.2l-1.4 1.4M7.6 16.4l-1.4 1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </symbol>
    <symbol id="wsi-ui-close" viewBox="0 0 24 24">
      <path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
    </symbol>
    <symbol id="wsi-ui-edit" viewBox="0 0 24 24">
      <path d="M11.5 4.8H6.4a2.2 2.2 0 0 0-2.2 2.2v10.6a2.2 2.2 0 0 0 2.2 2.2H17a2.2 2.2 0 0 0 2.2-2.2v-5.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M18.3 3.9a2.1 2.1 0 0 1 3 3L12.6 15.6l-3.8.9.9-3.8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>
    <symbol id="wsi-ui-save" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path d="M8.6 12.2l2.3 2.3 4.7-4.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>
    <symbol id="wsi-ui-update" viewBox="0 0 24 24">
      <path d="M12 4.2v9.4" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round"/>
      <path d="M8.5 10.4L12 13.9l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5.2 15.2v2.4A2.2 2.2 0 0 0 7.4 19.8h9.2a2.2 2.2 0 0 0 2.2-2.2v-2.4" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>
    <symbol id="wsi-ui-appearance" viewBox="0 0 24 24">
      <path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12 12 3.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M12 3.5v17M3.5 12h17M7.8 7.8l8.4 8.4M16.2 7.8l-8.4 8.4" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/>
      <path d="M19.5 3.2v3.1M18 4.75h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </symbol>
    <symbol id="wsi-ui-check" viewBox="0 0 24 24">
      <path d="M5.5 12.5l4.2 4.2 8.8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </symbol>
  `;

  function ensureSprite() {
    if (!global.document) return;
    if (global.document.getElementById('ws-icon-sprite')) return;
    const host = global.document.body || global.document.documentElement;
    if (!host) return;
    const svg = global.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'ws-icon-sprite';
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText =
      'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;';
    svg.innerHTML = SPRITE_MARKUP;
    host.insertBefore(svg, host.firstChild);
  }

  function render(name, { size = 16, className = '' } = {}) {
    ensureSprite();
    const isSquircle = SQUIRCLE_ICONS.has(name);
    const cls = ['ws-svg-icon', isSquircle ? 'ws-ios-squircle' : '', className]
      .filter(Boolean)
      .join(' ');
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><use href="#wsi-${name}"></use></svg>`;
  }

  function fileIconName(item, { expanded = false } = {}) {
    if (!item) return 'other';
    if (item.isDir) return expanded ? 'dir-open' : 'dir';
    const ext = String(item.ext || '').toLowerCase();
    const cat = String(item.category || '').toLowerCase();
    if (cat === 'docx' || ext === '.docx' || ext === '.doc') return 'docx';
    if (cat === 'xlsx' || ext === '.xlsx' || ext === '.xls' || ext === '.csv') return 'xlsx';
    if (cat === 'pptx' || ext === '.pptx' || ext === '.ppt') return 'pptx';
    if (cat === 'pdf' || ext === '.pdf') return 'pdf';
    if (cat === 'markdown' || ext === '.md' || ext === '.mdx' || ext === '.markdown') return 'markdown';
    if (cat === 'image') return 'image';
    if (cat === 'video' || ext === '.mp4') return 'video';
    if (ext === '.py') return 'code-py';
    if (ext === '.html' || ext === '.htm') return 'code-html';
    if (ext === '.json' || ext === '.jsonl' || ext === '.yaml' || ext === '.yml' || ext === '.toml') {
      return 'code-json';
    }
    if (cat === 'code') return 'code';
    return 'other';
  }

  function renderFile(item, { size = 17, expanded = false, className = '' } = {}) {
    return render(fileIconName(item, { expanded }), { size, className });
  }

  function hydrate(root = global.document) {
    ensureSprite();
    if (!root) return;
    for (const el of root.querySelectorAll('[data-ws-icon]')) {
      const name = el.getAttribute('data-ws-icon');
      const size = Number(el.getAttribute('data-size') || 16);
      if (name) {
        el.innerHTML = render(name, { size });
      }
    }
  }

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', () => hydrate(global.document));
    } else {
      ensureSprite();
    }
  }

  global.WSIcons = {
    ensureSprite,
    render,
    fileIconName,
    renderFile,
    hydrate,
  };
})(window);
