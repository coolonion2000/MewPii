import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../api';
import { fetchModels, type ModelsResponse } from '../api';
import { t } from '../i18n';
import { IconPlus, IconArrowUp, IconStop, IconThink, IconChevronDown } from '../icons';

interface Props {
  conv: Conversation;
  draft?: string;
  onDraft?: (d: string | undefined) => void;
}

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface PendingImage {
  data: string;
  mimeType: string;
  name: string;
}

export default function Composer({ conv, draft, onDraft }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [models, setModels] = useState<ModelsResponse | undefined>();
  const [menuOpen, setMenuOpen] = useState<'model' | 'thinking' | undefined>();
  const [queueMode, setQueueMode] = useState<'steer' | 'followUp'>('steer');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchModels().then(setModels).catch(() => undefined);
  }, []);

  // external draft injection (e.g. editing a queued message)
  useEffect(() => {
    if (draft !== undefined) {
      setText(draft);
      onDraft?.(undefined);
      taRef.current?.focus();
      requestAnimationFrame(autoResize);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(undefined);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

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
        streamingBehavior: streaming ? queueMode : undefined,
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
  const isReasoning = currentModelInfo?.reasoning ?? false;
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

      {/* bottom bar: + attach | queue mode … model chip · thinking · spinner · send circle */}
      <div className="composer-bar">
        {supportsImage && (
          <>
            <button className="round-btn" title={t('attachImage')} onClick={() => imgInputRef.current?.click()}>
<IconPlus size={16} />
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

        {streaming && (
          <div className="queue-mode">
            <button
              className={`qm-btn ${queueMode === 'steer' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setQueueMode('steer');
              }}
            >
              {t('sendSteer')}
            </button>
            <button
              className={`qm-btn ${queueMode === 'followUp' ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setQueueMode('followUp');
              }}
            >
              {t('sendFollowUp')}
            </button>
          </div>
        )}

        <span style={{ flex: 1 }} />

        {/* model + thinking combined chip, pi-web style */}
        <div className="menu-anchor">
          <button
            className="model-chip"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(menuOpen === 'model' ? undefined : 'model');
            }}
          >
            <span className="model-chip-name">{currentModel ? currentModel.name : t('selectModel')}</span>
            {currentModel && isReasoning && (
              <span className="model-chip-qualifier">{snap?.thinkingLevel ?? 'off'}</span>
            )}
<IconChevronDown size={12} />
          </button>
          {menuOpen === 'model' && (
            <div className="menu" onClick={(e) => e.stopPropagation()}>
              {configuredModels.map((m) => (
                <button
                  key={`${m.provider}/${m.id}`}
                  className={`menu-item ${currentModel?.provider === m.provider && currentModel.id === m.id ? 'active' : ''}`}
                  onClick={() => {
                    setMenuOpen(undefined);
                    void conv.send({ type: 'setModel', provider: m.provider, modelId: m.id }).catch(() => undefined);
                  }}
                >
                  <span>{m.name}</span>
                  <span className="dim">{m.provider}</span>
                </button>
              ))}
              {configuredModels.length === 0 && (
                <div style={{ padding: 10, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{t('noConfiguredModels')}</div>
              )}
            </div>
          )}
        </div>

        {isReasoning && (
          <div className="menu-anchor">
            <button
              className="model-chip"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(menuOpen === 'thinking' ? undefined : 'thinking');
              }}
            >
<IconThink size={14} />
              <span className="model-chip-qualifier">{snap?.thinkingLevel ?? 'off'}</span>
<IconChevronDown size={11} />
            </button>
            {menuOpen === 'thinking' && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                {THINKING_LEVELS.map((level) => (
                  <button
                    key={level}
                    className={`menu-item ${snap?.thinkingLevel === level ? 'active' : ''}`}
                    onClick={() => {
                      setMenuOpen(undefined);
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

        {streaming && <span className="composer-spinner" />}

        {streaming ? (
          <button
            className="send-circle stop"
            title={t('abort')}
            onClick={() => void conv.send({ type: 'abort' }).catch(() => undefined)}
          >
            <IconStop size={13} />
          </button>
        ) : (
          <button className="send-circle" title={t('send')} disabled={!canSend} onClick={() => void submit()}>
<IconArrowUp size={17} />
          </button>
        )}
      </div>
    </div>
  );
}
