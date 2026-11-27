import { useCallback, useEffect, useRef } from 'react';
import type { StreamAttachment } from '../streamDrafts.ts';

const keyOf = (a: Pick<StreamAttachment, 'kind' | 'value'>) => `${a.kind}:${a.value}`;

// Object-URL thumbnails for freshly attached images. URLs are revoked when their chip goes away and on unmount.
export function useAttachmentThumbs(attachments: StreamAttachment[]) {
  const mapRef = useRef<Map<string, string>>(new Map());

  const register = useCallback((att: Pick<StreamAttachment, 'kind' | 'value'>, file: Blob) => {
    const key = keyOf(att);
    const old = mapRef.current.get(key);
    if (old) URL.revokeObjectURL(old);
    mapRef.current.set(key, URL.createObjectURL(file));
  }, []);

  useEffect(() => {
    const live = new Set(attachments.map(keyOf));
    for (const [key, url] of mapRef.current) {
      if (live.has(key)) continue;
      URL.revokeObjectURL(url);
      mapRef.current.delete(key);
    }
  }, [attachments]);

  useEffect(() => {
    const map = mapRef.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  const thumbFor = (att: StreamAttachment): string | undefined => mapRef.current.get(keyOf(att));
  return { register, thumbFor };
}
