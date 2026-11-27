import type { AttachmentCategory } from './attachments.ts';

export function AttachmentIcon({ category }: { category: AttachmentCategory }) {
  switch (category) {
    case 'image':
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="1.8" />
          <circle cx="5.75" cy="6" r="1.1" fill="currentColor" stroke="none" />
          <path d="M2.5 11.5l3.2-3.1 2.4 2.2 2-1.8 3.4 2.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'video':
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <rect x="1.8" y="3" width="12.4" height="10" rx="1.8" />
          <path d="M6.6 5.8l3.8 2.2-3.8 2.2z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'audio':
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M3 9.5v-3M5.5 11.5v-7M8 13V3M10.5 11v-6M13 9.5v-3" strokeLinecap="round" />
        </svg>
      );
    case 'markdown':
    case 'doc':
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M4 2h5.2L12.5 5.3V14H4z" strokeLinejoin="round" />
          <path d="M9 2v3.5h3.5M6 8.3h4M6 10.8h2.8" strokeLinecap="round" />
        </svg>
      );
    case 'code':
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M5.5 4.8L2.3 8l3.2 3.2M10.5 4.8L13.7 8l-3.2 3.2M8.9 3.6L7.1 12.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M4 2h5.2L12.5 5.3V14H4z" strokeLinejoin="round" />
          <path d="M9 2v3.5h3.5" strokeLinecap="round" />
        </svg>
      );
  }
}
