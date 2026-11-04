/**
 * ProfileEditor — the social profile card on the personal homepage
 * (api-contract A.2): nickname (1–32 chars, no HTML) and avatar
 * (png/jpg/webp ≤ 2 MB, re-encoded server-side to 256×256 webp). Rendered
 * only when signed in; the sign-in gate itself lives in SocialSignInCard.
 */

import { useState } from "react";
import { useSocialAuth } from "../../social/useSocialAuth";
import { socialUrl } from "../../lib/socialApi";
import { shortAddress } from "../../lib/format";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export function ProfileEditor() {
  const social = useSocialAuth();
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The avatar URL is constant per address — bump the query to re-fetch
  // after a successful upload.
  const [avatarVersion, setAvatarVersion] = useState(0);

  if (!social.profile) return null;
  const { profile } = social;

  const startEdit = () => {
    setNickname(profile.nickname);
    setError(null);
    setEditing(true);
  };

  const saveNickname = async () => {
    const trimmed = nickname.trim();
    if (trimmed.length < 1 || trimmed.length > 32 || /[<>]/.test(trimmed)) {
      setError("Nickname must be 1–32 characters with no < or >.");
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await social.setNickname(trimmed);
    setBusy(false);
    if (ok) {
      setEditing(false);
    } else {
      setError(social.error ?? "Could not save the nickname.");
    }
  };

  const onAvatarFile = async (file: File | null) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Avatar must be a png, jpg, or webp image.");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError("Avatar image must be 2 MB or smaller.");
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await social.changeAvatar(file);
    setBusy(false);
    if (ok) {
      setAvatarVersion((v) => v + 1);
    } else {
      setError(social.error ?? "Could not upload the avatar.");
    }
  };

  return (
    <section className="card profile__identity">
      <img
        className="profile__avatar"
        src={`${socialUrl(profile.avatarUrl)}?v=${avatarVersion}`}
        alt="Profile avatar"
        width={72}
        height={72}
      />
      <div className="profile__identity-main">
        {editing ? (
          <div className="profile__nickname-edit">
            <input
              type="text"
              value={nickname}
              maxLength={32}
              aria-label="Nickname"
              onChange={(e) => setNickname(e.target.value)}
            />
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void saveNickname()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <h2>
            {profile.nickname} <span className="muted mono">{shortAddress(profile.address)}</span>
          </h2>
        )}
        <div className="profile__identity-actions">
          {!editing ? (
            <button type="button" className="button button--ghost" onClick={startEdit}>
              Edit nickname
            </button>
          ) : null}
          <label className="button button--ghost profile__avatar-upload">
            {busy ? "Uploading…" : "Change avatar"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              disabled={busy}
              onChange={(e) => void onAvatarFile(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
