/**
 * useAuthedImage — load an authorized backend media resource (check-in photo
 * original / thumbnail) as an <img>-able blob URL. <img> tags cannot send
 * the Bearer header (api-contract A.3 media endpoints require it), so the
 * bytes arrive via fetch and display through an object URL, revoked on
 * cleanup. The result is keyed to (token, path): a stale response can never
 * leak into a newer view, and switching the key reads as loading again.
 */

import { useEffect, useState } from "react";
import { fetchMedia } from "./socialApi";

interface Snapshot {
  key: string;
  src: string | null;
  error: string | null;
}

interface AuthedImage {
  src: string | null;
  loading: boolean;
  error: string | null;
}

export function useAuthedImage(token: string | null, path: string | null): AuthedImage {
  const key = token !== null && path !== null ? `${token}:${path}` : null;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (key === null || token === null || path === null) return undefined;
    let active = true;
    let objectUrl: string | null = null;
    fetchMedia(token, path).then(
      ({ blobUrl }) => {
        if (!active) {
          URL.revokeObjectURL(blobUrl);
          return;
        }
        objectUrl = blobUrl;
        setSnapshot({ key, src: blobUrl, error: null });
      },
      (err: unknown) => {
        if (active) {
          setSnapshot({
            key,
            src: null,
            error: err instanceof Error ? err.message : "Could not load the image.",
          });
        }
      },
    );
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, token, path]);

  const current = key !== null && snapshot !== null && snapshot.key === key ? snapshot : null;
  return {
    src: current?.src ?? null,
    loading: key !== null && current === null,
    error: current?.error ?? null,
  };
}
