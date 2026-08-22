import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../api';
import { fetchModels, type ModelsResponse } from '../api';
import { t } from '../i18n';

interface Props {
  conv: Conversation;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface PendingImage {
  data: string;
  mimeType: string;
  name: string;
}

export default function Composer({ conv }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [models, setModels] = useState<ModelsResponse | undefined>();
  const [openMenu, setOpenMenu] = useState<'model' | 'thinking' | undefined>();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchModels().then(setModels).catch(() => undefined);
  }, []);

  const snap = conv.snapshot;
  const streaming = Boolean(snap?.isStreaming);
  const canSend = (text.trim().length > 0 || images.length > 0) && conv.connected;

  const autoResize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  };

  const submit = async () => {
    const value = text.trim();
    if (!canSend) return;
    const imgs = images;
    setText('');
    setImages([]);
    requestAnimationFrame(autoResize);
    try {
      await conv.send({
        type: 'prompt',
        message: value,
        images: imgs.length ? imgs.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
        streamingBehavior: streaming ? 'steer' : undefined,
      });
    } catch (err) {
      setText(value);
      setImages(imgs);
      conv.lastError = err instanceof Error ? err.message : String(err);
    }
  };

  const addImages = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        setImages((prev) => [...prev, { data: base64, mimeType: file.type, name: file.name }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const currentModel = snap?.model;
  const currentModelInfo = models?.models.find(
    (m) => m.provider === currentModel?.provider && m.id === currentModel?.id,
  );
  const supportsImage = currentModelInfo?.input.includes('image') ?? true;
  const configuredModels = models?.models.filter((m) => m.hasAuth) ?? [];

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="image-strip">
          {images.map((img, i) => (
            <div key={i} className="image-thumb">
              <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} />
              <button
                className="image-remove"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        placeholder={streaming ? t('steerPlaceholder') : t('sendPlaceholder')}
        onChange={(e) => {
          setText(e.target.value);
          autoResize();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        onPaste={(e) => {
          const files = e.clipboardData?.files;
          if (files && files.length > 0) {
            e.preventDefault();
            addImages(files);
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="menu-anchor">
          <button className="chip" onClick={() => setOpenMenu(openMenu === 'model' ? undefined : 'model')}>
            <span className="chip-label">{currentModel ? currentModel.name : t('selectModel')}</span>
            <span style={{ fontSize: 9 }}>▾</span>
          </button>
          {openMenu === 'model' && (
            <div className="menu">
              {configuredModels.length === 0 && (
                <div style={{ padding: 10, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                  {t('noConfiguredModels')}
                </div>
              )}
              {configuredModels.map((m) => (
                <button
                  key={`${m.provider}/${m.id}`}
                  className={`menu-item ${currentModel?.provider === m.provider && currentModel.id === m.id ? 'active' : ''}`}
                  onClick={() => {
                    setOpenMenu(undefined);
                    void conv.send({ type: 'setModel', provider: m.provider, modelId: m.id }).catch(() => undefined);
                  }}
                >
                  <span>{m.name}</span>
                  <span className="dim">{m.provider}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {currentModel && models?.models.find((m) => m.provider === currentModel.provider && m.id === currentModel.id)?.reasoning && (
          <div className="menu-anchor">
            <button className="chip" onClick={() => setOpenMenu(openMenu === 'thinking' ? undefined : 'thinking')}>
              <span className="chip-label">{t('thinking')}: {snap?.thinkingLevel ?? 'off'}</span>
              <span style={{ fontSize: 9 }}>▾</span>
            </button>
            {openMenu === 'thinking' && (
              <div className="menu">
                {THINKING_LEVELS.map((level) => (
                  <button
                    key={level}
                    className={`menu-item ${snap?.thinkingLevel === level ? 'active' : ''}`}
                    onClick={() => {
                      setOpenMenu(undefined);
                      void conv.send({ type: 'setThinkingLevel', level }).catch(() => undefined);
                    }}
                  >
                    {level}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="spacer" />
        {supportsImage && (
          <>
            <button className="btn btn-icon" title={t('attachImage')} onClick={() => imgInputRef.current?.click()}>
              ⧉
            </button>
            <input
              ref={imgInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                addImages(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
        {streaming ? (
          <button
            className="send-btn stop"
            title={t('abort')}
            onClick={() => void conv.send({ type: 'abort' }).catch(() => undefined)}
          >
            ■
          </button>
        ) : (
          <button className="send-btn" title={t('send')} disabled={!canSend} onClick={() => void submit()}>
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
